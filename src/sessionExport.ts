/**
 * sessionExport.ts
 * -----------------------------------------------------------------------------
 * The per-session export (schema `token-coach.session/0.1`): one JSON + one
 * Markdown file per Copilot debug session, plus CSV tables across sessions.
 *
 * Built for analysis, not for the dashboard, so it follows three rules:
 *   • Raw first. Numbers are copied from the log line as emitted, under the
 *     log's own field names, before anything is computed from them.
 *   • Every field says what it is: raw (copied), derived (computed from raw,
 *     deterministic), heuristic (a threshold or judgement) or unknown.
 *   • Missing is not zero. A field the log doesn't carry is "unknown", and a
 *     missing artifact is a coverage gap, never "nothing happened".
 *
 * This pass re-reads `main.jsonl` itself instead of going through the parser's
 * normalized records, so the raw layer can't be bent by normalization. Parsed
 * records are joined in only for the context breakdown and attachments.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LogFile, ParsedData, groupByChat } from './logParser';
import { CoachConfig } from './coach';
import { scoreMessages } from './efficiency';

const fsp = fs.promises;

export const EXPORT_SCHEMA = 'token-coach.session/0.1';
const UNKNOWN = 'unknown' as const;
type Unknown = typeof UNKNOWN;
/** The request carried its options, and this one wasn't among them. */
const NOT_SENT = 'not sent' as const;
type NotSent = typeof NOT_SENT;
const USD_PER_CREDIT = 0.01;
const NANO_PER_CREDIT = 1e9;

export const FIELD_KINDS = {
  raw: 'Copied from the Copilot log as emitted, under the log field name.',
  derived: 'Computed deterministically from raw fields. Formula given where not obvious.',
  heuristic: 'Depends on a Token Coach threshold or judgement (see thresholds). Not a fact.',
  unknown: 'The log or artifact does not carry this. Not the same as zero.',
  'not sent': 'The request options were logged and this setting was not among them.',
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RequestExport {
  index: number;
  /** raw: event time, ISO local. */
  at: string;
  /** raw: where to verify this row. */
  evidence: { file: string; line: number; spanId: string | Unknown };
  /** raw: `attrs.debugName` — what the call was for (panel/editAgent, title, …). */
  purpose: string | Unknown;
  model: string;
  status: string | Unknown;
  /** raw: every numeric attr on the log line, names untouched. */
  raw: Record<string, number>;
  /** raw: the reasoning / thinking settings sent with the request. */
  reasoning: {
    effort: string | Unknown | NotSent;
    thinkingBudgetTokens: number | Unknown | NotSent;
    summary: string | Unknown | NotSent;
  };
  derived: {
    credits: number | Unknown;
    usd: number | Unknown;
    /** Credits recomputed from the session's model catalog prices. */
    catalogCredits: number | Unknown;
    /** logged − catalog, in credits. */
    reconciliationDeltaCredits: number | Unknown;
    /** This request's prompt size (`inputTokens`). Never summed across requests. */
    promptTokens: number | Unknown;
    maxPromptTokens: number | Unknown;
    promptOccupancy: number | Unknown;
    /** Prompt above the model's regular context limit (billed as long context). */
    longContext: boolean | Unknown;
    /** Character counts by source; estimates, since the log measures chars. */
    contextSources: { source: string; chars: number }[] | Unknown;
    attachments: { path: string; chars: number }[] | Unknown;
  };
}

export interface ChildSessionExport {
  id: string;
  label: string | Unknown;
  file: string;
  requests: number;
  credits: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionExport {
  schema: string;
  generatedAt: string;
  tokenCoachVersion: string;
  fieldKinds: typeof FIELD_KINDS;
  session: {
    debugSessionId: string;
    workspaceStorageId: string;
    workspaceFolder: string | Unknown;
    /** derived: the VS Code chat file that mentions this debug session id. */
    vscodeChatSessionId: string | Unknown;
    title: string | Unknown;
    startedAt: string | Unknown;
    endedAt: string | Unknown;
  };
  versions: { vscode: string | Unknown; copilotChat: string | Unknown };
  coverage: {
    mainLog: { lines: number; events: number; unreadableLines: number; lastLineComplete: boolean };
    modelCatalog: boolean;
    systemPromptFiles: number;
    toolCatalogFiles: number;
    childLogs: number;
    vscodeChatFile: boolean;
    notInLogs: string[];
  };
  thresholds: Record<string, number>;
  pricing: { usdPerCredit: number; formula: string; catalogFormula: string; catalogFormulaVerifiedOn: string };
  totals: {
    userMessages: number;
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    credits: number;
    usd: number;
    catalogCredits: number | Unknown;
    reconciliationDeltaCredits: number | Unknown;
    peakPromptTokens: number;
    childSessionCredits: number;
  };
  /** heuristic: the Token Coach grade for this session alone. */
  cacheWaste: { score: number; idlePauseCredits: number; idlePauses: number; breakCredits: number; breaks: number };
  childSessions: ChildSessionExport[];
  requests: RequestExport[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PriceTier {
  inputPrice?: number;
  cachePrice?: number;
  cacheWritePrice?: number;
  outputPrice?: number;
  contextMax?: number;
}

interface CatalogEntry {
  batchSize?: number;
  regular: PriceTier;
  /** Prices once the prompt is above the regular tier's `context_max`. */
  long?: PriceTier;
  maxPromptTokens?: number;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function isoLocal(ts: number): string {
  if (!ts) {
    return UNKNOWN;
  }
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

async function loadCatalog(sessionDir: string): Promise<Map<string, CatalogEntry> | undefined> {
  const list = await readJson(path.join(sessionDir, 'models.json'));
  if (!Array.isArray(list)) {
    return undefined;
  }
  const map = new Map<string, CatalogEntry>();
  for (const m of list as any[]) {
    if (typeof m?.id !== 'string') {
      continue;
    }
    const tp = m.billing?.token_prices;
    const tier = (t: any): PriceTier => ({
      inputPrice: num(t?.input_price),
      cachePrice: num(t?.cache_price),
      cacheWritePrice: num(t?.cache_write_price),
      outputPrice: num(t?.output_price),
      contextMax: num(t?.context_max),
    });
    map.set(m.id, {
      batchSize: num(tp?.batch_size),
      regular: tier(tp?.default),
      long: tp?.long_context ? tier(tp.long_context) : undefined,
      maxPromptTokens: num(m.capabilities?.limits?.max_prompt_tokens),
    });
  }
  return map;
}

/**
 * Credits recomputed from the session's own price list, with two corrections
 * measured against the logged cost (2026-09-27, 282 requests, gap 0.025%):
 *   • The catalog rounds prices to whole units. A cache price within 1 unit of
 *     10% of the input price is that exact 10% (gpt-5-mini lists 2, bills 2.5).
 *   • Claude writes every new prompt token to the cache and bills the write at
 *     1.25× input. The catalog's `cache_write_price` is used when listed.
 */
function catalogCredits(model: string, c: CatalogEntry | undefined, input: number, cached: number, output: number): number | Unknown {
  if (!c || !c.batchSize) {
    return UNKNOWN;
  }
  const t = c.long && isLongContext(c, input) ? c.long : c.regular;
  if (t.inputPrice === undefined || t.outputPrice === undefined) {
    return UNKNOWN;
  }
  let cachePrice = t.cachePrice ?? t.inputPrice;
  if (Math.abs(cachePrice - t.inputPrice * 0.1) < 1) {
    cachePrice = t.inputPrice * 0.1;
  }
  // A listed write price of 0 means "no write surcharge", not "free input".
  const freshPrice =
    t.cacheWritePrice && t.cacheWritePrice > 0
      ? t.cacheWritePrice
      : /claude/i.test(model)
        ? t.inputPrice * 1.25
        : t.inputPrice;
  const fresh = Math.max(0, input - cached);
  return round((fresh * freshPrice + cached * cachePrice + output * t.outputPrice) / c.batchSize);
}

/** Prompt above the regular tier's limit, on a model that has a long-context tier. */
function isLongContext(c: CatalogEntry, input: number): boolean {
  return c.long !== undefined && c.regular.contextMax !== undefined && input > c.regular.contextMax;
}

/** Map each debug session id in a workspace to the VS Code chat file that mentions it. */
async function chatFileIndex(workspaceDir: string, debugIds: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const dir = path.join(workspaceDir, 'chatSessions');
  for (const name of await listDir(dir)) {
    let text: string;
    try {
      text = await fsp.readFile(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const id of debugIds) {
      if (!found.has(id) && text.includes(id)) {
        found.set(id, name.replace(/\.jsonl?$/, ''));
      }
    }
  }
  return found;
}

async function workspaceFolder(workspaceDir: string): Promise<string | Unknown> {
  const w = (await readJson(path.join(workspaceDir, 'workspace.json'))) as any;
  const f = w?.folder ?? w?.workspace;
  return typeof f === 'string' ? f : UNKNOWN;
}

async function readChildLog(sessionDir: string, file: string): Promise<Omit<ChildSessionExport, 'id' | 'label' | 'file'>> {
  const out = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 };
  let text = '';
  try {
    text = await fsp.readFile(path.join(sessionDir, file), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    try {
      const e = JSON.parse(line);
      if (e?.type === 'llm_request') {
        out.requests++;
        out.credits += (num(e.attrs?.copilotUsageNanoAiu) ?? 0) / NANO_PER_CREDIT;
        out.inputTokens += num(e.attrs?.inputTokens) ?? 0;
        out.outputTokens += num(e.attrs?.outputTokens) ?? 0;
      }
    } catch {
      // partial line
    }
  }
  out.credits = round(out.credits);
  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildSessionExports(
  files: LogFile[],
  data: ParsedData,
  config: CoachConfig,
  tokenCoachVersion: string,
  generatedAt = new Date()
): Promise<SessionExport[]> {
  // Parsed records, for the context breakdown and attachments only.
  const parsedByKey = new Map<string, (typeof data.requests)[number]>();
  for (const r of data.requests) {
    parsedByKey.set(`${r.sessionId}:${r.timestamp}:${r.inputTokens}`, r);
  }
  const chatsById = new Map(groupByChat(data).map((c) => [c.sessionId, c]));

  // One chat-file scan per workspace.
  const byWorkspace = new Map<string, LogFile[]>();
  for (const f of files) {
    const ws = path.resolve(path.dirname(f.filePath), '..', '..', '..');
    const list = byWorkspace.get(ws);
    list ? list.push(f) : byWorkspace.set(ws, [f]);
  }
  const chatIds = new Map<string, string>();
  const folders = new Map<string, string>();
  for (const [ws, list] of byWorkspace) {
    for (const [k, v] of await chatFileIndex(ws, list.map((f) => f.sessionId))) {
      chatIds.set(k, v);
    }
    folders.set(ws, await workspaceFolder(ws));
  }

  const thresholds: Record<string, number> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'number' && k !== 'usdPerAiu') {
      thresholds[k] = v;
    }
  }

  const out: SessionExport[] = [];
  for (const f of files) {
    const sessionDir = path.dirname(f.filePath);
    const ws = path.resolve(sessionDir, '..', '..', '..');
    let text = '';
    try {
      text = await fsp.readFile(f.filePath, 'utf8');
    } catch {
      continue;
    }
    const catalog = await loadCatalog(sessionDir);
    const sidecars = await listDir(sessionDir);
    const lines = text.split(/\r?\n/);
    const lastLineComplete = text.length === 0 || text.endsWith('\n');

    let events = 0;
    let unreadable = 0;
    let userMessages = 0;
    let vscode: string | Unknown = UNKNOWN;
    let copilot: string | Unknown = UNKNOWN;
    let firstTs = 0;
    let lastTs = 0;
    const children: { id: string; label: string | Unknown; file: string }[] = [];
    const requests: RequestExport[] = [];

    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) {
        return;
      }
      let e: any;
      try {
        e = JSON.parse(t);
      } catch {
        unreadable++;
        return;
      }
      events++;
      const ts = num(e.ts) ?? 0;
      if (ts) {
        firstTs = firstTs ? Math.min(firstTs, ts) : ts;
        lastTs = Math.max(lastTs, ts + (num(e.dur) ?? 0));
      }
      const a = e.attrs ?? {};
      if (e.type === 'session_start') {
        vscode = typeof a.vscodeVersion === 'string' ? a.vscodeVersion : vscode;
        copilot = typeof a.copilotVersion === 'string' ? a.copilotVersion : copilot;
      } else if (e.type === 'user_message') {
        userMessages++;
      } else if (e.type === 'child_session_ref' && typeof a.childSessionId === 'string') {
        children.push({
          id: a.childSessionId,
          label: typeof a.label === 'string' ? a.label : UNKNOWN,
          file: typeof a.childLogFile === 'string' ? a.childLogFile : '',
        });
      } else if (e.type === 'llm_request') {
        const raw: Record<string, number> = {};
        for (const [k, v] of Object.entries(a)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            raw[k] = v;
          }
        }
        let opts: any = a.requestOptions;
        if (typeof opts === 'string') {
          try {
            opts = JSON.parse(opts);
          } catch {
            opts = undefined;
          }
        }
        const model = typeof a.model === 'string' ? a.model : String(e.name ?? UNKNOWN);
        const input = raw.inputTokens;
        const cached = raw.cachedTokens ?? 0;
        const output = raw.outputTokens ?? 0;
        const credits = raw.copilotUsageNanoAiu !== undefined ? round(raw.copilotUsageNanoAiu / NANO_PER_CREDIT) : UNKNOWN;
        const cat = catalog?.get(model);
        const catCredits = input !== undefined ? catalogCredits(model, cat, input, cached, output) : UNKNOWN;
        const parsed = parsedByKey.get(`${f.sessionId}:${ts}:${input ?? 0}`);
        requests.push({
          index: requests.length,
          at: isoLocal(ts),
          evidence: {
            file: path.relative(path.resolve(ws, '..'), f.filePath).split(path.sep).join('/'),
            line: i + 1,
            spanId: typeof e.spanId === 'string' ? e.spanId : UNKNOWN,
          },
          purpose: typeof a.debugName === 'string' ? a.debugName : UNKNOWN,
          model,
          status: typeof e.status === 'string' ? e.status : UNKNOWN,
          raw,
          // requestOptions present but no reasoning key = nothing was sent, which is a fact, not unknown.
          reasoning: {
            effort: typeof opts?.reasoning?.effort === 'string' ? opts.reasoning.effort : opts ? NOT_SENT : UNKNOWN,
            thinkingBudgetTokens: num(opts?.thinking?.budget_tokens) ?? (opts ? NOT_SENT : UNKNOWN),
            summary: typeof opts?.reasoning?.summary === 'string' ? opts.reasoning.summary : opts ? NOT_SENT : UNKNOWN,
          },
          derived: {
            credits,
            usd: credits === UNKNOWN ? UNKNOWN : round(credits * USD_PER_CREDIT),
            catalogCredits: catCredits,
            reconciliationDeltaCredits:
              credits === UNKNOWN || catCredits === UNKNOWN ? UNKNOWN : round(credits - catCredits),
            promptTokens: input ?? UNKNOWN,
            maxPromptTokens: cat?.maxPromptTokens ?? UNKNOWN,
            promptOccupancy:
              input !== undefined && cat?.maxPromptTokens ? round(input / cat.maxPromptTokens) : UNKNOWN,
            // No long-context tier in the catalog → the model can't be billed as long context.
            longContext: input === undefined || !cat ? UNKNOWN : isLongContext(cat, input),
            contextSources: parsed?.contextBreakdown
              ? parsed.contextBreakdown.map((s) => ({ source: s.label, chars: s.chars }))
              : UNKNOWN,
            // A parsed request with no attachments list had none attached.
            attachments: parsed ? (parsed.attachments ?? []).map((x) => ({ path: x.path, chars: x.chars })) : UNKNOWN,
          },
        });
      }
    });

    const childSessions: ChildSessionExport[] = [];
    for (const c of children) {
      const file = c.file && sidecars.includes(c.file) ? c.file : '';
      childSessions.push({ ...c, file: file || UNKNOWN, ...(file ? await readChildLog(sessionDir, file) : { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }) });
    }

    let totalIn = 0;
    let totalCached = 0;
    let totalOut = 0;
    let totalCredits = 0;
    let totalCatalog = 0;
    let catalogComplete = requests.length > 0;
    let peak = 0;
    for (const r of requests) {
      totalIn += r.raw.inputTokens ?? 0;
      totalCached += r.raw.cachedTokens ?? 0;
      totalOut += r.raw.outputTokens ?? 0;
      totalCredits += r.derived.credits === UNKNOWN ? 0 : r.derived.credits;
      if (r.derived.catalogCredits === UNKNOWN) {
        catalogComplete = false;
      } else {
        totalCatalog += r.derived.catalogCredits;
      }
      peak = Math.max(peak, r.raw.inputTokens ?? 0);
    }

    const chat = chatsById.get(f.sessionId);
    const eff = chat ? scoreMessages(chat.messages, config) : undefined;
    const has = (re: RegExp) => sidecars.filter((n) => re.test(n)).length;

    out.push({
      schema: EXPORT_SCHEMA,
      generatedAt: isoLocal(generatedAt.getTime()),
      tokenCoachVersion,
      fieldKinds: FIELD_KINDS,
      session: {
        debugSessionId: f.sessionId,
        workspaceStorageId: path.basename(ws),
        workspaceFolder: folders.get(ws) ?? UNKNOWN,
        vscodeChatSessionId: chatIds.get(f.sessionId) ?? UNKNOWN,
        title: chat?.title ?? UNKNOWN,
        startedAt: isoLocal(firstTs),
        endedAt: isoLocal(lastTs),
      },
      versions: { vscode, copilotChat: copilot },
      coverage: {
        mainLog: { lines: lines.filter((l) => l.trim()).length, events, unreadableLines: unreadable, lastLineComplete },
        modelCatalog: catalog !== undefined,
        systemPromptFiles: has(/^system_prompt_\d+\.json$/),
        toolCatalogFiles: has(/^tools_\d+\.json$/),
        childLogs: childSessions.length,
        vscodeChatFile: chatIds.has(f.sessionId),
        notInLogs: [
          'cache-write tokens',
          'compaction events',
          'explicit 1M context selection',
          'model fallback reason',
        ],
      },
      thresholds,
      pricing: {
        usdPerCredit: USD_PER_CREDIT,
        formula: 'credits = copilotUsageNanoAiu / 1e9; usd = credits × 0.01',
        catalogFormula:
          'catalogCredits = ((inputTokens − cachedTokens) × freshPrice + cachedTokens × cachePrice + outputTokens × output_price) / batch_size, from models.json token_prices (the long_context tier once inputTokens exceeds default.context_max). ' +
          'freshPrice = cache_write_price if listed above 0, else 1.25 × input_price for Claude (every new token is written to cache), else input_price. ' +
          'cachePrice = exactly 10% of input_price when the listed cache_price is that value rounded (the catalog rounds to whole units), else cache_price.',
        catalogFormulaVerifiedOn:
          'Matched logged cost within 0.03% on 282 requests (2026-09-27): claude-haiku-4.5, gpt-5-mini, gpt-4o-mini, oswe-vscode-prime, mai-code-1-flash. ' +
          'Other models and the long-context tier follow the same formula but were not in the verification logs; treat their reconciliation gap as the check.',
      },
      totals: {
        userMessages,
        requests: requests.length,
        inputTokens: totalIn,
        cachedTokens: totalCached,
        outputTokens: totalOut,
        credits: round(totalCredits),
        usd: round(totalCredits * USD_PER_CREDIT),
        catalogCredits: catalogComplete ? round(totalCatalog) : UNKNOWN,
        reconciliationDeltaCredits: catalogComplete ? round(totalCredits - totalCatalog) : UNKNOWN,
        peakPromptTokens: peak,
        childSessionCredits: round(childSessions.reduce((s, c) => s + c.credits, 0)),
      },
      cacheWaste: {
        score: eff?.score ?? 100,
        idlePauseCredits: round((eff?.timingWasteNanoAiu ?? 0) / NANO_PER_CREDIT),
        idlePauses: eff?.idleMisses ?? 0,
        breakCredits: round((eff?.qualityWasteNanoAiu ?? 0) / NANO_PER_CREDIT),
        breaks: eff?.breakMisses ?? 0,
      },
      childSessions,
      requests,
    });
  }
  out.sort((a, b) => (a.session.startedAt < b.session.startedAt ? 1 : -1));
  return out;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const show = (v: unknown) => (v === UNKNOWN || v === undefined ? '—' : String(v));
const pct = (v: number | Unknown) => (v === UNKNOWN ? '—' : `${Math.round(v * 100)}%`);

export function sessionMarkdown(s: SessionExport): string {
  const L: string[] = [];
  L.push(`# ${s.session.title === UNKNOWN ? `Session ${s.session.debugSessionId.slice(0, 8)}` : s.session.title}`);
  L.push('');
  L.push(`Token Coach ${s.tokenCoachVersion} · schema \`${s.schema}\` · generated ${s.generatedAt}`);
  L.push('');
  L.push('## Identity and coverage');
  L.push('');
  L.push('| Field | Value |');
  L.push('| --- | --- |');
  L.push(`| Debug session | \`${s.session.debugSessionId}\` |`);
  L.push(`| VS Code chat session | ${show(s.session.vscodeChatSessionId)} |`);
  L.push(`| Workspace | ${show(s.session.workspaceFolder)} |`);
  L.push(`| Time | ${show(s.session.startedAt)} → ${show(s.session.endedAt)} |`);
  L.push(`| VS Code / Copilot Chat | ${show(s.versions.vscode)} / ${show(s.versions.copilotChat)} |`);
  L.push(`| Log | ${s.coverage.mainLog.events} events, ${s.coverage.mainLog.unreadableLines} unreadable, last line ${s.coverage.mainLog.lastLineComplete ? 'complete' : 'cut off'} |`);
  L.push(`| Artifacts | model catalog ${s.coverage.modelCatalog ? 'yes' : 'no'} · system prompts ${s.coverage.systemPromptFiles} · tool catalogs ${s.coverage.toolCatalogFiles} · child logs ${s.coverage.childLogs} · VS Code chat file ${s.coverage.vscodeChatFile ? 'yes' : 'no'} |`);
  L.push(`| Not in the logs | ${s.coverage.notInLogs.join(', ')} |`);
  L.push('');
  L.push('## Cost and tokens');
  L.push('');
  L.push('| Field | Value | Kind |');
  L.push('| --- | --- | --- |');
  L.push(`| User messages / model requests | ${s.totals.userMessages} / ${s.totals.requests} | derived |`);
  L.push(`| Input / cached / output tokens | ${s.totals.inputTokens.toLocaleString()} / ${s.totals.cachedTokens.toLocaleString()} / ${s.totals.outputTokens.toLocaleString()} | derived (sum of raw) |`);
  L.push(`| Credits logged | ${s.totals.credits} ($${s.totals.usd}) | derived: ${s.pricing.formula} |`);
  L.push(`| Credits from model catalog | ${show(s.totals.catalogCredits)} | derived: see catalogFormula in JSON |`);
  L.push(`| Logged − catalog | ${show(s.totals.reconciliationDeltaCredits)} | derived |`);
  L.push(`| Largest single prompt | ${s.totals.peakPromptTokens.toLocaleString()} tokens | derived (per request, never summed) |`);
  L.push(`| Child sessions (titles, subagents) | ${s.childSessions.length}, ${s.totals.childSessionCredits} credits | derived |`);
  L.push(`| Cache waste score | ${s.cacheWaste.score} · idle pauses ${s.cacheWaste.idlePauseCredits} cr (${s.cacheWaste.idlePauses}) · breaks ${s.cacheWaste.breakCredits} cr (${s.cacheWaste.breaks}) | heuristic |`);
  L.push('');
  L.push('## Requests');
  L.push('');
  L.push('| # | Time | Purpose | Model | Reasoning | Input | Cached | Output | Credits | Catalog | Prompt use | Log line |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of s.requests) {
    const reasoning =
      typeof r.reasoning.effort === 'string' && r.reasoning.effort !== UNKNOWN && r.reasoning.effort !== NOT_SENT
        ? r.reasoning.effort
        : typeof r.reasoning.thinkingBudgetTokens === 'number'
          ? `thinking ${r.reasoning.thinkingBudgetTokens}`
          : r.reasoning.effort === NOT_SENT
            ? 'none'
            : '—';
    L.push(
      `| ${r.index} | ${r.at.slice(11)} | ${show(r.purpose)} | ${r.model} | ${reasoning} | ${show(r.raw.inputTokens)} | ${show(r.raw.cachedTokens)} | ${show(r.raw.outputTokens)} | ${show(r.derived.credits)} | ${show(r.derived.catalogCredits)} | ${pct(r.derived.promptOccupancy)} | ${r.evidence.line} |`
    );
  }
  L.push('');
  L.push(`Log file: \`${s.requests[0]?.evidence.file ?? ''}\`. "—" means the log doesn't carry the value (unknown), not zero.`);
  L.push('');
  return L.join('\n');
}

function csvCell(v: unknown): string {
  const s = v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function requestsCsv(sessions: SessionExport[]): string {
  const head = [
    'debugSessionId', 'index', 'at', 'logFile', 'logLine', 'purpose', 'model', 'status', 'reasoningEffort',
    'thinkingBudgetTokens', 'inputTokens', 'cachedTokens', 'outputTokens', 'copilotUsageNanoAiu', 'credits',
    'catalogCredits', 'reconciliationDeltaCredits', 'promptOccupancy', 'longContext',
  ];
  const rows = [head.join(',')];
  for (const s of sessions) {
    for (const r of s.requests) {
      rows.push(
        [
          s.session.debugSessionId, r.index, r.at, r.evidence.file, r.evidence.line, r.purpose, r.model, r.status,
          r.reasoning.effort, r.reasoning.thinkingBudgetTokens, r.raw.inputTokens, r.raw.cachedTokens,
          r.raw.outputTokens, r.raw.copilotUsageNanoAiu, r.derived.credits, r.derived.catalogCredits,
          r.derived.reconciliationDeltaCredits, r.derived.promptOccupancy, r.derived.longContext,
        ]
          .map(csvCell)
          .join(',')
      );
    }
  }
  return rows.join('\n') + '\n';
}

export function sessionsCsv(sessions: SessionExport[]): string {
  const head = [
    'debugSessionId', 'vscodeChatSessionId', 'workspaceFolder', 'title', 'startedAt', 'endedAt', 'vscode',
    'copilotChat', 'userMessages', 'requests', 'inputTokens', 'cachedTokens', 'outputTokens', 'credits', 'usd',
    'catalogCredits', 'reconciliationDeltaCredits', 'peakPromptTokens', 'childSessions', 'childSessionCredits',
    'cacheWasteScore', 'idlePauseCredits', 'breakCredits',
  ];
  const rows = [head.join(',')];
  for (const s of sessions) {
    rows.push(
      [
        s.session.debugSessionId, s.session.vscodeChatSessionId, s.session.workspaceFolder, s.session.title,
        s.session.startedAt, s.session.endedAt, s.versions.vscode, s.versions.copilotChat, s.totals.userMessages,
        s.totals.requests, s.totals.inputTokens, s.totals.cachedTokens, s.totals.outputTokens, s.totals.credits,
        s.totals.usd, s.totals.catalogCredits, s.totals.reconciliationDeltaCredits, s.totals.peakPromptTokens,
        s.childSessions.length, s.totals.childSessionCredits, s.cacheWaste.score, s.cacheWaste.idlePauseCredits,
        s.cacheWaste.breakCredits,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return rows.join('\n') + '\n';
}
