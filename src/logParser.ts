/**
 * logParser.ts
 * -----------------------------------------------------------------------------
 * Responsible for two things:
 *   1. Finding every Copilot Chat debug log (`main.jsonl`) on disk, across
 *      macOS / Windows / Linux and across VS Code variants.
 *   2. Parsing those JSONL files into a typed array of `LlmRequestRecord`s,
 *      tolerating malformed lines.
 *
 * The whole extension is read-only: we never touch Copilot's files except to
 * read them.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fsp = fs.promises;

/**
 * A single `llm_request` event, normalized into the shape the rest of the
 * extension cares about.
 */
export interface LlmRequestRecord {
  /** Stable, unique key for this record (used for de-duplication / React-like keys). */
  id: string;
  /** Epoch milliseconds when the request was logged. */
  timestamp: number;
  /** Model name, e.g. "claude-haiku-4.5". */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** The real cost metric. Big number — 1e9 NanoAiu == 1 AIU. */
  costNanoAiu: number;
  /** cachedTokens / inputTokens, clamped to [0, 1]. 0 when input is 0. */
  cacheHitRate: number;
  /** Time-to-first-token in ms, if present. */
  ttft?: number;
  /** The most recent `user_message` content seen before this request (best-effort). */
  userMessage?: string;
  /** Session id, derived from the log directory name. */
  sessionId: string;
  /**
   * Stable id of the user message (turn group) this request belongs to. One
   * user message fans out into many requests in agent mode, so this is how we
   * roll requests up into "what was asked".
   */
  messageId: string;
  /** Timestamp of the originating `user_message`, if known. */
  messageTimestamp?: number;
  /** Agent loop turn index (parsed from `turn_start:N`), if known. */
  turnIndex?: number;
  /**
   * Where this request's context came from, in characters per source
   * (attachments, editor, workspace, memory, …). Derived from `inputMessages`.
   * This is the "open editors and stuff" breakdown.
   */
  contextBreakdown?: ContextSource[];
  /** Individual attached files (open editors) included in this request. */
  attachments?: AttachmentInfo[];
  /** Absolute path of the source `main.jsonl`. */
  sourceFile: string;
}

/** A single attached file (open editor) sent as context. */
export interface AttachmentInfo {
  /** File path or attachment id. */
  path: string;
  /** Approximate size of the attached content, in characters. */
  chars: number;
}

/** Characters of context contributed by one labelled source. */
export interface ContextSource {
  /** Raw tag name, e.g. "attachments". */
  key: string;
  /** Friendly label, e.g. "Attachments / open files". */
  label: string;
  /** Size in characters (a proxy for tokens — roughly chars/4). */
  chars: number;
}

/** A `tool_call` event — what the agent invoked and how heavy it was. */
export interface ToolCallRecord {
  id: string;
  timestamp: number;
  /** Tool name, e.g. "create_file", "read_file". */
  name: string;
  /** Wall-clock duration in ms (from the event's `dur`). */
  durationMs: number;
  /** "ok" | "error" | … */
  status: string;
  /** Size of the arguments the agent sent, in characters. */
  argsChars: number;
  /** Size of the result fed back into context, in characters. */
  resultChars: number;
  /** A short human descriptor parsed from args (e.g. a file path), if any. */
  target?: string;
  sessionId: string;
  messageId: string;
  turnIndex?: number;
}

/** One aggregated tool in a message: how often, how long, how heavy. */
export interface ToolSummary {
  name: string;
  calls: number;
  durationMs: number;
  /** args + result characters across all calls (context the tool injected). */
  chars: number;
}

/** Everything parsed from the logs. */
export interface ParsedData {
  requests: LlmRequestRecord[];
  toolCalls: ToolCallRecord[];
  /** Generated chat title per sessionId (best-effort, from the title-*.jsonl sidecar). */
  titles: Record<string, string>;
  /** Union of tool names *defined* (offered to the model) across all parsed logs. */
  definedTools?: string[];
  /**
   * Tool names *defined* (offered to the model) per chat session. Keyed by
   * sessionId. Lets us judge, per chat, whether a tool was available but never
   * called — the basis for the "unused across N chats" trend.
   */
  definedToolsBySession?: Record<string, string[]>;
  /** Representative per-request tool-definition size in characters (the largest seen). */
  toolDefsChars?: number;
}

/**
 * The "structural waste" view, Copilot-style: which tools are shipped to the
 * model on every request (part of the cached prefix) vs which ones the agent
 * actually called. Tools defined but never called are dead weight you pay to
 * send each turn — the analog of "skills you installed but never invoke".
 */
export interface ToolInventory {
  /** All tool names offered to the model, sorted. */
  defined: string[];
  /** Tool names that were actually invoked at least once, sorted. */
  called: string[];
  /** Defined but never called — the dead weight, sorted. */
  unused: string[];
  /** Per-request tool-catalog size in characters (≈ chars/4 tokens). */
  perRequestChars: number;
  /** False when no tool catalog was recorded (older logs). */
  hasData: boolean;
}

/**
 * A whole chat (one debug session / conversation), with all its messages rolled
 * up. The top level of the dashboard: Chat → Messages → turns/tools.
 */
export interface ChatGroup {
  sessionId: string;
  /** Human title (from the title sidecar) or a fallback derived from the first message. */
  title: string;
  /** Messages in this chat, oldest first (the order they were asked). */
  messages: MessageGroup[];
  startTime: number;
  lastTime: number;
  totalCostNanoAiu: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  cacheHitRate: number;
  requestCount: number;
  toolCount: number;
  modelCounts: Record<string, number>;
}

/**
 * All the requests triggered by a single user message, rolled up. This is the
 * "summary of one message" view: the headline numbers plus the individual
 * requests (the agent's "thinking") available underneath.
 */
export interface MessageGroup {
  /** Same as the member requests' `messageId`. */
  id: string;
  sessionId: string;
  userMessage?: string;
  /** Earliest timestamp in the group (user message ts, else first request). */
  startTime: number;
  /** Member requests, in chronological (execution) order. */
  requests: LlmRequestRecord[];
  totalCostNanoAiu: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  /** Aggregate: totalCached / totalInput (0 when no input). */
  cacheHitRate: number;
  /** Distinct models used, with how many requests each. */
  modelCounts: Record<string, number>;
  /** Number of distinct agent turns (falls back to request count). */
  turnCount: number;
  /** Every tool call made while handling this message, chronological. */
  toolCalls: ToolCallRecord[];
  /** Tools aggregated by name (the "tools taking too much" view), heaviest first. */
  toolSummary: ToolSummary[];
  /**
   * Context composition of the heaviest (largest-input) request in the message.
   * Representative of "how big did context get and where did it come from".
   */
  peakContext: ContextSource[];
  /** Attached files (open editors) from that peak request. */
  peakAttachments: AttachmentInfo[];
  /** inputTokens of that peak request (denominator for share calculations). */
  peakInputTokens: number;
  /**
   * 0-based position of this message within its chat (set by groupByChat). The
   * first message (0) starts with a cold cache, so low cache there is expected
   * and shouldn't be flagged.
   */
  chatMessageIndex: number;
  /**
   * Idle time (ms) between the previous message's last request and this
   * message's first one, within the same chat (set by groupByChat). Undefined
   * for the first message. A gap longer than the prompt-cache TTL (~5 min) is
   * why a mid-chat cache can go cold from time alone.
   */
  idleGapMsBefore?: number;
}

/** A discovered log file plus its derived session id. */
interface LogFile {
  filePath: string;
  sessionId: string;
}

/** Coerce an unknown value to a finite number, defaulting to 0. */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Return the candidate `workspaceStorage` directories to scan.
 *
 * Priority:
 *   1. An explicit user override — used exclusively (testing / odd installs).
 *   2. The directory derived from VS Code's own storage location
 *      (`context.globalStorageUri`), which is correct for ANY install —
 *      portable mode, custom `--user-data-dir`, Insiders, remote, etc.
 *   3. The standard per-OS locations as a fallback (also catches the case where
 *      Copilot was used in a sibling variant like Insiders).
 */
function getStorageBases(overridePath: string, derivedBase?: string): string[] {
  // An explicit override replaces auto-detection entirely — it's the only path
  // we look at. This makes it usable for isolated testing and odd installs.
  if (overridePath && overridePath.trim().length > 0) {
    return [overridePath.trim()];
  }

  const bases: string[] = [];

  // Most reliable: derived from this VS Code instance's own storage path.
  if (derivedBase && derivedBase.trim().length > 0) {
    bases.push(derivedBase.trim());
  }

  const home = os.homedir();
  const variants = ['Code', 'Code - Insiders', 'VSCodium'];

  if (process.platform === 'darwin') {
    const root = path.join(home, 'Library', 'Application Support');
    for (const v of variants) {
      bases.push(path.join(root, v, 'User', 'workspaceStorage'));
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const v of variants) {
      bases.push(path.join(appData, v, 'User', 'workspaceStorage'));
    }
  } else {
    // Linux and everything else.
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const v of variants) {
      bases.push(path.join(configHome, v, 'User', 'workspaceStorage'));
    }
  }

  return bases;
}

/**
 * Canonical key for de-duplicating filesystem paths that point at the same
 * physical location.
 *
 * On case-insensitive platforms (Windows, macOS) two path strings can address
 * the same directory while differing only in case. The common offender on
 * Windows is the drive letter: VS Code's `globalStorageUri.fsPath` yields
 * `c:\Users\…` (lowercase drive) while `process.env.APPDATA` yields
 * `C:\Users\…` (uppercase). Without folding case here, the derived base and the
 * standard OS base look distinct, the same `main.jsonl` gets scanned twice, and
 * every request is counted twice — doubling cost, tokens and model-call counts.
 */
function canonicalPathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

/** Does this path exist and is it a directory? */
async function isDir(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** Does this path exist and is it a file? */
async function isFile(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Find every Copilot Chat debug log on disk.
 *
 * The known layout is:
 *   workspaceStorage/<WORKSPACE_HASH>/GitHub.copilot-chat/debug-logs/<SESSION_ID>/main.jsonl
 *
 * Rather than recurse blindly (which is slow and risky on big directories), we
 * walk that fixed depth explicitly.
 */
export async function findLogFiles(overridePath = '', derivedBase = ''): Promise<LogFile[]> {
  const results: LogFile[] = [];
  const bases = getStorageBases(overridePath, derivedBase);
  const seenStorage = new Set<string>();
  // Tracks the physical log files already collected, so the same `main.jsonl`
  // reached via two differently-cased base paths is only parsed once.
  const seenFiles = new Set<string>();

  for (const base of bases) {
    // De-dupe in case two variants resolve to the same path. Use a canonical
    // key so case-only differences (e.g. `c:\` vs `C:\` on Windows) collapse to
    // one — otherwise the same logs get scanned twice and every request doubles.
    const baseKey = canonicalPathKey(base);
    if (seenStorage.has(baseKey)) {
      continue;
    }
    seenStorage.add(baseKey);

    if (!(await isDir(base))) {
      continue;
    }

    let workspaceHashes: string[];
    try {
      workspaceHashes = await fsp.readdir(base);
    } catch {
      continue;
    }

    for (const hash of workspaceHashes) {
      const debugLogsDir = path.join(base, hash, 'GitHub.copilot-chat', 'debug-logs');
      if (!(await isDir(debugLogsDir))) {
        continue;
      }

      let sessions: string[];
      try {
        sessions = await fsp.readdir(debugLogsDir);
      } catch {
        continue;
      }

      for (const sessionId of sessions) {
        const filePath = path.join(debugLogsDir, sessionId, 'main.jsonl');
        if (await isFile(filePath)) {
          // Guard again at the file level: even if two bases slip past the
          // check above, the same physical file is only collected once.
          const fileKey = canonicalPathKey(filePath);
          if (seenFiles.has(fileKey)) {
            continue;
          }
          seenFiles.add(fileKey);
          results.push({ filePath, sessionId });
        }
      }
    }
  }

  return results;
}

/**
 * Tag blocks Copilot injects into a `user_message` that aren't what the human
 * typed: system reminders, attached-file reference lists, environment context,
 * editor state, memory, etc. When a message is *only* such a block (e.g. you
 * attached a file but typed nothing) the raw content is pure XML noise — so we
 * strip these so the displayed "what you asked" is the real question.
 */
const INJECTED_BLOCKS = [
  'system-reminder',
  'reminderInstructions',
  'context',
  'attachments',
  'attachment',
  'editorContext',
  'workspace_info',
  'userMemory',
  'repoMemory',
  'sessionMemory',
];

/** Quick test: does this text contain any injected block at all? */
const INJECTED_RE = new RegExp(`<(${INJECTED_BLOCKS.join('|')})\\b`, 'i');

/** Last path segment of a posix/windows path, with any trailing `:line` removed. */
function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/**
 * Remove Copilot's injected blocks (tag *and* inner content) from a message,
 * leaving only what the user actually wrote. Only the known block names are
 * touched, so legitimate angle-bracket content in a question (e.g. `<div>`) is
 * preserved. Whitespace is collapsed to a single line for display.
 */
function stripInjectedBlocks(text: string): string {
  let out = text;
  for (const tag of INJECTED_BLOCKS) {
    // Whole block: <tag ...> … </tag>.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    // Any leftover stray open/close/self-closing tag of the same name (truncated logs).
    out = out.replace(new RegExp(`</?${tag}\\b[^>]*>`, 'gi'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Pull referenced file names out of an injected references / attachments block. */
function extractReferencedFiles(text: string): string[] {
  const files = new Set<string>();
  // "- /Users/…/README.md:1" style reference lines.
  const lineRe = /[-*]\s+((?:\/|[A-Za-z]:\\)[^\s:<>"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    files.add(baseName(m[1]));
  }
  // filePath="…" / path="…" attributes on <attachment> tags.
  const attrRe = /(?:filePath|path)="([^"]+)"/g;
  while ((m = attrRe.exec(text)) !== null) {
    files.add(baseName(m[1]));
  }
  return [...files].filter((f) => f.length > 0);
}

/**
 * Pull the human-readable text out of a `user_message` event. Copilot has used
 * a few shapes over time, so we try the common ones; we also strip injected
 * context blocks (see {@link stripInjectedBlocks}) so the result is the question
 * the developer actually typed, not Copilot's `<system-reminder>` plumbing.
 */
function extractUserMessage(attrs: Record<string, unknown> | undefined): string | undefined {
  if (!attrs) {
    return undefined;
  }
  const content = attrs.content ?? attrs.message ?? attrs.text;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return undefined;
  }

  // Fast path: no injected blocks → return verbatim (unchanged behaviour).
  if (!INJECTED_RE.test(content)) {
    return content.trim();
  }

  const cleaned = stripInjectedBlocks(content);
  if (cleaned.length > 0) {
    return cleaned;
  }

  // Pure plumbing, no typed text — but the user likely attached files. Summarise
  // them so the row says something useful instead of showing raw XML.
  const refs = extractReferencedFiles(content);
  if (refs.length > 0) {
    const shown = refs.slice(0, 3).join(', ');
    return `📎 Referenced ${refs.length} file${refs.length === 1 ? '' : 's'}: ${shown}${refs.length > 3 ? '…' : ''}`;
  }
  return undefined;
}

/**
 * Known context blocks that appear inside `inputMessages`, mapped to friendly
 * labels. Order roughly reflects how "closable" / actionable each source is —
 * attachments (open editors) first, since that's the main thing a developer can
 * trim. Anything not listed is bucketed under "Other".
 */
const CONTEXT_SOURCES: Array<{ tag: string; label: string }> = [
  { tag: 'attachments', label: 'Attachments / open files' },
  { tag: 'editorContext', label: 'Active editor' },
  { tag: 'workspace_info', label: 'Workspace structure' },
  { tag: 'userMemory', label: 'User memory' },
  { tag: 'repoMemory', label: 'Repo memory' },
  { tag: 'sessionMemory', label: 'Session memory' },
  { tag: 'reminderInstructions', label: 'Agent instructions' },
  { tag: 'context', label: 'Environment / terminal' },
  { tag: 'userRequest', label: 'Your request' },
];

/** Pull all plain text out of an `inputMessages` message's `parts`/`content`. */
function messageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') {
    return '';
  }
  const m = msg as Record<string, unknown>;
  if (typeof m.content === 'string') {
    return m.content;
  }
  const parts = m.parts ?? m.content;
  if (Array.isArray(parts)) {
    const out: string[] = [];
    for (const p of parts) {
      if (p && typeof p === 'object') {
        const c = (p as Record<string, unknown>).content ?? (p as Record<string, unknown>).text;
        if (typeof c === 'string') {
          out.push(c);
        }
      } else if (typeof p === 'string') {
        out.push(p);
      }
    }
    return out.join('\n');
  }
  return '';
}

/**
 * Given the raw `inputMessages` string from an llm_request, work out how many
 * characters of context came from each labelled source, and which files were
 * attached. This is the data behind "open editors and stuff is taking too much".
 */
function analyzeContext(inputMessages: unknown): {
  breakdown: ContextSource[];
  attachments: AttachmentInfo[];
} {
  if (typeof inputMessages !== 'string' || inputMessages.length === 0) {
    return { breakdown: [], attachments: [] };
  }
  // Guard against pathologically large payloads.
  if (inputMessages.length > 4_000_000) {
    return { breakdown: [], attachments: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputMessages);
  } catch {
    return { breakdown: [], attachments: [] };
  }

  const blob = Array.isArray(parsed) ? parsed.map(messageText).join('\n') : messageText(parsed);
  if (blob.length === 0) {
    return { breakdown: [], attachments: [] };
  }

  const breakdown: ContextSource[] = [];
  let accountedFor = 0;

  for (const { tag, label } of CONTEXT_SOURCES) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    let chars = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(blob)) !== null) {
      chars += match[1].length;
    }
    if (chars > 0) {
      breakdown.push({ key: tag, label, chars });
      accountedFor += chars;
    }
  }

  // Whatever text wasn't inside a recognised block (raw history, tool results
  // echoed back, etc.) — only show it if it's a meaningful share.
  const other = blob.length - accountedFor;
  if (other > 0.05 * blob.length) {
    breakdown.push({ key: 'other', label: 'Conversation / other', chars: other });
  }

  breakdown.sort((a, b) => b.chars - a.chars);

  // Extract individual attachments (open editors) with their sizes.
  const attachments: AttachmentInfo[] = [];
  const attRe = /<attachment\b([^>]*)>([\s\S]*?)<\/attachment>/g;
  let am: RegExpExecArray | null;
  while ((am = attRe.exec(blob)) !== null) {
    const attrsText = am[1];
    const pathMatch = attrsText.match(/filePath="([^"]+)"/) || attrsText.match(/id="([^"]+)"/);
    attachments.push({
      path: pathMatch ? pathMatch[1] : 'attachment',
      chars: am[2].length,
    });
  }
  attachments.sort((a, b) => b.chars - a.chars);

  return { breakdown, attachments };
}

/**
 * Best-effort read of a chat's generated title from its `title-*.jsonl` sidecar.
 * That file is a mini debug log of the title-generation sub-session; the title
 * is the assistant's response text. Returns undefined if unavailable.
 */
async function readChatTitle(sessionDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fsp.readdir(sessionDir);
  } catch {
    return undefined;
  }
  const titleFile = entries.find((e) => e.startsWith('title-') && e.endsWith('.jsonl'));
  if (!titleFile) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await fsp.readFile(path.join(sessionDir, titleFile), 'utf8');
  } catch {
    return undefined;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type !== 'agent_response') {
      continue;
    }
    const response = event.attrs?.response;
    if (typeof response !== 'string') {
      continue;
    }
    // `response` is itself a JSON array of messages; pull the assistant text.
    try {
      const msgs = JSON.parse(response);
      if (Array.isArray(msgs)) {
        const text = msgs.map(messageText).join(' ').trim();
        if (text) {
          return text.replace(/\s+/g, ' ').slice(0, 120);
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Size (in characters ≈ bytes) of a sidecar file referenced by an llm_request,
 * such as `system_prompt_0.json` or `tools_0.json`. These live next to
 * `main.jsonl` and hold the fixed (usually cached) parts of the prompt that
 * never appear in `inputMessages`. Cached per path — they're written once and
 * referenced by many requests.
 */
async function sidecarChars(absPath: string, cache: Map<string, number>): Promise<number> {
  const hit = cache.get(absPath);
  if (hit !== undefined) {
    return hit;
  }
  let chars = 0;
  try {
    const st = await fsp.stat(absPath);
    chars = st.size;
  } catch {
    chars = 0;
  }
  cache.set(absPath, chars);
  return chars;
}

/**
 * Read the tool *names* defined in a `tools_*.json` sidecar (the catalog offered
 * to the model). Tolerates the two common shapes — a bare array of tools, or
 * `{ tools: [...] }` — and both `{ name }` and OpenAI-style `{ function: { name } }`.
 * Cached per path (the file is written once and referenced by many requests).
 */
async function readToolNames(absPath: string, cache: Map<string, string[]>): Promise<string[]> {
  const hit = cache.get(absPath);
  if (hit !== undefined) {
    return hit;
  }
  const names: string[] = [];
  try {
    const raw = await fsp.readFile(absPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.tools)
        ? ((parsed as Record<string, unknown>).tools as unknown[])
        : [];
    for (const t of arr) {
      if (t && typeof t === 'object') {
        const obj = t as Record<string, unknown>;
        const fn = obj.function as Record<string, unknown> | undefined;
        const name = typeof obj.name === 'string' ? obj.name : typeof fn?.name === 'string' ? fn.name : undefined;
        if (name) {
          names.push(name);
        }
      }
    }
  } catch {
    // Missing / malformed sidecar — just no names.
  }
  cache.set(absPath, names);
  return names;
}

/** Best-effort short descriptor for a tool call, parsed from its args JSON. */
function toolTarget(argsStr: unknown): string | undefined {
  if (typeof argsStr !== 'string' || argsStr.length === 0) {
    return undefined;
  }
  try {
    const args = JSON.parse(argsStr);
    if (args && typeof args === 'object') {
      const a = args as Record<string, unknown>;
      const candidate = a.filePath ?? a.path ?? a.query ?? a.command ?? a.uri ?? a.todoList;
      if (typeof candidate === 'string') {
        // Show just the basename for file paths to keep it short.
        return candidate.includes('/') ? candidate.slice(candidate.lastIndexOf('/') + 1) : candidate;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Parse a single `main.jsonl` file into requests + tool calls.
 *
 * As we scan top-to-bottom we track the current message (user_message) and turn
 * (turn_start) so every request and tool call can be attributed to "what was
 * asked". Malformed lines are skipped silently — debug logs are sometimes
 * truncated mid-write.
 */
export async function parseLogFile(file: LogFile): Promise<ParsedData> {
  let raw: string;
  try {
    raw = await fsp.readFile(file.filePath, 'utf8');
  } catch {
    return { requests: [], toolCalls: [], titles: {} };
  }

  const requests: LlmRequestRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const lines = raw.split(/\r?\n/);
  const sessionDir = path.dirname(file.filePath);
  const sidecarCache = new Map<string, number>();
  const toolNameCache = new Map<string, string[]>();
  // Structural-waste tracking: every tool offered to the model, and the largest
  // tool-catalog size we see (a stand-in for the per-request tool overhead).
  const definedTools = new Set<string>();
  let maxToolDefsChars = 0;

  // Boundary tracking: which message and turn each event belongs to.
  let lastUserMessage: string | undefined;
  let lastUserMessageTs: number | undefined;
  let messageIndex = -1; // becomes 0 at the first user_message
  let currentTurn: number | undefined;
  let index = 0;

  const messageIdFor = () =>
    messageIndex >= 0 ? `${file.sessionId}:m${messageIndex}` : `${file.sessionId}:pre`;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Tolerate malformed / partial lines.
      continue;
    }

    if (!event || typeof event !== 'object') {
      continue;
    }

    if (event.type === 'user_message') {
      // A new user message starts a new turn group, even if its text is empty.
      messageIndex++;
      currentTurn = undefined;
      lastUserMessage = extractUserMessage(event.attrs);
      lastUserMessageTs = num(event.ts) || undefined;
      continue;
    }

    if (event.type === 'turn_start') {
      // Names look like "turn_start:3" — pull out the turn number if present.
      currentTurn = parseTrailingInt(event.name);
      continue;
    }

    if (event.type === 'tool_call') {
      const attrs = (event.attrs ?? {}) as Record<string, unknown>;
      const ts = num(event.ts);
      toolCalls.push({
        id: `${file.sessionId}:tc:${ts}:${index}`,
        timestamp: ts,
        name: typeof event.name === 'string' ? event.name : 'tool',
        durationMs: num(event.dur),
        status: typeof event.status === 'string' ? event.status : 'ok',
        argsChars: typeof attrs.args === 'string' ? attrs.args.length : 0,
        resultChars: typeof attrs.result === 'string' ? attrs.result.length : 0,
        target: toolTarget(attrs.args),
        sessionId: file.sessionId,
        messageId: messageIdFor(),
        turnIndex: currentTurn,
      });
      index++;
      continue;
    }

    if (event.type === 'llm_request') {
      const attrs = (event.attrs ?? {}) as Record<string, unknown>;
      const inputTokens = num(attrs.inputTokens);
      const cachedTokens = num(attrs.cachedTokens);
      const cacheHitRate =
        inputTokens > 0 ? Math.min(1, Math.max(0, cachedTokens / inputTokens)) : 0;
      const ts = num(event.ts);
      const { breakdown, attachments } = analyzeContext(attrs.inputMessages);

      // Fold in the fixed prompt parts that never appear in inputMessages: the
      // system prompt and the tool-definition schemas (often the largest chunk).
      if (typeof attrs.systemPromptFile === 'string') {
        const c = await sidecarChars(path.join(sessionDir, attrs.systemPromptFile), sidecarCache);
        if (c > 0) {
          breakdown.push({ key: 'systemPrompt', label: 'System prompt', chars: c });
        }
      }
      if (typeof attrs.toolsFile === 'string') {
        const toolsPath = path.join(sessionDir, attrs.toolsFile);
        const c = await sidecarChars(toolsPath, sidecarCache);
        if (c > 0) {
          breakdown.push({ key: 'tools', label: 'Tool definitions', chars: c });
          if (c > maxToolDefsChars) {
            maxToolDefsChars = c;
          }
        }
        for (const name of await readToolNames(toolsPath, toolNameCache)) {
          definedTools.add(name);
        }
      }
      breakdown.sort((a, b) => b.chars - a.chars);

      requests.push({
        id: `${file.sessionId}:${ts}:${index}`,
        timestamp: ts,
        model: typeof attrs.model === 'string' ? attrs.model : String(event.name ?? 'unknown'),
        inputTokens,
        outputTokens: num(attrs.outputTokens),
        cachedTokens,
        costNanoAiu: num(attrs.copilotUsageNanoAiu),
        cacheHitRate,
        ttft: attrs.ttft !== undefined ? num(attrs.ttft) : undefined,
        userMessage: lastUserMessage,
        sessionId: file.sessionId,
        messageId: messageIdFor(),
        messageTimestamp: lastUserMessageTs,
        turnIndex: currentTurn,
        contextBreakdown: breakdown.length ? breakdown : undefined,
        attachments: attachments.length ? attachments : undefined,
        sourceFile: file.filePath,
      });
      index++;
    }
  }

  const title = await readChatTitle(sessionDir);
  const definedList = [...definedTools];
  return {
    requests,
    toolCalls,
    titles: title ? { [file.sessionId]: title } : {},
    definedTools: definedList,
    definedToolsBySession: definedList.length ? { [file.sessionId]: definedList } : {},
    toolDefsChars: maxToolDefsChars,
  };
}

/** Parse the integer trailing a string like "turn_start:3" -> 3. */
function parseTrailingInt(name: unknown): number | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }
  const match = name.match(/(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

/** Aggregate a message's tool calls by name, heaviest (by chars) first. */
function summarizeTools(toolCalls: ToolCallRecord[]): ToolSummary[] {
  const byName = new Map<string, ToolSummary>();
  for (const tc of toolCalls) {
    const existing = byName.get(tc.name);
    const chars = tc.argsChars + tc.resultChars;
    if (existing) {
      existing.calls += 1;
      existing.durationMs += tc.durationMs;
      existing.chars += chars;
    } else {
      byName.set(tc.name, { name: tc.name, calls: 1, durationMs: tc.durationMs, chars });
    }
  }
  return [...byName.values()].sort((a, b) => b.chars - a.chars);
}

/**
 * Roll parsed data up into per-message groups.
 *
 * Requests and tool calls are grouped by `messageId`; each group is summed and
 * annotated with distinct models, turn count, a tool breakdown (the "tools
 * taking too much" view) and the context composition of its heaviest request
 * (the "open editors and stuff" view). Groups are returned newest-first; the
 * items inside each group stay in chronological (execution) order.
 */
export function groupByMessage(data: ParsedData): MessageGroup[] {
  const reqsById = new Map<string, LlmRequestRecord[]>();
  for (const r of data.requests) {
    const list = reqsById.get(r.messageId);
    if (list) {
      list.push(r);
    } else {
      reqsById.set(r.messageId, [r]);
    }
  }

  const toolsById = new Map<string, ToolCallRecord[]>();
  for (const tc of data.toolCalls) {
    const list = toolsById.get(tc.messageId);
    if (list) {
      list.push(tc);
    } else {
      toolsById.set(tc.messageId, [tc]);
    }
  }

  const groups: MessageGroup[] = [];
  for (const [id, reqs] of reqsById) {
    reqs.sort((a, b) => a.timestamp - b.timestamp);
    const toolCalls = (toolsById.get(id) ?? []).sort((a, b) => a.timestamp - b.timestamp);

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;
    const modelCounts: Record<string, number> = {};
    const turns = new Set<number>();

    // Pick the request with the richest *logged* context for the breakdown.
    // Only the first turn logs the full context blocks (attachments, workspace,
    // memory, …); later turns log just the delta, so "largest inputTokens" would
    // pick a turn whose logged context is nearly empty.
    let peak: LlmRequestRecord | undefined;
    let peakCtxChars = -1;

    for (const r of reqs) {
      totalCost += r.costNanoAiu;
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      totalCached += r.cachedTokens;
      modelCounts[r.model] = (modelCounts[r.model] ?? 0) + 1;
      if (r.turnIndex !== undefined) {
        turns.add(r.turnIndex);
      }
      const ctxChars = (r.contextBreakdown ?? []).reduce((s, c) => s + c.chars, 0);
      if (ctxChars > peakCtxChars || (ctxChars === peakCtxChars && (!peak || r.inputTokens > peak.inputTokens))) {
        peakCtxChars = ctxChars;
        peak = r;
      }
    }

    const first = reqs[0];
    groups.push({
      id,
      sessionId: first.sessionId,
      userMessage: first.userMessage,
      startTime: first.messageTimestamp ?? first.timestamp,
      requests: reqs,
      totalCostNanoAiu: totalCost,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCachedTokens: totalCached,
      cacheHitRate: totalInput > 0 ? totalCached / totalInput : 0,
      modelCounts,
      turnCount: turns.size > 0 ? turns.size : reqs.length,
      toolCalls,
      toolSummary: summarizeTools(toolCalls),
      peakContext: peak?.contextBreakdown ?? [],
      peakAttachments: peak?.attachments ?? [],
      peakInputTokens: peak?.inputTokens ?? 0,
      chatMessageIndex: 0, // real position assigned by groupByChat
    });
  }

  groups.sort((a, b) => b.startTime - a.startTime);
  return groups;
}

/**
 * Return the candidate `workspaceStorage` directories that actually exist on
 * disk. Used to set up file watchers in the right places.
 */
export async function findExistingStorageBases(overridePath = '', derivedBase = ''): Promise<string[]> {
  const existing: string[] = [];
  const seen = new Set<string>();
  for (const base of getStorageBases(overridePath, derivedBase)) {
    const key = canonicalPathKey(base);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (await isDir(base)) {
      existing.push(base);
    }
  }
  return existing;
}

/**
 * Find and parse all logs, returning requests + tool calls. Requests are sorted
 * newest-first (the status bar / summaries rely on that ordering).
 */
export async function loadAll(overridePath = '', derivedBase = ''): Promise<ParsedData> {
  const files = await findLogFiles(overridePath, derivedBase);
  const requests: LlmRequestRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const titles: Record<string, string> = {};

  // Parse files concurrently — they're independent.
  const parsed = await Promise.all(files.map((f) => parseLogFile(f)));
  // Final safety net against double-counting: every record carries a stable id
  // (`sessionId:ts:index`) that is identical across re-parses of the same file,
  // so de-duping by id collapses any duplicate that slipped past file discovery.
  const seenReqIds = new Set<string>();
  const seenToolIds = new Set<string>();
  const definedTools = new Set<string>();
  const definedToolsBySession: Record<string, string[]> = {};
  let toolDefsChars = 0;
  for (const chunk of parsed) {
    for (const r of chunk.requests) {
      if (seenReqIds.has(r.id)) {
        continue;
      }
      seenReqIds.add(r.id);
      requests.push(r);
    }
    for (const tc of chunk.toolCalls) {
      if (seenToolIds.has(tc.id)) {
        continue;
      }
      seenToolIds.add(tc.id);
      toolCalls.push(tc);
    }
    Object.assign(titles, chunk.titles);
    for (const name of chunk.definedTools ?? []) {
      definedTools.add(name);
    }
    // Merge per-session defined tools. A session maps to one file, but union
    // defensively in case the same sessionId is ever reached twice.
    for (const [sid, names] of Object.entries(chunk.definedToolsBySession ?? {})) {
      const merged = new Set(definedToolsBySession[sid] ?? []);
      for (const n of names) {
        merged.add(n);
      }
      definedToolsBySession[sid] = [...merged];
    }
    if (chunk.toolDefsChars && chunk.toolDefsChars > toolDefsChars) {
      toolDefsChars = chunk.toolDefsChars;
    }
  }

  requests.sort((a, b) => b.timestamp - a.timestamp);
  return {
    requests,
    toolCalls,
    titles,
    definedTools: [...definedTools],
    definedToolsBySession,
    toolDefsChars,
  };
}

/**
 * Compare tools *offered* to the model against tools actually *called*, to
 * surface dead weight — defined-but-never-called tools sit in the cached prefix
 * and cost cache-read tokens on every single request.
 */
export function analyzeToolInventory(data: ParsedData): ToolInventory {
  const defined = new Set(data.definedTools ?? []);
  const called = new Set<string>();
  for (const tc of data.toolCalls) {
    called.add(tc.name);
  }
  const unused = [...defined].filter((n) => !called.has(n)).sort();
  return {
    defined: [...defined].sort(),
    called: [...called].sort(),
    unused,
    perRequestChars: data.toolDefsChars ?? 0,
    hasData: defined.size > 0,
  };
}

/** One tool's standing in the "unused across chats" trend. */
export interface UnusedToolTrend {
  name: string;
  /**
   * Net unused score: +1 for each chat the tool was offered but never called,
   * −1 (floored at 0) for each chat it was called in. Reaching the threshold
   * flags it; a later chat that uses it pulls the score back down and can drop
   * it off the list. Higher = unused in more chats than it was used.
   */
  score: number;
  /** Distinct chats the tool was offered in (the observation window for it). */
  chatsDefinedIn: number;
  /** Distinct chats it was actually called in. */
  chatsUsedIn: number;
}

/** Result of the unused-tool trend analysis. */
export interface UnusedToolReport {
  /** Tools whose net score met the threshold, worst (highest score) first. */
  candidates: UnusedToolTrend[];
  /** Distinct chats observed in the data (context for the UI). */
  chatsObserved: number;
  /** The threshold that was applied. */
  threshold: number;
  /** False when there aren't enough chats / no tool catalog to judge. */
  hasData: boolean;
}

/**
 * Decide which tools are "consistently unused" across chats, using a net
 * counter (the model the user picked): walk chats oldest→newest, and for every
 * tool that was *offered* in a chat, add 1 if it wasn't called there and
 * subtract 1 (never below 0) if it was. A tool whose net score reaches
 * `threshold` is a candidate to disable; if it's used again later the score
 * falls and it drops off the list — so the advice self-corrects.
 *
 * Only counts chats where the tool was actually offered, so a tool isn't
 * penalised for chats that never had it available. Honest framing matters here:
 * this is "unused in the logged chats", not "safe to delete" — the UI says so.
 */
export function analyzeUnusedToolTrend(data: ParsedData, threshold: number): UnusedToolReport {
  const definedBySession = data.definedToolsBySession ?? {};
  const sessionIds = Object.keys(definedBySession);

  // Which tools were actually called in each session.
  const calledBySession = new Map<string, Set<string>>();
  for (const tc of data.toolCalls) {
    let set = calledBySession.get(tc.sessionId);
    if (!set) {
      set = new Set<string>();
      calledBySession.set(tc.sessionId, set);
    }
    set.add(tc.name);
  }

  // Order sessions chronologically by their earliest request, so the net
  // counter walks chats in the order they happened.
  const sessionStart = new Map<string, number>();
  for (const r of data.requests) {
    const cur = sessionStart.get(r.sessionId);
    if (cur === undefined || r.timestamp < cur) {
      sessionStart.set(r.sessionId, r.timestamp);
    }
  }
  const ordered = [...sessionIds].sort(
    (a, b) => (sessionStart.get(a) ?? 0) - (sessionStart.get(b) ?? 0)
  );

  const score = new Map<string, number>();
  const definedIn = new Map<string, number>();
  const usedIn = new Map<string, number>();

  for (const sid of ordered) {
    const called = calledBySession.get(sid) ?? new Set<string>();
    for (const name of definedBySession[sid] ?? []) {
      definedIn.set(name, (definedIn.get(name) ?? 0) + 1);
      const prev = score.get(name) ?? 0;
      if (called.has(name)) {
        usedIn.set(name, (usedIn.get(name) ?? 0) + 1);
        score.set(name, Math.max(0, prev - 1));
      } else {
        score.set(name, prev + 1);
      }
    }
  }

  const candidates: UnusedToolTrend[] = [...score.entries()]
    .filter(([, s]) => s >= threshold)
    .map(([name, s]) => ({
      name,
      score: s,
      chatsDefinedIn: definedIn.get(name) ?? 0,
      chatsUsedIn: usedIn.get(name) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    candidates,
    chatsObserved: ordered.length,
    threshold,
    hasData: ordered.length > 0 && sessionIds.length > 0,
  };
}

/**
 * Group everything into chats (sessions). Each chat holds its messages (oldest
 * first), with all the per-message rollups already computed by groupByMessage.
 * Chats are returned most-recently-active first.
 */
export function groupByChat(data: ParsedData): ChatGroup[] {
  const messages = groupByMessage(data);

  const bySession = new Map<string, MessageGroup[]>();
  for (const m of messages) {
    const list = bySession.get(m.sessionId);
    if (list) {
      list.push(m);
    } else {
      bySession.set(m.sessionId, [m]);
    }
  }

  const chats: ChatGroup[] = [];
  for (const [sessionId, msgs] of bySession) {
    msgs.sort((a, b) => a.startTime - b.startTime); // oldest first — reads like the thread
    msgs.forEach((m, i) => {
      m.chatMessageIndex = i;
      if (i > 0) {
        // Gap from the previous message's last API call to this one's first —
        // the idle time that can let the prompt cache expire on its own.
        const prev = msgs[i - 1];
        const prevEnd = prev.requests.length
          ? prev.requests[prev.requests.length - 1].timestamp
          : prev.startTime;
        const thisStart = m.requests.length ? m.requests[0].timestamp : m.startTime;
        m.idleGapMsBefore = Math.max(0, thisStart - prevEnd);
      }
    });

    let cost = 0;
    let input = 0;
    let output = 0;
    let cached = 0;
    let toolCount = 0;
    const modelCounts: Record<string, number> = {};
    for (const m of msgs) {
      cost += m.totalCostNanoAiu;
      input += m.totalInputTokens;
      output += m.totalOutputTokens;
      cached += m.totalCachedTokens;
      toolCount += m.toolCalls.length;
      for (const [model, n] of Object.entries(m.modelCounts)) {
        modelCounts[model] = (modelCounts[model] ?? 0) + n;
      }
    }

    const firstWithText = msgs.find((m) => m.userMessage && m.userMessage.trim().length > 0);
    const fallback = firstWithText?.userMessage?.trim() || `Chat ${sessionId.slice(0, 8)}`;

    chats.push({
      sessionId,
      title: data.titles[sessionId] || fallback,
      messages: msgs,
      startTime: msgs[0].startTime,
      lastTime: msgs[msgs.length - 1].startTime,
      totalCostNanoAiu: cost,
      totalInputTokens: input,
      totalOutputTokens: output,
      totalCachedTokens: cached,
      cacheHitRate: input > 0 ? cached / input : 0,
      requestCount: msgs.reduce((s, m) => s + m.requests.length, 0),
      toolCount,
      modelCounts,
    });
  }

  chats.sort((a, b) => b.lastTime - a.lastTime);
  return chats;
}
