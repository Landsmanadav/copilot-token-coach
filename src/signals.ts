/**
 * signals.ts
 * -----------------------------------------------------------------------------
 * Session-level signals for the export (schema 0.2): what changed during a
 * conversation, how the tools behaved, where MCP tools came from, compaction,
 * model selection, workspace identity and the optional OpenTelemetry join.
 *
 * Everything here is computed from raw log events the export pass collects.
 * The rules the team lead asked for apply throughout:
 *   • Events around a change report the numbers on both sides and never claim
 *     the change caused them ("correlation, not cause").
 *   • A value that can't be established is "unknown", with the reason.
 *   • Anything that depends on a threshold says so (kind: "heuristic").
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;

export const UNKNOWN = 'unknown' as const;
export type Unknown = typeof UNKNOWN;

// ---------------------------------------------------------------------------
// Inputs collected by the export pass
// ---------------------------------------------------------------------------

export interface RawRequest {
  index: number;
  at: number;
  end: number;
  line: number;
  purpose: string;
  model: string;
  input?: number;
  cached?: number;
  output?: number;
  effort: string;
  thinkingBudget: string;
  systemPromptFile?: string;
  toolsFile?: string;
  responseId?: string;
  messageIndex: number;
}

export interface RawToolCall {
  at: number;
  line: number;
  name: string;
  status: string;
  durationMs: number;
  args: string;
  error?: string;
  messageIndex: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function shortHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function isoLocal(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/**
 * Cache share of one request. An absent `cachedTokens` counts as 0: on 2026-09-27
 * every such request's logged cost matched the full uncached price exactly.
 */
function median(sorted: number[]): number {
  if (sorted.length === 0) {
    return 0;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cacheShare(r: RawRequest): number | Unknown {
  return r.input && r.input > 0 ? round((r.cached ?? 0) / r.input) : UNKNOWN;
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The chat entry for a user message. First by the text the user typed (the chat
 * file and the debug log can be stamped minutes apart), then by the closest
 * timestamp within a minute, else none.
 */
export function selectionFor(messageTs: number, selections: ChatSelection[], messageText?: string): ChatSelection | undefined {
  if (messageText) {
    const log = norm(messageText);
    const byText = selections.filter((s) => s.text && norm(s.text).length >= 3 && log.includes(norm(s.text).slice(0, 120)));
    if (byText.length === 1) {
      return byText[0];
    }
    if (byText.length > 1) {
      return byText.sort((a, b) => Math.abs(a.timestamp - messageTs) - Math.abs(b.timestamp - messageTs))[0];
    }
  }
  let best: ChatSelection | undefined;
  for (const s of selections) {
    const d = Math.abs(s.timestamp - messageTs);
    if (d <= 60_000 && (!best || d < Math.abs(best.timestamp - messageTs))) {
      best = s;
    }
  }
  return best;
}

/** Utility calls (titles, summaries, background helpers) — not the conversation's own turns. */
export function isUtilityPurpose(purpose: string): boolean {
  return UTILITY_PURPOSE.test(purpose);
}

/** Summarization / compaction calls, by the debugName Copilot gives them. */
function isCompactionPurpose(purpose: string): boolean {
  return COMPACTION_PURPOSE.test(purpose);
}

/** Strip // and /* *\/ comments and trailing commas, so JSONC config files parse. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// ---------------------------------------------------------------------------
// Sidecars: system prompt and tool catalog
// ---------------------------------------------------------------------------

export interface SidecarInfo {
  chars: number;
  hash: string;
  toolNames?: string[];
}

/** Read a system_prompt_N.json / tools_N.json once per session. */
export async function readSidecar(sessionDir: string, file: string, cache: Map<string, SidecarInfo | undefined>): Promise<SidecarInfo | undefined> {
  if (cache.has(file)) {
    return cache.get(file);
  }
  let info: SidecarInfo | undefined;
  try {
    const raw = await fsp.readFile(path.join(sessionDir, file), 'utf8');
    let content = raw;
    try {
      const j = JSON.parse(raw);
      if (typeof j?.content === 'string') {
        content = j.content;
      }
    } catch {
      // keep raw
    }
    info = { chars: content.length, hash: shortHash(content) };
    if (/^tools_/.test(file)) {
      try {
        const list = JSON.parse(content);
        if (Array.isArray(list)) {
          info.toolNames = list
            .map((t: any) => t?.name ?? t?.function?.name)
            .filter((n: unknown): n is string => typeof n === 'string');
        }
      } catch {
        info.toolNames = undefined;
      }
    }
  } catch {
    info = undefined;
  }
  cache.set(file, info);
  return info;
}

// ---------------------------------------------------------------------------
// MCP origin
// ---------------------------------------------------------------------------

/**
 * VS Code names an MCP tool `mcp_<prefix>_<tool>`, where prefix is the server
 * name lowercased, non [a-z0-9_.-] runs replaced by "_", cut to 13 characters
 * (found in VS Code 1.124's workbench source). With the configured server names
 * we can map a tool to its server exactly; without them we fall back to the
 * name, and say so.
 */
export function mcpPrefix(serverName: string): string {
  return serverName.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 13);
}

export interface McpOrigin {
  server: string;
  basis: 'configured' | 'name-derived';
}

export function toolOrigin(toolName: string, configured: string[]): McpOrigin | 'builtin' {
  if (!toolName.startsWith('mcp_')) {
    return 'builtin';
  }
  for (const s of configured) {
    const p = mcpPrefix(s);
    if (toolName.startsWith(`mcp_${p}_`) || new RegExp(`^mcp_${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+_`).test(toolName)) {
      return { server: s, basis: 'configured' };
    }
  }
  const rest = toolName.slice(4);
  const server = rest.length > 13 && rest[13] === '_' ? rest.slice(0, 13) : rest.split('_')[0];
  return { server, basis: 'name-derived' };
}

/** Server names from VS Code's mcp.json files (user + workspace), read-only. */
export async function configuredMcpServers(files: string[]): Promise<{ servers: string[]; sources: string[] }> {
  const servers = new Set<string>();
  const sources: string[] = [];
  for (const f of files) {
    try {
      const j = parseJsonc(await fsp.readFile(f, 'utf8')) as any;
      const map = j?.servers ?? j?.mcpServers ?? j?.mcp?.servers;
      if (map && typeof map === 'object') {
        Object.keys(map).forEach((k) => servers.add(k));
        sources.push(f);
      }
    } catch {
      // missing or unreadable — not an error
    }
  }
  return { servers: [...servers], sources };
}

// ---------------------------------------------------------------------------
// Workspace / git (read at export time)
// ---------------------------------------------------------------------------

export function folderPathFromUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) {
    return undefined;
  }
  const rest = uri.slice('file://'.length);
  let p = decodeURIComponent(rest);
  if (!rest.startsWith('/')) {
    // file://server/share/… is a UNC path on Windows.
    return `//${p}`;
  }
  if (/^\/[a-zA-Z]:/.test(p)) {
    p = p.slice(1);
  }
  return p;
}

export interface GitInfo {
  gitBacked: boolean | Unknown;
  branch: string | Unknown;
  head: string | Unknown;
  remote: string | Unknown;
  readAt: 'export time';
}

export async function readGit(folder: string | undefined): Promise<GitInfo> {
  const none: GitInfo = { gitBacked: UNKNOWN, branch: UNKNOWN, head: UNKNOWN, remote: UNKNOWN, readAt: 'export time' };
  if (!folder) {
    return none;
  }
  let gitDir = path.join(folder, '.git');
  // A worktree or submodule has a .git FILE pointing at the real git dir.
  try {
    const st = await fsp.stat(gitDir);
    if (st.isFile()) {
      const target = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(gitDir, 'utf8'))?.[1]?.trim();
      if (target) {
        gitDir = path.resolve(folder, target);
      }
    }
  } catch {
    // no .git — handled below
  }
  // Shared refs, packed-refs and config live in the common dir for worktrees.
  const commonDir = await fsp
    .readFile(path.join(gitDir, 'commondir'), 'utf8')
    .then((t) => path.resolve(gitDir, t.trim()))
    .catch(() => gitDir);
  let headText: string;
  try {
    headText = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    try {
      await fsp.access(folder);
      return { ...none, gitBacked: false };
    } catch {
      return none; // folder not on this machine (remote / moved)
    }
  }
  let branch: string | Unknown = UNKNOWN;
  let head: string | Unknown = UNKNOWN;
  const ref = /^ref:\s*(.+)$/.exec(headText)?.[1];
  if (ref) {
    branch = ref.replace(/^refs\/heads\//, '');
    try {
      head = (await fsp.readFile(path.join(commonDir, ref), 'utf8')).trim().slice(0, 12);
    } catch {
      try {
        const packed = await fsp.readFile(path.join(commonDir, 'packed-refs'), 'utf8');
        head = packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.slice(0, 12) ?? UNKNOWN;
      } catch {
        head = UNKNOWN;
      }
    }
  } else {
    branch = '(detached)';
    head = headText.slice(0, 12);
  }
  let remote: string | Unknown = UNKNOWN;
  try {
    const cfg = await fsp.readFile(path.join(commonDir, 'config'), 'utf8');
    const url = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(cfg)?.[1]?.trim();
    // Strip any credentials embedded in the URL.
    remote = url ? url.replace(/\/\/[^@/]+@/, '//') : UNKNOWN;
  } catch {
    remote = UNKNOWN;
  }
  return { gitBacked: true, branch, head, remote, readAt: 'export time' };
}

// ---------------------------------------------------------------------------
// VS Code chat file: the model the user selected per message
// ---------------------------------------------------------------------------

export interface ChatSelection {
  timestamp: number;
  modelId: string;
  /** What the user typed, from the chat file — used to match when clocks disagree. */
  text?: string;
}

/** Walk the chat file's JSON patches for every request that records a modelId. */
export async function readChatSelections(file: string): Promise<ChatSelection[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, Partial<ChatSelection>>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      o.forEach(walk);
    } else if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      if (typeof r.requestId === 'string') {
        const cur = byId.get(r.requestId) ?? {};
        if (typeof r.timestamp === 'number') {
          cur.timestamp = r.timestamp;
        }
        if (typeof r.modelId === 'string') {
          cur.modelId = r.modelId;
        }
        const msg = r.message as Record<string, unknown> | undefined;
        if (msg && typeof msg.text === 'string') {
          cur.text = msg.text;
        }
        byId.set(r.requestId, cur);
      }
      Object.values(r).forEach(walk);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    try {
      walk(JSON.parse(line));
    } catch {
      // partial line
    }
  }
  return [...byId.values()]
    .filter((s): s is ChatSelection => typeof s.modelId === 'string' && typeof s.timestamp === 'number')
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** auto · manual (a Copilot model) · byok (custom endpoint) · other:<vendor> · unknown. */
export type SelectionMode = string;

export function selectionMode(modelId: string | undefined): SelectionMode {
  if (!modelId) {
    return UNKNOWN;
  }
  if (/(^|\/)auto$/i.test(modelId)) {
    return 'auto';
  }
  const vendor = modelId.includes('/') ? modelId.split('/')[0] : 'copilot';
  if (/^copilot$/i.test(vendor)) {
    return 'manual';
  }
  if (/^customendpoint$/i.test(vendor)) {
    return 'byok';
  }
  return `other:${vendor}`;
}

// ---------------------------------------------------------------------------
// Optional OpenTelemetry file: cache-write and reasoning tokens
// ---------------------------------------------------------------------------

export interface OtelUsage {
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
}

function attrValue(v: any): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v.intValue ?? v.doubleValue ?? v.stringValue ?? v.boolValue ?? v.value;
  }
  return v;
}

/**
 * Read Copilot's OTel JSON-lines file (github.copilot.chat.otel.outfile) and
 * index usage by response id. Accepts both a flat `attributes: {k: v}` map and
 * OTLP's `attributes: [{key, value: {intValue}}]` list.
 */
export async function readOtelUsage(file: string | undefined): Promise<{ byResponseId: Map<string, OtelUsage>; status: string }> {
  const byResponseId = new Map<string, OtelUsage>();
  if (!file) {
    return { byResponseId, status: 'not configured' };
  }
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return { byResponseId, status: 'configured, file not found' };
  }
  const visit = (o: any): void => {
    if (Array.isArray(o)) {
      o.forEach(visit);
      return;
    }
    if (!o || typeof o !== 'object') {
      return;
    }
    if (o.attributes) {
      const a: Record<string, unknown> = {};
      if (Array.isArray(o.attributes)) {
        for (const kv of o.attributes) {
          if (typeof kv?.key === 'string') {
            a[kv.key] = attrValue(kv.value);
          }
        }
      } else if (typeof o.attributes === 'object') {
        Object.assign(a, o.attributes);
      }
      const id = a['gen_ai.response.id'];
      if (typeof id === 'string') {
        const num = (k: string) => {
          const v = Number(a[k]);
          return Number.isFinite(v) ? v : undefined;
        };
        byResponseId.set(id, {
          cacheCreationInputTokens: num('gen_ai.usage.cache_creation.input_tokens'),
          reasoningTokens: num('gen_ai.usage.reasoning_tokens') ?? num('gen_ai.usage.reasoning.output_tokens'),
        });
      }
    }
    Object.values(o).forEach(visit);
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      visit(JSON.parse(line));
    } catch {
      // partial line
    }
  }
  return { byResponseId, status: `read, ${byResponseId.size} responses` };
}

// ---------------------------------------------------------------------------
// Session signals
// ---------------------------------------------------------------------------

export interface TimelineEvent {
  at: string;
  kind:
    | 'model_switch'
    | 'reasoning_change'
    | 'toolset_change'
    | 'system_prompt_change'
    | 'idle_gap'
    | 'compaction'
    | 'context_drop';
  /** heuristic when a threshold decides whether this is an event. */
  signalKind: 'derived' | 'heuristic';
  requestIndex: number;
  logLine: number;
  from?: string;
  to?: string;
  gapSeconds?: number;
  promptBefore?: number | Unknown;
  promptAfter?: number | Unknown;
  cacheShareBefore?: number | Unknown;
  cacheShareAfter?: number | Unknown;
  note: string;
}

export interface ToolStats {
  name: string;
  origin: string;
  calls: number;
  failures: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface SessionSignals {
  interaction: {
    userMessages: number;
    mainRequests: number;
    utilityRequests: number;
    requestsPerUserMessage: number | Unknown;
    wallMinutes: number | Unknown;
    durationBucket: string;
  };
  configuration: {
    modelsUsed: string[];
    modelSwitches: number;
    modelPingPong: number;
    reasoningLevels: string[];
    reasoningChanges: number;
    selection: { messageIndex: number; selected: string | Unknown; mode: SelectionMode; served: string[]; matches: boolean | Unknown }[];
  };
  timeline: TimelineEvent[];
  tools: {
    available: number | Unknown;
    used: number;
    utilization: number | Unknown;
    calls: number;
    failures: number;
    longestFailureRun: number;
    byTool: ToolStats[];
    mcpServers: { server: string; basis: string; toolsOffered: number; toolsUsed: number; calls: number }[];
    mcpConfigured: string[];
    retryChains: { tool: string; argsFingerprint: string; statuses: string[]; firstLine: number }[];
    /** heuristic: "read-like" tools are recognised by name (see heuristics.readToolPattern). */
    repeatedReads: { target: string; reads: number; tools: string[]; lines: number[] }[];
    toolsetChanges: number;
  };
  compaction: { at: string; requestIndex: number; purpose: string; promptBefore: number | Unknown; promptAfter: number | Unknown; freedTokens: number | Unknown }[];
  contextAcquisitionMode: { value: 'repository_workspace_backed' | 'task_scoped_context_bundle' | 'mixed' | Unknown; basis: string };
}

export const IDLE_GAP_SECONDS = 60;
export const CONTEXT_DROP_SHARE = 0.3;
export const CONTEXT_DROP_MIN_TOKENS = 5000;

export interface SignalInputs {
  requests: RawRequest[];
  toolCalls: RawToolCall[];
  userMessageTimes: number[];
  userMessageTexts: (string | undefined)[];
  firstTs: number;
  lastTs: number;
  sidecars: Map<string, SidecarInfo | undefined>;
  mcpConfigured: string[];
  chatSelections: ChatSelection[];
  attachmentsSeen: boolean;
  gitBacked: boolean | Unknown;
}

export function durationBucket(minutes: number | Unknown): string {
  if (minutes === UNKNOWN) {
    return UNKNOWN;
  }
  if (minutes < 10) {
    return 'under 10 min';
  }
  if (minutes < 60) {
    return '10–60 min';
  }
  if (minutes < 240) {
    return '1–4 h';
  }
  return 'over 4 h';
}

export const READ_TOOL = /read|open_file|view|get_file|cat_file|fetch_file/i;
export const UTILITY_PURPOSE = /title|summar|compact|background|todo|progress|rename|categor/i;
export const COMPACTION_PURPOSE = /summar|compact/i;

function argsTarget(args: string): string | undefined {
  try {
    const a = JSON.parse(args);
    const t = a?.filePath ?? a?.path ?? a?.uri ?? a?.file;
    return typeof t === 'string' ? t : undefined;
  } catch {
    return undefined;
  }
}

function canonicalArgs(args: string): string {
  try {
    const sortKeys = (v: any): any =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
          : v;
    return JSON.stringify(sortKeys(JSON.parse(args)));
  } catch {
    return args;
  }
}

export function computeSignals(inp: SignalInputs): SessionSignals {
  const reqs = [...inp.requests].sort((a, b) => a.at - b.at);
  const main = reqs.filter((r) => !isUtilityPurpose(r.purpose));
  const utility = reqs.length - main.length;
  const timeline: TimelineEvent[] = [];
  const level = (r: RawRequest) =>
    r.effort !== UNKNOWN && r.effort !== 'not sent'
      ? r.effort
      : r.thinkingBudget !== UNKNOWN && r.thinkingBudget !== 'not sent'
        ? `thinking ${r.thinkingBudget}`
        : 'none';

  // ---- Changes between consecutive main requests.
  let modelSwitches = 0;
  let reasoningChanges = 0;
  let toolsetChanges = 0;
  for (let i = 1; i < main.length; i++) {
    const a = main[i - 1];
    const b = main[i];
    const base = {
      at: isoLocal(b.at),
      requestIndex: b.index,
      logLine: b.line,
      promptBefore: a.input ?? UNKNOWN,
      promptAfter: b.input ?? UNKNOWN,
      cacheShareBefore: cacheShare(a),
      cacheShareAfter: cacheShare(b),
    };
    if (a.model !== b.model) {
      modelSwitches++;
      timeline.push({ ...base, kind: 'model_switch', signalKind: 'derived', from: a.model, to: b.model, note: 'Cache numbers on both sides; correlation, not cause.' });
    }
    if (level(a) !== level(b)) {
      reasoningChanges++;
      timeline.push({ ...base, kind: 'reasoning_change', signalKind: 'derived', from: level(a), to: level(b), note: 'Reasoning setting sent with the request changed.' });
    }
    const ta = a.toolsFile ? inp.sidecars.get(a.toolsFile) : undefined;
    const tb = b.toolsFile ? inp.sidecars.get(b.toolsFile) : undefined;
    if (ta && tb && ta.hash !== tb.hash) {
      toolsetChanges++;
      const before = new Set(ta.toolNames ?? []);
      const after = new Set(tb.toolNames ?? []);
      const added = [...after].filter((n) => !before.has(n));
      const removed = [...before].filter((n) => !after.has(n));
      const diff =
        ta.toolNames && tb.toolNames
          ? ` Added: ${added.length ? added.join(', ') : 'none'}. Removed: ${removed.length ? removed.join(', ') : 'none'}.` +
            (added.length || removed.length ? '' : ' Same names; descriptions or schemas changed.')
          : '';
      timeline.push({
        ...base,
        kind: 'toolset_change',
        signalKind: 'derived',
        from: `${ta.toolNames?.length ?? '?'} tools #${ta.hash}`,
        to: `${tb.toolNames?.length ?? '?'} tools #${tb.hash}`,
        note: `Tool catalog sent to the model changed.${diff} Cache numbers on both sides; correlation, not cause.`,
      });
    }
    const sa = a.systemPromptFile ? inp.sidecars.get(a.systemPromptFile) : undefined;
    const sb = b.systemPromptFile ? inp.sidecars.get(b.systemPromptFile) : undefined;
    if (sa && sb && sa.hash !== sb.hash) {
      timeline.push({ ...base, kind: 'system_prompt_change', signalKind: 'derived', from: `#${sa.hash}`, to: `#${sb.hash}`, note: 'System prompt changed. Cache numbers on both sides; correlation, not cause.' });
    }
    const gap = Math.round((b.at - a.end) / 1000);
    if (gap >= IDLE_GAP_SECONDS) {
      timeline.push({ ...base, kind: 'idle_gap', signalKind: 'heuristic', gapSeconds: gap, note: `Gap of ${IDLE_GAP_SECONDS}s or more between model calls. Cache expiry depends on the provider; no fixed TTL assumed.` });
    }
    if (a.model === b.model && a.input !== undefined && b.input !== undefined && a.input - b.input >= Math.max(CONTEXT_DROP_MIN_TOKENS, a.input * CONTEXT_DROP_SHARE)) {
      timeline.push({ ...base, kind: 'context_drop', signalKind: 'heuristic', note: `Prompt shrank by ${a.input - b.input} tokens (≥30% and ≥5,000). Possible compaction or history trim; not confirmed by an event.` });
    }
  }

  // ---- Ping-pong: A → B → A on consecutive distinct models.
  const seq = main.map((r) => r.model).filter((m, i, arr) => i === 0 || arr[i - 1] !== m);
  let modelPingPong = 0;
  for (let i = 2; i < seq.length; i++) {
    if (seq[i] === seq[i - 2]) {
      modelPingPong++;
    }
  }

  // ---- Compaction calls (Copilot's summarizeConversationHistory etc.).
  const compaction: SessionSignals['compaction'] = [];
  for (const r of reqs) {
    if (!isCompactionPurpose(r.purpose)) {
      continue;
    }
    const before = [...main].reverse().find((m) => m.at < r.at);
    const after = main.find((m) => m.at > r.at);
    const pb = before?.input ?? UNKNOWN;
    const pa = after?.input ?? UNKNOWN;
    compaction.push({
      at: isoLocal(r.at),
      requestIndex: r.index,
      purpose: r.purpose,
      promptBefore: pb,
      promptAfter: pa,
      freedTokens: pb === UNKNOWN || pa === UNKNOWN ? UNKNOWN : pb - pa,
    });
    timeline.push({
      at: isoLocal(r.at),
      kind: 'compaction',
      signalKind: 'heuristic',
      requestIndex: r.index,
      logLine: r.line,
      promptBefore: pb,
      promptAfter: pa,
      note: `Copilot ran a "${r.purpose}" call (identified by its purpose name, not a native compaction event). Prompt size of the next conversation turn shown after.`,
    });
  }
  timeline.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.requestIndex - y.requestIndex));

  // ---- Tools.
  const available = new Set<string>();
  let catalogSeen = false;
  for (const r of reqs) {
    const t = r.toolsFile ? inp.sidecars.get(r.toolsFile) : undefined;
    if (t?.toolNames) {
      catalogSeen = true;
      t.toolNames.forEach((n) => available.add(n));
    }
  }
  const calls = [...inp.toolCalls].sort((a, b) => a.at - b.at);
  const used = new Set(calls.map((c) => c.name));
  const originLabel = (name: string) => {
    const o = toolOrigin(name, inp.mcpConfigured);
    return o === 'builtin' ? 'builtin' : `mcp:${o.server} (${o.basis})`;
  };
  const byName = new Map<string, RawToolCall[]>();
  for (const c of calls) {
    const l = byName.get(c.name);
    l ? l.push(c) : byName.set(c.name, [c]);
  }
  const byTool: ToolStats[] = [...byName.entries()]
    .map(([name, list]) => {
      const d = list.map((c) => c.durationMs).sort((a, b) => a - b);
      return {
        name,
        origin: originLabel(name),
        calls: list.length,
        failures: list.filter((c) => c.status !== 'ok').length,
        medianMs: median(d),
        p95Ms: percentile(d, 95),
        maxMs: d[d.length - 1] ?? 0,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  let run = 0;
  let longestFailureRun = 0;
  for (const c of calls) {
    run = c.status === 'ok' ? 0 : run + 1;
    longestFailureRun = Math.max(longestFailureRun, run);
  }

  // Retry chains: the same tool with the same arguments, where a call failed.
  const chains = new Map<string, RawToolCall[]>();
  for (const c of calls) {
    const key = `${c.name}\u0000${canonicalArgs(c.args)}`;
    const l = chains.get(key);
    l ? l.push(c) : chains.set(key, [c]);
  }
  const retryChains = [...chains.entries()]
    .filter(([, l]) => l.length >= 2 && l.some((c) => c.status !== 'ok'))
    .map(([key, l]) => ({
      tool: l[0].name,
      argsFingerprint: shortHash(key),
      statuses: l.map((c) => c.status),
      firstLine: l[0].line,
    }));

  // Repeated reads: a read-like tool on the same target more than once.
  const reads = new Map<string, RawToolCall[]>();
  for (const c of calls) {
    if (!READ_TOOL.test(c.name)) {
      continue;
    }
    const t = argsTarget(c.args);
    if (!t) {
      continue;
    }
    const l = reads.get(t);
    l ? l.push(c) : reads.set(t, [c]);
  }
  const repeatedReads = [...reads.entries()]
    .filter(([, l]) => l.length >= 2)
    .map(([target, l]) => ({ target, reads: l.length, tools: [...new Set(l.map((c) => c.name))], lines: l.map((c) => c.line) }))
    .sort((a, b) => b.reads - a.reads);

  // MCP servers: offered (catalog) vs used (calls).
  const servers = new Map<string, { basis: string; offered: Set<string>; used: Set<string>; calls: number }>();
  const addTool = (name: string, isCall: boolean) => {
    const o = toolOrigin(name, inp.mcpConfigured);
    if (o === 'builtin') {
      return;
    }
    const s = servers.get(o.server) ?? { basis: o.basis, offered: new Set<string>(), used: new Set<string>(), calls: 0 };
    if (isCall) {
      s.used.add(name);
      s.calls++;
    } else {
      s.offered.add(name);
    }
    servers.set(o.server, s);
  };
  available.forEach((n) => addTool(n, false));
  calls.forEach((c) => addTool(c.name, true));

  // ---- Model selection per user message (from the VS Code chat file).
  const selection: SessionSignals['configuration']['selection'] = [];
  const messages = inp.userMessageTimes.length;
  for (let m = 0; m < messages; m++) {
    const served = [...new Set(main.filter((r) => r.messageIndex === m).map((r) => r.model))];
    const sel = selectionFor(inp.userMessageTimes[m], inp.chatSelections, inp.userMessageTexts[m]);
    const mode = selectionMode(sel?.modelId);
    const selectedId = sel?.modelId;
    const bare = selectedId?.split('/').pop();
    selection.push({
      messageIndex: m,
      selected: selectedId ?? UNKNOWN,
      mode,
      served,
      matches: selectedId === undefined || served.length === 0 ? UNKNOWN : mode === 'auto' ? UNKNOWN : served.every((s) => s === bare),
    });
  }

  // ---- Context acquisition mode (heuristic).
  const agentReads = calls.some((c) => READ_TOOL.test(c.name) || /search|grep|list_dir|find/i.test(c.name));
  let acquisition: SessionSignals['contextAcquisitionMode'];
  if (inp.gitBacked === true && agentReads && inp.attachmentsSeen) {
    acquisition = { value: 'mixed', basis: 'git-backed workspace, agent read/searched files, and files were attached' };
  } else if (inp.gitBacked === true && agentReads) {
    acquisition = { value: 'repository_workspace_backed', basis: 'git-backed workspace and the agent read/searched files' };
  } else if (inp.attachmentsSeen && !agentReads) {
    acquisition = { value: 'task_scoped_context_bundle', basis: 'files were attached and the agent did not read/search on its own' };
  } else {
    acquisition = { value: UNKNOWN, basis: 'not enough evidence' };
  }

  const wall = inp.firstTs && inp.lastTs ? round((inp.lastTs - inp.firstTs) / 60000, 1) : UNKNOWN;
  return {
    interaction: {
      userMessages: messages,
      mainRequests: main.length,
      utilityRequests: utility,
      requestsPerUserMessage: messages > 0 ? round(main.length / messages, 2) : UNKNOWN,
      wallMinutes: wall,
      durationBucket: durationBucket(wall),
    },
    configuration: {
      modelsUsed: [...new Set(main.map((r) => r.model))],
      modelSwitches,
      modelPingPong,
      reasoningLevels: [...new Set(main.map(level))],
      reasoningChanges,
      selection,
    },
    timeline,
    tools: {
      available: catalogSeen ? available.size : UNKNOWN,
      used: used.size,
      utilization: catalogSeen && available.size > 0 ? round([...used].filter((u) => available.has(u)).length / available.size) : UNKNOWN,
      calls: calls.length,
      failures: calls.filter((c) => c.status !== 'ok').length,
      longestFailureRun,
      byTool,
      mcpServers: [...servers.entries()].map(([server, s]) => ({
        server,
        basis: s.basis,
        toolsOffered: s.offered.size,
        toolsUsed: s.used.size,
        calls: s.calls,
      })),
      mcpConfigured: inp.mcpConfigured,
      retryChains,
      repeatedReads,
      toolsetChanges,
    },
    compaction,
    contextAcquisitionMode: acquisition,
  };
}
