/**
 * dashboard.ts
 * -----------------------------------------------------------------------------
 * A single webview panel. The primary view is **per message**: one row = one
 * thing the developer asked. Because agent mode fans a single message out into
 * many requests across several turns (and several models), each row rolls those
 * up into a summary — total cost, tokens, cache hit rate, models used.
 *
 * Expanding a message reveals two things:
 *   1. "Where the tokens went" — the cost drivers: which tools were heaviest
 *      (calls, time, payload) and where the context came from (attachments /
 *      open editors, workspace, memory, …).
 *   2. A turn-by-turn timeline — the main request of each turn and, nested
 *      underneath, the tool calls it made. This is the "main one and then
 *      inside" drill-down.
 *
 * The HTML is framework-free and themed with VS Code's CSS variables. The only
 * script (guarded by a CSP nonce) wires up the "Refresh" button.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  LlmRequestRecord,
  MessageGroup,
  ChatGroup,
  ToolCallRecord,
  ToolSummary,
  ContextSource,
  ParsedData,
  ToolInventory,
  UnusedToolReport,
  groupByChat,
  analyzeToolInventory,
  analyzeUnusedToolTrend,
} from './logParser';
import {
  analyzeRecord,
  aggregateWarnings,
  analyzeMessageDrivers,
  CoachConfig,
  CoachWarning,
  highestLevel,
  WarningLevel,
} from './coach';
import { computeEfficiencyFromChats, computeChatEfficiency, EfficiencyScore } from './efficiency';
import type { DailySnapshot } from './report';

// ---------------------------------------------------------------------------
// Formatting helpers (exported so the status bar can reuse them).
// ---------------------------------------------------------------------------

/** 1e9 NanoAiu == 1 AIU. Display cost in AIU, which is far more readable. */
export function formatCost(nanoAiu: number): string {
  return `${(nanoAiu / 1e9).toFixed(2)} AIU`;
}

/** Same magnitude as AIU, labelled as GitHub "credits" (1 credit = 1 AIU = $0.01). */
export function formatCredits(nanoAiu: number): string {
  return `${(nanoAiu / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} credits`;
}

/** Thousands-separated integer token count. */
export function formatTokens(tokens: number): string {
  return Math.round(tokens).toLocaleString();
}

/** Compact token count for tight spaces (tab title): 1234567 -> "1.2M". */
export function formatTokensCompact(tokens: number): string {
  if (tokens >= 1e6) {
    return `${(tokens / 1e6).toFixed(1)}M`;
  }
  if (tokens >= 1e3) {
    return `${Math.round(tokens / 1e3)}k`;
  }
  return `${Math.round(tokens)}`;
}

/** Percentage with no decimals, e.g. 0.83 -> "83%". */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Convert a NanoAiu cost to a USD string (1 AIU ≈ 1 AI credit = $0.01 by default). */
export function formatUsd(nanoAiu: number, usdPerAiu: number): string {
  const usd = (nanoAiu / 1e9) * usdPerAiu;
  if (usd <= 0) {
    return '$0.00';
  }
  if (usd < 0.01) {
    return '<$0.01';
  }
  // Cents matter for a coaching tool; keep two decimals, add thousands sep above $1k.
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Context payloads are measured in characters; ~4 chars ≈ 1 token. */
function approxTokens(chars: number): string {
  return `≈${Math.round(chars / 4).toLocaleString()} tok`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '—';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Compact idle-gap label, e.g. "12m", "1.5h". */
function formatGap(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins >= 90) {
    return `${(mins / 60).toFixed(1)}h`;
  }
  return `${Math.max(1, mins)}m`;
}

function formatTime(ts: number): string {
  if (!ts) {
    return '—';
  }
  return new Date(ts).toLocaleString();
}

/** Minimal HTML-escaping for any user-derived text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Truncate a string for display, keeping the full text in a tooltip. */
function truncate(value: string, max = 100): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** All warnings for a message: per-request rules + message-level driver rules. */
function groupWarnings(group: MessageGroup, config: CoachConfig): CoachWarning[] {
  const byRule = new Map<string, CoachWarning>();
  for (const w of aggregateWarnings(group.requests, config)) {
    byRule.set(w.rule, w);
  }
  for (const w of analyzeMessageDrivers(group, config)) {
    if (!byRule.has(w.rule)) {
      byRule.set(w.rule, w);
    }
  }
  return [...byRule.values()];
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** AIU cost attributed to each token bucket (an estimate — see splitCost). */
interface CostSplit {
  input: number;
  cached: number;
  output: number;
}

/**
 * Distribute a request's real, logged AIU cost across fresh-input / cached-input
 * / output. The Copilot log stores only a single total per request (no
 * per-component cost), so this split is an ESTIMATE driven by the configurable
 * price weights. The three parts always sum back to `costNanoAiu`, so the total
 * stays exactly as logged — only the distribution is modelled.
 */
function splitCost(
  costNanoAiu: number,
  freshInput: number,
  cachedInput: number,
  output: number,
  config: CoachConfig
): CostSplit {
  const wIn = Math.max(0, freshInput) * config.costInputWeight;
  const wCached = Math.max(0, cachedInput) * config.costCachedInputWeight;
  const wOut = Math.max(0, output) * config.costOutputWeight;
  const w = wIn + wCached + wOut;
  if (w <= 0 || costNanoAiu <= 0) {
    return { input: 0, cached: 0, output: 0 };
  }
  return {
    input: (costNanoAiu * wIn) / w,
    cached: (costNanoAiu * wCached) / w,
    output: (costNanoAiu * wOut) / w,
  };
}

interface Summary {
  totalCostNanoAiu: number;
  todayCostNanoAiu: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Cached input tokens (a subset of totalInputTokens). */
  totalCachedTokens: number;
  /** Estimated AIU split across fresh-input / cached-input / output (sums to total). */
  costSplit: CostSplit;
  totalRequests: number;
  chatCount: number;
  messageCount: number;
  aggregateCacheHitRate: number;
  priciestMessage?: MessageGroup;
  flaggedMessages: number;
  /** Earliest request timestamp on disk (0 if none) — start of the logged window. */
  coverageStartTs: number;
  /** Latest request timestamp on disk (0 if none) — end of the logged window. */
  coverageEndTs: number;
  /** Distinct local calendar days with at least one logged request. */
  coverageActiveDays: number;
}

function buildSummary(chats: ChatGroup[], config: CoachConfig): Summary {
  let totalCost = 0;
  let todayCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalRequests = 0;
  let messageCount = 0;
  let flagged = 0;
  let priciest: MessageGroup | undefined;
  const costSplit: CostSplit = { input: 0, cached: 0, output: 0 };

  // Track the span of logged data (first → last request) plus the distinct
  // calendar days that actually have logs, so the dashboard can state which
  // window the figures cover (anything outside it isn't captured).
  let coverageStart = 0;
  let coverageEnd = 0;
  const activeDays = new Set<string>();

  // Data is already month-scoped upstream; the remaining time split is "today".
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  for (const chat of chats) {
    for (const g of chat.messages) {
      messageCount++;
      totalCost += g.totalCostNanoAiu;
      totalInput += g.totalInputTokens;
      totalOutput += g.totalOutputTokens;
      totalCached += g.totalCachedTokens;
      totalRequests += g.requests.length;
      if (!priciest || g.totalCostNanoAiu > priciest.totalCostNanoAiu) {
        priciest = g;
      }
      if (groupWarnings(g, config).length > 0) {
        flagged++;
      }
      for (const r of g.requests) {
        const part = splitCost(
          r.costNanoAiu,
          r.inputTokens - r.cachedTokens,
          r.cachedTokens,
          r.outputTokens,
          config
        );
        costSplit.input += part.input;
        costSplit.cached += part.cached;
        costSplit.output += part.output;
        if (r.timestamp <= 0) {
          continue;
        }
        if (r.timestamp >= todayStart) {
          todayCost += r.costNanoAiu;
        }
        if (coverageStart === 0 || r.timestamp < coverageStart) {
          coverageStart = r.timestamp;
        }
        if (r.timestamp > coverageEnd) {
          coverageEnd = r.timestamp;
        }
        const d = new Date(r.timestamp);
        activeDays.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
      }
    }
  }

  return {
    totalCostNanoAiu: totalCost,
    todayCostNanoAiu: todayCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCachedTokens: totalCached,
    costSplit,
    totalRequests,
    chatCount: chats.length,
    messageCount,
    aggregateCacheHitRate: totalInput > 0 ? totalCached / totalInput : 0,
    priciestMessage: priciest,
    flaggedMessages: flagged,
    coverageStartTs: coverageStart,
    coverageEndTs: coverageEnd,
    coverageActiveDays: activeDays.size,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/** CSS class for a row given its worst warning level. */
function rowClass(level: WarningLevel | undefined): string {
  if (level === 'error') {
    return 'lvl-error';
  }
  if (level === 'warning') {
    return 'lvl-warning';
  }
  if (level === 'info') {
    return 'lvl-info';
  }
  return '';
}

function renderWarnings(warnings: CoachWarning[]): string {
  if (warnings.length === 0) {
    return '<span class="ok">✓ no issues</span>';
  }
  return warnings
    .map((w) => `<div class="warn warn-${w.level}">⚠ ${escapeHtml(w.message)}</div>`)
    .join('');
}

/** "gpt-5-mini ×8  ·  gpt-4o-mini-2024-07-18 ×1" */
function renderModelBadges(modelCounts: Record<string, number>): string {
  return Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([model, count]) =>
        `<span class="badge">${escapeHtml(model)}${count > 1 ? ` <span class="badge-x">×${count}</span>` : ''}</span>`
    )
    .join('');
}

// ---- Cost drivers --------------------------------------------------------

/** Plain-language explanation of each context source (shown on hover). */
const SOURCE_HELP: Record<string, string> = {
  tools:
    'The "menu" of every tool the agent COULD call: JSON schemas (name, description, parameters) for ' +
    'read_file, edit, run, every MCP tool, … — sent with every request so the model knows what\'s available, ' +
    'even if it calls none of them. Not the tool RESULTS: what called tools return (e.g. file contents) is ' +
    'counted under "Conversation / other". Usually cached — often the single largest chunk.',
  systemPrompt:
    "Copilot's base system prompt: the instructions that define how the assistant behaves. Fixed per request and usually cached.",
  attachments:
    'Files attached to the chat or open in your editor, sent as context. This is the main thing you can trim by closing tabs.',
  editorContext: 'Your currently active file and cursor/selection.',
  workspace_info: 'A summary of your workspace folders and file structure.',
  userMemory: 'Your personal Copilot instructions/memory.',
  repoMemory: 'Repository-level instructions (e.g. .github/copilot-instructions.md).',
  sessionMemory: 'Notes Copilot kept for this chat session.',
  reminderInstructions: "Copilot's agent behaviour reminders, re-injected each turn.",
  context:
    'Environment Copilot adds each turn: the current date, your open terminals and their state, and other session info — not the system prompt.',
  userRequest: 'Your actual typed message for this turn.',
  other: "Conversation history and tool results echoed back that aren't inside a recognised block.",
};

/** "Tools taking too much" — aggregated tool table for a message. */
function renderToolTable(tools: ToolSummary[]): string {
  if (tools.length === 0) {
    return '<p class="muted small">No tool calls in this message.</p>';
  }
  const rows = tools
    .map(
      (t) => `
      <tr>
        <td>${escapeHtml(t.name)}</td>
        <td class="num">${t.calls}</td>
        <td class="num">${escapeHtml(formatDuration(t.durationMs))}</td>
        <td class="num">${escapeHtml(approxTokens(t.chars))}</td>
      </tr>`
    )
    .join('');
  return `
    <table class="mini">
      <thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Time</th><th class="num">Payload</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** A request below this cache hit rate counts as "cold" (paid ~full price). */
const COLD_CACHE_RATE = 0.3;

/**
 * "Why it cost X" — the plain-language cost story. Built ONLY from real logged
 * numbers (each request's actual cost and actual cache hit rate), no estimates:
 * cold requests paid full price for the whole context; warm ones got the cache
 * discount. This answers the question the context-size table can't.
 */
function renderCostStory(group: MessageGroup): string {
  const reqs = group.requests;
  if (reqs.length === 0 || group.totalCostNanoAiu <= 0) {
    return '';
  }
  let coldCost = 0;
  let coldN = 0;
  let warmCost = 0;
  let warmN = 0;
  let warmRateSum = 0;
  for (const r of reqs) {
    if (r.cacheHitRate < COLD_CACHE_RATE) {
      coldCost += r.costNanoAiu;
      coldN++;
    } else {
      warmCost += r.costNanoAiu;
      warmN++;
      warmRateSum += r.cacheHitRate;
    }
  }
  const total = group.totalCostNanoAiu;
  const pct = (n: number) => Math.round((n / total) * 100);
  const rows: string[] = [];
  if (coldN > 0) {
    rows.push(`
      <div class="story-row">
        <span class="story-icon">🧊</span>
        <span class="story-main"><b>Cache empty — paid full price.</b>
          ${coldN} request${coldN === 1 ? '' : 's'} ran with no usable cache, so the <i>entire</i> context
          (mostly Copilot's fixed tool catalog + system prompt) was billed at the full input rate.
          Every new chat pays this once, on its first turn.</span>
        <span class="story-cost">${escapeHtml(formatCost(coldCost))} <span class="muted">· ${pct(coldCost)}%</span></span>
      </div>`);
  }
  if (warmN > 0) {
    const avg = Math.round((warmRateSum / warmN) * 100);
    rows.push(`
      <div class="story-row">
        <span class="story-icon">🔥</span>
        <span class="story-main"><b>Cache working — discounted.</b>
          ${warmN} request${warmN === 1 ? '' : 's'} reused ~${avg}% of their context from the prompt cache,
          so the repeated bulk (tool catalog, system prompt, history) cost a fraction of full price.
          Staying in one chat keeps this discount going.</span>
        <span class="story-cost">${escapeHtml(formatCost(warmCost))} <span class="muted">· ${pct(warmCost)}%</span></span>
      </div>`);
  }
  return `<div class="story">${rows.join('')}</div>`;
}

/** "Open editors and stuff" — what fills the context window, sizes + shares.
 *  Sizes only, on purpose: the logs never record cost per context block, and a
 *  derived per-source cost estimate proved more confusing than helpful — the
 *  honest cost story (cold vs cached turns) is rendered by renderCostStory(). */
function renderContextTable(group: MessageGroup): string {
  const sources = group.peakContext;
  const attachments = group.peakAttachments;
  if (sources.length === 0) {
    return '<p class="muted small">No context breakdown available (older logs may not record it).</p>';
  }
  const total = sources.reduce((s, c) => s + c.chars, 0) || 1;
  const fixedKeys = new Set(['systemPrompt', 'tools']);

  // Fixed (cached, untrimmable) sources first, then the context you control —
  // each group with a labelled subtotal so the split is obvious at a glance.
  const fixed = sources.filter((c) => fixedKeys.has(c.key));
  const variable = sources.filter((c) => !fixedKeys.has(c.key));

  const renderRow = (c: ContextSource) => {
    const pct = Math.round((c.chars / total) * 100);
    const isAttach = c.key === 'attachments';
    const isFixed = fixedKeys.has(c.key);
    const help = SOURCE_HELP[c.key] ?? '';
    return `
        <tr class="${isAttach ? 'highlight' : ''}">
          <td>
            <span class="src-label">${escapeHtml(c.label)}</span>
            ${isFixed ? '<span class="tip tip-left tag-fixed" data-tip="“Cached” = this is the part the prompt cache stores. The chat’s FIRST turn pays full price for it (cache 0% — that turn fills the cache); every later turn reads it back at ~1/10 price. So it costs real money exactly once per chat.">cached</span>' : ''}
            ${help ? '<span class="tip tip-left info" data-tip="' + escapeHtml(help) + '">ⓘ</span>' : ''}
          </td>
          <td class="num">${escapeHtml(approxTokens(c.chars))}</td>
          <td class="bar-cell">
            <span class="bar"><span class="bar-fill" style="width:${pct}%"></span></span>
            <span class="bar-pct muted">${pct}%</span>
          </td>
        </tr>`;
  };

  const groupHeader = (label: string, items: ContextSource[], tip: string) => {
    if (items.length === 0) {
      return '';
    }
    const tok = items.reduce((s, c) => s + c.chars, 0);
    return `
        <tr class="grp">
          <td><span class="tip tip-left" data-tip="${escapeHtml(tip)}">${escapeHtml(label)}</span></td>
          <td class="num">${escapeHtml(approxTokens(tok))}</td>
          <td class="bar-cell muted">${Math.round((tok / total) * 100)}% of context</td>
        </tr>`;
  };

  const hasFixed = fixed.length > 0;
  const rows =
    groupHeader(
      '🔒 Copilot overhead — same every request',
      fixed,
      'The fixed prefix: tool definitions + system prompt. It rides along on every single request. ' +
        'After the first turn the prompt cache serves it at ~1/10 price — big in tokens, small in cost — ' +
        'and it isn’t yours to trim (except by disabling unused MCP servers / tool sets).'
    ) +
    fixed.map(renderRow).join('') +
    groupHeader(
      '✂️ Your context — what you can trim',
      variable,
      'Context you control: open/attached files, conversation history, instructions, your message. ' +
        'Closing unused tabs and keeping chats focused shrinks this on every turn.'
    ) +
    variable.map(renderRow).join('');

  // List the actual attached files (open editors). The same file is often sent
  // on several turns in the logged history, so de-duplicate by path and show how
  // many times it was sent.
  let attachList = '';
  if (attachments.length > 0) {
    const byPath = new Map<string, { path: string; chars: number; count: number }>();
    for (const a of attachments) {
      const e = byPath.get(a.path);
      if (e) {
        e.count += 1;
        e.chars = Math.max(e.chars, a.chars);
      } else {
        byPath.set(a.path, { path: a.path, chars: a.chars, count: 1 });
      }
    }
    const uniq = [...byPath.values()].sort((a, b) => b.chars - a.chars);
    const items = uniq
      .slice(0, 12)
      .map(
        (a) =>
          `<li><span class="file">${escapeHtml(a.path)}</span> <span class="muted">${escapeHtml(approxTokens(a.chars))}${a.count > 1 ? ` · ×${a.count} sent` : ''}</span></li>`
      )
      .join('');
    const more = uniq.length > 12 ? `<li class="muted">+${uniq.length - 12} more…</li>` : '';
    attachList = `<div class="attach"><div class="attach-title muted">Open / attached files</div><ul>${items}${more}</ul></div>`;
  }

  const caption =
    `<p class="muted small caption">The ≈ sizes are estimates — logged text ÷ 4 chars per token — so they'll be ` +
    `close to, but never exactly, the real “in N” token counts in the turn-by-turn below (typically within ~5–10%). ` +
    `<b>Size ≠ cost:</b> the 🔒 rows are paid at full price <b>once</b>, on the chat's first turn (cache 0% — that turn ` +
    `fills the cache); every later turn reads them from cache at ~1/10 price — see “Why it cost…” above.` +
    `${hasFixed ? ' Only the ✂️ rows are yours to shrink.' : ''}</p>`;

  return `
    <table class="mini">
      <thead><tr><th>Source</th><th class="num">Size</th><th>Share of context</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${caption}
    ${attachList}`;
}

function renderDrivers(group: MessageGroup): string {
  return `
    <div class="drivers">
      <div class="driver-col">
        <div class="driver-head">🔧 Tools the agent actually called
          <span class="tip info" data-tip="What the agent did during this message. Payload = the arguments it sent plus what the tool returned (e.g. the contents of files it read), which lands back in the conversation context. Not the same as “Tool definitions” on the right — that's the catalog of tools it COULD call, sent with every request.">ⓘ</span></div>
        ${renderToolTable(group.toolSummary)}
      </div>
      <div class="driver-col">
        <div class="driver-head">📎 What fills the context window <span class="muted small">(per request — size, not cost)</span></div>
        ${renderContextTable(group)}
      </div>
    </div>`;
}

// ---- Turn timeline -------------------------------------------------------

interface TimelineItem {
  ts: number;
  turn?: number;
  request?: LlmRequestRecord;
  tool?: ToolCallRecord;
}

function renderRequestItem(record: LlmRequestRecord, config: CoachConfig): string {
  const warnings = analyzeRecord(record, config);
  const level = highestLevel(warnings);
  const uncached = Math.max(0, record.inputTokens - record.cachedTokens);
  const cacheTip =
    `cachedTokens ÷ inputTokens. ${formatTokens(record.cachedTokens)} of ${formatTokens(record.inputTokens)} ` +
    `input tokens came from cache; ${formatTokens(uncached)} were billed at the full (much higher) input rate.`;
  return `
    <div class="item item-req ${rowClass(level)}">
      <span class="item-icon">💬</span>
      <span class="item-main"><span class="badge">${escapeHtml(record.model)}</span></span>
      <span class="item-stats muted">
        in ${formatTokens(record.inputTokens)} · out ${formatTokens(record.outputTokens)} ·
        <span class="tip tip-left" data-tip="${escapeHtml(cacheTip)}">cache ${escapeHtml(formatPercent(record.cacheHitRate))}</span>
      </span>
      <span class="item-cost strong">${escapeHtml(formatCost(record.costNanoAiu))}</span>
      ${warnings.length ? `<div class="item-warn">${renderWarnings(warnings)}</div>` : ''}
    </div>`;
}

function renderToolItem(tool: ToolCallRecord): string {
  const target = tool.target ? ` <span class="muted">${escapeHtml(tool.target)}</span>` : '';
  const bad = tool.status && tool.status !== 'ok' ? ` <span class="warn-error">${escapeHtml(tool.status)}</span>` : '';
  const injected = tool.resultChars > 0 ? `+${approxTokens(tool.resultChars)} ctx` : '';
  return `
    <div class="item item-tool">
      <span class="item-icon">🔧</span>
      <span class="item-main"><code>${escapeHtml(tool.name)}</code>${target}${bad}</span>
      <span class="item-stats muted">${escapeHtml(formatDuration(tool.durationMs))}</span>
      <span class="item-cost muted">${escapeHtml(injected)}</span>
    </div>`;
}

/** The "main one and then inside" drill-down: turns, each with its requests + tools. */
function renderTimeline(group: MessageGroup, config: CoachConfig): string {
  const items: TimelineItem[] = [
    ...group.requests.map((r) => ({ ts: r.timestamp, turn: r.turnIndex, request: r })),
    ...group.toolCalls.map((t) => ({ ts: t.timestamp, turn: t.turnIndex, tool: t })),
  ].sort((a, b) => a.ts - b.ts);

  if (items.length === 0) {
    return '';
  }

  // Count model calls (not tools) per turn, to flag turns that called the model
  // more than once — usually a main model plus a cheap side-model.
  const callsPerTurn = new Map<string, number>();
  for (const r of group.requests) {
    const k = r.turnIndex === undefined ? 'none' : String(r.turnIndex);
    callsPerTurn.set(k, (callsPerTurn.get(k) ?? 0) + 1);
  }

  const out: string[] = [];
  let currentTurn: number | undefined | symbol = Symbol('none'); // force first header
  for (const it of items) {
    if (it.turn !== currentTurn) {
      currentTurn = it.turn;
      const label = it.turn !== undefined ? `Turn ${it.turn}` : 'Turn —';
      const n = callsPerTurn.get(it.turn === undefined ? 'none' : String(it.turn)) ?? 1;
      const badge =
        n > 1
          ? ` <span class="turn-calls tip" data-tip="${escapeHtml(
              `This turn called the model ${n} times — typically the main model plus a cheaper side-model ` +
                `(e.g. gpt-4o-mini) for a summary / title / classification. The small call adds a little cost.`
            )}">${n} model calls</span>`
          : '';
      out.push(`<div class="turn-head">${label}${badge}</div>`);
    }
    out.push(it.request ? renderRequestItem(it.request, config) : renderToolItem(it.tool!));
  }
  return `<div class="timeline">${out.join('')}</div>`;
}

// ---- Message group -------------------------------------------------------

/**
 * A compact "input vs output" token-share chip for message/chat headers. Input
 * is the whole prompt (cached included); a high input share with little output
 * is the classic "shovel in context, get little produced" signal. Returns '' when
 * there are no tokens. `className` lets the caller match the surrounding style
 * (e.g. "chip" in message meta, plain in chat meta).
 */
function renderIoChip(inputTokens: number, outputTokens: number, className: string): string {
  const total = inputTokens + outputTokens;
  if (total <= 0) {
    return '';
  }
  const inPct = Math.round((inputTokens / total) * 100);
  const tip =
    `Input vs output tokens: ${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out. ` +
    `A high input share with little output usually means lots of context was sent for little produced work.`;
  return `<span class="${className} tip tip-left" data-tip="${escapeHtml(
    tip
  )}">in ${inPct}% · out ${100 - inPct}%</span>`;
}

function renderGroup(group: MessageGroup, config: CoachConfig, isOpen: boolean): string {
  const warnings = groupWarnings(group, config);
  const level = highestLevel(warnings);
  const asked = group.userMessage ? escapeHtml(truncate(group.userMessage)) : '(no message text)';
  const askedTitle = group.userMessage ? escapeHtml(group.userMessage) : '';
  const reqCount = group.requests.length;
  const toolCount = group.toolCalls.length;
  const reqLabel =
    `${reqCount} request${reqCount === 1 ? '' : 's'} · ${group.turnCount} turn${group.turnCount === 1 ? '' : 's'}` +
    (toolCount ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : '');
  const open = isOpen ? ' open' : '';

  // Idle-gap indicator: a pause long enough to expire the prompt cache.
  const cacheIdleMs = Math.max(0, config.cacheIdleMinutes) * 60_000;
  const gap = group.idleGapMsBefore ?? 0;
  const showGap = group.chatMessageIndex > 0 && cacheIdleMs > 0 && gap >= cacheIdleMs;
  const gapChip = showGap
    ? `<span class="chip chip-gap tip tip-left" data-tip="${escapeHtml(
        `~${Math.round(gap / 60_000)} min idle before this message — past the ~${config.cacheIdleMinutes} min ` +
          `prompt-cache window, so the cache likely expired and the context was re-billed at the full input rate.`
      )}">⏱ ${escapeHtml(formatGap(gap))} idle</span>`
    : '';

  // "Extra" model calls = requests beyond one-per-turn (i.e. side-model calls).
  const extraCalls = Math.max(0, reqCount - group.turnCount);
  const extraNote =
    extraCalls > 0
      ? ` <span class="diag">· ${extraCalls} extra model call${extraCalls === 1 ? '' : 's'}</span>`
      : '';

  return `
    <details class="msg ${rowClass(level)}" data-id="${escapeHtml(group.id)}"${open}>
      <summary>
        <div class="msg-head">
          <span class="msg-cost">${escapeHtml(formatCost(group.totalCostNanoAiu))}</span>
          ${config.usdPerAiu > 0 ? `<span class="msg-usd">${escapeHtml(formatUsd(group.totalCostNanoAiu, config.usdPerAiu))}</span>` : ''}
          <span class="msg-tokens">${escapeHtml(formatTokensCompact(group.totalInputTokens + group.totalOutputTokens))} tok</span>
          <span class="msg-asked" title="${askedTitle}">${asked}</span>
          <span class="msg-meta">
            <span class="chip">${reqLabel}</span>
            ${gapChip}
            ${renderIoChip(group.totalInputTokens, group.totalOutputTokens, 'chip')}
            <span class="chip tip tip-left" data-tip="${escapeHtml(
              `Aggregate over this message's ${group.requests.length} request${group.requests.length === 1 ? '' : 's'}: ` +
                `${formatTokens(group.totalCachedTokens)} of ${formatTokens(group.totalInputTokens)} input tokens served from cache. ` +
                `The first turn is partly cold; later turns reuse the cache.`
            )}">cache ${escapeHtml(formatPercent(group.cacheHitRate))}</span>
            <span class="chip muted">${escapeHtml(formatTime(group.startTime))}</span>
          </span>
        </div>
        <div class="msg-models">${renderModelBadges(group.modelCounts)}</div>
        ${warnings.length ? `<div class="msg-warnings">${renderWarnings(warnings)}</div>` : ''}
      </summary>
      <div class="msg-body">
        <div class="section-title">Why it cost ${escapeHtml(formatCost(group.totalCostNanoAiu))}</div>
        ${renderCostStory(group)}
        <div class="section-title">Where the tokens went</div>
        ${renderDrivers(group)}
        <div class="section-title">Turn-by-turn <span class="muted small">(the main request of each turn, with its tool calls nested)</span>${extraNote}</div>
        ${renderTimeline(group, config)}
      </div>
    </details>`;
}

// ---- Chat (session) ------------------------------------------------------

function renderChat(chat: ChatGroup, config: CoachConfig, openState: Map<string, boolean>): string {
  // Everything starts collapsed; the user expands what they want (and that
  // choice is remembered across refreshes via openState).
  const isOpen = openState.has(chat.sessionId) ? openState.get(chat.sessionId)! : false;
  const usd =
    config.usdPerAiu > 0
      ? `<span class="chat-usd">${escapeHtml(formatUsd(chat.totalCostNanoAiu, config.usdPerAiu))}</span>`
      : '';
  const n = chat.messages.length;
  const meta =
    `${n} message${n === 1 ? '' : 's'} · ${chat.requestCount} request${chat.requestCount === 1 ? '' : 's'}` +
    (chat.toolCount ? ` · ${chat.toolCount} tool call${chat.toolCount === 1 ? '' : 's'}` : '');

  const eff = computeChatEfficiency(chat, config);
  const effBadge = eff.hasData
    ? `<span class="grade-badge ${gradeClass(eff.score)} tip tip-left" data-tip="${escapeHtml(
        `Chat efficiency ${eff.score}/100 — cache reuse ${eff.cacheScore}, clean runs ${eff.cleanScore} (${eff.cleanMessages}/${eff.messageCount}).`
      )}">${eff.grade}</span>`
    : '';

  return `
    <details class="chat" data-id="${escapeHtml(chat.sessionId)}"${isOpen ? ' open' : ''}>
      <summary>
        <div class="chat-head">
          <span class="chat-icon">🧵</span>
          ${effBadge}
          <span class="chat-title" title="${escapeHtml(chat.title)}">${escapeHtml(truncate(chat.title, 70))}</span>
          <span class="chat-cost">${escapeHtml(formatCost(chat.totalCostNanoAiu))}</span>
          ${usd}
          <span class="chat-tokens muted">${escapeHtml(formatTokensCompact(chat.totalInputTokens + chat.totalOutputTokens))} tok</span>
        </div>
        <div class="chat-meta muted">
          <span>${escapeHtml(meta)}</span>
          ${renderIoChip(chat.totalInputTokens, chat.totalOutputTokens, 'io-split')}
          <span class="tip" data-tip="${escapeHtml(
            `Aggregate over the whole chat: ${formatTokens(chat.totalCachedTokens)} of ${formatTokens(chat.totalInputTokens)} input tokens served from cache (billed at the cheaper cached rate).`
          )}">cache ${escapeHtml(formatPercent(chat.cacheHitRate))}</span>
          <span>${escapeHtml(formatTime(chat.startTime))}</span>
        </div>
        <div class="chat-models">${renderModelBadges(chat.modelCounts)}</div>
      </summary>
      <div class="chat-body">
        ${chat.messages
          .map((m) => renderGroup(m, config, openState.has(m.id) ? openState.get(m.id)! : false))
          .join('')}
      </div>
    </details>`;
}

function renderEmptyState(): string {
  return `
    <div class="empty">
      <h2>No Copilot usage logged this month yet</h2>
      <p>Token Coach shows the current calendar month only — it starts fresh on the 1st, like GitHub's
        credit meter. If you've never collected data, enable both of these settings in VS Code, then use
        Copilot Chat a few times:</p>
      <ul>
        <li><code>github.copilot.chat.agentDebugLog.enabled</code> → <code>true</code></li>
        <li><code>github.copilot.chat.agentDebugLog.fileLogging.enabled</code> → <code>true</code></li>
      </ul>
      <p>Logs are written to your VS Code <code>workspaceStorage</code> under
        <code>GitHub.copilot-chat/debug-logs/&lt;session&gt;/main.jsonl</code>.</p>
      <p><button id="refresh">Refresh</button></p>
    </div>`;
}

/** Short local date like "Jun 7, 2026". */
function formatDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Local midnight (start of the calendar day) for a timestamp. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Human "Jun 7 → Jun 8, 2026" (or a single date when the span is one day). */
function formatCoverageRange(summary: Summary): string {
  if (!summary.coverageStartTs || !summary.coverageEndTs) {
    return '';
  }
  const start = formatDateShort(summary.coverageStartTs);
  const end = formatDateShort(summary.coverageEndTs);
  return start === end ? start : `${start} → ${end}`;
}

/** "Jun 1 → Jun 10, 2026" — the 1st of the current month through today. */
function formatMonthToDateRange(): string {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const start = formatDateShort(monthStart);
  const end = formatDateShort(now.getTime());
  return start === end ? start : `${start} → ${end}`;
}

/**
 * "Used" card — credits used this calendar month. The data is month-scoped
 * upstream (extension.ts filters to the current month), so this starts fresh
 * on the 1st of each month, like GitHub's credit meter. Still only the
 * sessions Copilot debug-logged on this machine.
 */
function renderUsedCard(summary: Summary, config: CoachConfig): string {
  const showUsd = config.usdPerAiu > 0;
  const monthRange = formatMonthToDateRange();
  const loggedRange = formatCoverageRange(summary);
  const value = showUsd
    ? formatUsd(summary.totalCostNanoAiu, config.usdPerAiu)
    : formatCost(summary.totalCostNanoAiu);
  const help =
    `Credits used from the 1st of the month through today (${monthRange}), from the Copilot debug ` +
    `logs on this machine${loggedRange ? ` — logs were written on ${loggedRange}` : ''}. Resets ` +
    `automatically on the 1st of each month, like GitHub's monthly credit meter. The logs are a ` +
    `partial record — sessions on days the log wasn't written, on other machines, or in ask/inline ` +
    `(non-agent) modes aren't here — so this reads lower than your account-wide total. ` +
    `1 credit = 1 AIU = $0.01. This figure comes only from the local debug logs; for your real ` +
    `account total, see Copilot's own credit meter (the Copilot status menu on github.com).`;
  return `
    <div class="card card-budget">
      <div class="card-label">Used · this month <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value">${escapeHtml(value)}</div>
      <div class="card-sub muted">${escapeHtml(formatCredits(summary.totalCostNanoAiu))} · ${escapeHtml(monthRange)}</div>
    </div>`;
}

/** "Today" card — what's been spent since local midnight, plus the month's daily pace. */
function renderTodayCard(summary: Summary, config: CoachConfig): string {
  const showUsd = config.usdPerAiu > 0;
  const value = showUsd
    ? formatUsd(summary.todayCostNanoAiu, config.usdPerAiu)
    : formatCost(summary.todayCostNanoAiu);
  // Honest arithmetic only: month-to-date total ÷ days elapsed this month.
  const daysElapsed = new Date().getDate();
  const avgNano = summary.totalCostNanoAiu / Math.max(1, daysElapsed);
  const avg = showUsd ? formatUsd(avgNano, config.usdPerAiu) : formatCost(avgNano);
  const help =
    `Credits used since local midnight. The average is simply this month's logged total divided by ` +
    `the ${daysElapsed} day${daysElapsed === 1 ? '' : 's'} elapsed so far — no projection, just pace.`;
  return `
    <div class="card">
      <div class="card-label">Today <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value">${escapeHtml(value)}</div>
      <div class="card-sub muted">avg ${escapeHtml(avg)}/day this month</div>
    </div>`;
}

/**
 * Banner stating the window the data covers — the current calendar month only
 * (the data is month-scoped upstream, so the whole dashboard resets on the 1st).
 * Token Coach only reads sessions Copilot wrote to its debug logs on this
 * machine, so usage outside the window (other days/machines, ask/inline modes)
 * isn't included, which is why the total can read lower than GitHub's meter.
 */
function renderCoverage(summary: Summary): string {
  const range = formatCoverageRange(summary);
  if (!range) {
    return '';
  }
  const days = summary.coverageActiveDays;
  const sessions = summary.chatCount;
  const monthRange = formatMonthToDateRange();

  // If the first logged day falls after the 1st of the month, there's a blind
  // spot at the start of the month — debug logging was off, or those early logs
  // rotated away. That gap is the usual reason this total reads below Copilot's
  // own credit meter, so call it out in plain sight (not just the tooltip).
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const hasStartGap =
    summary.coverageStartTs > 0 && startOfDay(summary.coverageStartTs) > monthStart;
  const gapNote = hasStartGap
    ? ` Logged usage here only starts <b>${escapeHtml(formatDateShort(summary.coverageStartTs))}</b>, so anything
        earlier this month isn't counted below — for your full account total see Copilot's own credit meter
        (the Copilot status menu on github.com).`
    : '';

  const help =
    `Token Coach shows the current calendar month only — everything resets automatically on the 1st, ` +
    `like GitHub's credit meter. It also only sees sessions Copilot wrote to its debug logs on this ` +
    `machine: within ${monthRange}, logs exist for ${range} (${days} day${days === 1 ? '' : 's'} with logs, ${sessions} session${sessions === 1 ? '' : 's'}). ` +
    (hasStartGap
      ? `Because logging only began on ${formatDateShort(summary.coverageStartTs)}, usage earlier this month is missing entirely. `
      : '') +
    `Sessions on days the log wasn't written, on other machines, or in ask/inline modes aren't captured, ` +
    `so the total reads lower than your account-wide monthly meter. Everything here is read straight from ` +
    `the local debug logs — for your real account total, see Copilot's own credit meter on github.com.`;
  return `
    <div class="coverage">
      <span class="coverage-icon">📅</span>
      <span>The figures below cover <b>${escapeHtml(monthRange)}</b> — this month so far
        <span class="muted">(logs on ${days} day${days === 1 ? '' : 's'} · ${sessions} session${sessions === 1 ? '' : 's'})</span> —
        and reset automatically when a new month starts.${gapNote}</span>
      <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span>
    </div>`;
}

/** Bucket a grade into a colour class for the efficiency card. */
function gradeClass(score: number): string {
  if (score >= 75) {
    return 'grade-good';
  }
  if (score >= 50) {
    return 'grade-mid';
  }
  return 'grade-bad';
}

/** "Efficiency" card: the single A–F health grade, with its two sub-scores. */
function renderEfficiencyCard(eff: EfficiencyScore): string {
  if (!eff.hasData) {
    return '';
  }
  const help =
    `A single health grade for your Copilot usage. Score = 60% cache reuse + 40% clean runs. ` +
    `Cache reuse rewards staying in a chat (cached input tokens are billed far cheaper); ` +
    `clean runs is the share of messages with no warning (large input, low mid-chat cache, ` +
    `heavy attachments, expensive request). Higher = cheaper. ` +
    `Aggregate cache hit rate: ${formatPercent(eff.cacheHitRate)}.`;
  return `
    <div class="card card-eff ${gradeClass(eff.score)}">
      <div class="card-label">Efficiency <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value"><span class="grade">${eff.grade}</span> <span class="muted score-of">${eff.score}/100</span></div>
      <div class="card-sub muted">Cache reuse ${eff.cacheScore} · Clean ${eff.cleanScore} <span class="muted">(${eff.cleanMessages}/${eff.messageCount})</span></div>
    </div>`;
}

/**
 * "Token mix" card: how tokens split across fresh input / cached input / output,
 * plus the headline input-vs-output share. Input here is everything sent to the
 * model; `cached` is the subset of input served from the prompt cache (billed
 * far cheaper). A high input share with little output is the classic
 * "shovel in context, get little produced" signal.
 */
function renderTokenMixCard(summary: Summary): string {
  const input = summary.totalInputTokens;
  const output = summary.totalOutputTokens;
  const total = input + output;
  if (total <= 0) {
    return '';
  }
  const cached = Math.min(Math.max(0, summary.totalCachedTokens), input);
  const fresh = Math.max(0, input - cached);
  const inputPct = Math.round((input / total) * 100);
  const outputPct = 100 - inputPct;
  const help =
    `How your tokens split. Input = everything sent to the model (context, history, ` +
    `tool catalog); Output = what it generated. Of the input, the cached part is billed ` +
    `~80% cheaper. A high input share with very little output usually means lots of ` +
    `context was shovelled in for little produced work. Totals: ${formatTokens(fresh)} ` +
    `fresh input + ${formatTokens(cached)} cached input · ${formatTokens(output)} output.`;
  return `
    <div class="card">
      <div class="card-label">Token mix <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value">${inputPct}% <span class="muted score-of">in</span> · ${outputPct}% <span class="muted score-of">out</span></div>
      <div class="card-sub muted">in: ${escapeHtml(formatTokensCompact(fresh))} fresh + ${escapeHtml(
        formatTokensCompact(cached)
      )} cached · out: ${escapeHtml(formatTokensCompact(output))}</div>
    </div>`;
}

/** Compact daily trend of the efficiency grade (the "saved history" view). */
function renderHistory(history: DailySnapshot[]): string {
  if (history.length < 2) {
    return ''; // need at least two days to call it a trend
  }
  const chips = history
    .slice(-14)
    .map((h) => {
      const tip = `${h.date}: grade ${h.grade} (${h.score}/100) · month ${formatCost(h.monthCostNanoAiu)} · ${formatTokensCompact(h.totalTokens)} tok`;
      return `<span class="hist-chip ${gradeClass(h.score)} tip" data-tip="${escapeHtml(tip)}">
        <span class="hist-grade">${h.grade}</span><span class="hist-date muted">${escapeHtml(h.date.slice(5))}</span></span>`;
    })
    .join('');
  return `
    <details class="history" open>
      <summary>📈 Efficiency trend <span class="muted small">(daily snapshots — hover a day for details)</span></summary>
      <div class="hist-row">${chips}</div>
    </details>`;
}

interface ModelSpend {
  model: string;
  requests: number;
  tokens: number;
  /** Total input tokens (includes the cached subset). */
  inputTokens: number;
  /** Cached input tokens (a subset of inputTokens, billed cheaper). */
  cachedTokens: number;
  outputTokens: number;
  cost: number;
  /** Estimated AIU split across fresh-input / cached-input / output (sums to cost). */
  costSplit: CostSplit;
}

/** Aggregate cost / tokens / requests per model, priciest first. */
function buildModelSpend(data: ParsedData, config: CoachConfig): ModelSpend[] {
  const byModel = new Map<string, ModelSpend>();
  for (const r of data.requests) {
    const e =
      byModel.get(r.model) ??
      {
        model: r.model,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        cost: 0,
        costSplit: { input: 0, cached: 0, output: 0 },
      };
    e.requests += 1;
    e.tokens += r.inputTokens + r.outputTokens;
    e.inputTokens += r.inputTokens;
    e.cachedTokens += r.cachedTokens;
    e.outputTokens += r.outputTokens;
    e.cost += r.costNanoAiu;
    const part = splitCost(r.costNanoAiu, r.inputTokens - r.cachedTokens, r.cachedTokens, r.outputTokens, config);
    e.costSplit.input += part.input;
    e.costSplit.cached += part.cached;
    e.costSplit.output += part.output;
    byModel.set(r.model, e);
  }
  return [...byModel.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/**
 * "Token & cost breakdown" — the three token buckets (fresh input / cached input
 * / output) with token counts, token share, and estimated AIU. Token counts come
 * straight from the logs; the per-bucket AIU is modelled from the token mix (see
 * splitCost) while the total stays exactly as logged. Also surfaces the headline
 * input-vs-output token share — a high input share with little output is the
 * classic "shovel in context, get little produced" signal.
 */
function renderTokenBreakdown(summary: Summary, config: CoachConfig): string {
  const input = summary.totalInputTokens;
  const output = summary.totalOutputTokens;
  const tokenTotal = input + output;
  if (tokenTotal <= 0) {
    return '';
  }
  const cached = Math.min(Math.max(0, summary.totalCachedTokens), input);
  const fresh = Math.max(0, input - cached);
  const inputPct = Math.round((input / tokenTotal) * 100);
  const usd = (nano: number) =>
    config.usdPerAiu > 0
      ? ` <span class="muted">(${escapeHtml(formatUsd(nano, config.usdPerAiu))})</span>`
      : '';
  const buckets = [
    { label: 'Fresh input', tag: '<span class="tag-billed">full price</span>', tokens: fresh, aiu: summary.costSplit.input },
    { label: 'Cached input', tag: '<span class="tag-included">~80% cheaper</span>', tokens: cached, aiu: summary.costSplit.cached },
    { label: 'Output', tag: '', tokens: output, aiu: summary.costSplit.output },
  ];
  const body = buckets
    .map((b) => {
      const share = Math.round((b.tokens / tokenTotal) * 100);
      return `
        <tr>
          <td>${b.label} ${b.tag}</td>
          <td class="num">${escapeHtml(formatTokensCompact(b.tokens))}</td>
          <td class="num">${share}%</td>
          <td class="num">${escapeHtml(formatCost(b.aiu))}${usd(b.aiu)}</td>
        </tr>`;
    })
    .join('');
  const help =
    'Tokens come straight from the logs. The per-bucket AIU is an estimate: the log records only one ' +
    'total cost per request, so Token Coach distributes that real total across the buckets using the ' +
    'configurable price weights (tokenCoach.costInputWeight / costCachedInputWeight / costOutputWeight). ' +
    'The total AIU always matches the logs exactly.';
  return `
    <details class="model-spend" open>
      <summary>🔬 Token &amp; cost breakdown
        <span class="muted small">(input ${inputPct}% / output ${100 - inputPct}% · per-bucket AIU is an estimate <span class="tip info" data-tip="${escapeHtml(
          help
        )}">ⓘ</span>)</span></summary>
      <table class="mini">
        <thead><tr><th>Bucket</th><th class="num">Tokens</th><th class="num">Token share</th><th class="num">AIU (est.)</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </details>`;
}

/** "Where your premium budget goes" — per-model spend table, billed vs included. */
function renderModelSpend(data: ParsedData, config: CoachConfig): string {
  const rows = buildModelSpend(data, config);
  if (rows.length === 0) {
    return '';
  }
  const totalCost = rows.reduce((s, r) => s + r.cost, 0) || 1;
  const body = rows
    .map((r) => {
      const pct = Math.round((r.cost / totalCost) * 100);
      const billed = r.cost > 0;
      const tag = billed
        ? '<span class="tag-billed">billed</span>'
        : '<span class="tag-included">included</span>';
      const usd =
        config.usdPerAiu > 0
          ? ` <span class="muted">(${escapeHtml(formatUsd(r.cost, config.usdPerAiu))})</span>`
          : '';
      // Token mix: input vs output share, with fresh/cached/output + the
      // estimated AIU split available on hover.
      const ioTotal = r.inputTokens + r.outputTokens;
      const inPct = ioTotal > 0 ? Math.round((r.inputTokens / ioTotal) * 100) : 0;
      const fresh = Math.max(0, r.inputTokens - r.cachedTokens);
      const cached = Math.min(Math.max(0, r.cachedTokens), r.inputTokens);
      const mixTip =
        ioTotal > 0
          ? `Tokens — ${formatTokens(fresh)} fresh input · ${formatTokens(cached)} cached input · ` +
            `${formatTokens(r.outputTokens)} output. Estimated AIU split (distribution modelled from the ` +
            `token mix; the ${formatCost(r.cost)} total is exact): ${formatCost(r.costSplit.input)} input · ` +
            `${formatCost(r.costSplit.cached)} cached · ${formatCost(r.costSplit.output)} output.`
          : 'No token data for this model.';
      const mixCell =
        ioTotal > 0
          ? `<span class="tip tip-left" data-tip="${escapeHtml(mixTip)}">${inPct}/${100 - inPct}%</span>`
          : '<span class="muted">—</span>';
      return `
        <tr>
          <td><span class="badge">${escapeHtml(r.model)}</span> ${tag}</td>
          <td class="num">${r.requests.toLocaleString()}</td>
          <td class="num">${escapeHtml(formatTokensCompact(r.tokens))}</td>
          <td class="num">${mixCell}</td>
          <td class="num">${escapeHtml(formatCost(r.cost))}${usd}</td>
          <td class="bar-cell">
            <span class="bar"><span class="bar-fill" style="width:${pct}%"></span></span>
            <span class="bar-pct muted">${pct}%</span>
          </td>
        </tr>`;
    })
    .join('');
  return `
    <details class="model-spend" open>
      <summary>💸 Model spend
        <span class="muted small">(where your premium budget goes — “included” models are free under your plan)</span></summary>
      <table class="mini">
        <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num tip" data-tip="Input vs output token share. Hover a row for the fresh/cached/output breakdown and the estimated AIU split.">In/Out</th><th class="num">Cost</th><th>Share of cost</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </details>`;
}

/** "Tool overhead" card: catalog size shipped every request + dead-weight count. */
function renderToolCard(inv: ToolInventory): string {
  if (!inv.hasData) {
    return '';
  }
  const perReqTok = Math.round(inv.perRequestChars / 4);
  const flagged = inv.unused.length > 0;
  const help =
    `Every request ships the full tool catalog (${inv.defined.length} tools, ≈${perReqTok.toLocaleString()} tok) ` +
    `as part of the cached prefix, so you pay cache-read on it each turn. ${inv.unused.length} of them were ` +
    `never called in this data — dead weight. Trim by disabling unused MCP servers / tool sets in Copilot.`;
  return `
    <div class="card ${flagged ? 'card-flag' : ''}">
      <div class="card-label">Tool overhead <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value">${inv.defined.length} <span class="muted score-of">tools · ≈${perReqTok.toLocaleString()} tok/req</span></div>
      <div class="card-sub muted">${inv.unused.length} never called${flagged ? ' — trim to shrink every request' : ''}</div>
    </div>`;
}

/** Collapsible list of defined-but-never-called tools (the "skills you never invoke" view). */
/**
 * Top-of-dashboard banner: tools that have gone unused across enough chats to be
 * worth disabling, per the net-counter trend (see analyzeUnusedToolTrend). Kept
 * deliberately honest — "unused in your logged chats", not "safe to delete" —
 * and self-correcting: using a tool again drops it off this list.
 */
function renderUnusedToolTrend(report: UnusedToolReport): string {
  if (!report.hasData || report.candidates.length === 0) {
    return '';
  }
  const n = report.candidates.length;
  const items = report.candidates
    .map((c) => {
      const tip =
        `Offered in ${c.chatsDefinedIn} chat${c.chatsDefinedIn === 1 ? '' : 's'}, ` +
        `called in ${c.chatsUsedIn} — net unused score ${c.score} (threshold ${report.threshold}). ` +
        `Use it again and this score falls until it drops off the list.`;
      return (
        `<li><code>${escapeHtml(c.name)}</code>` +
        `<span class="muted small"> · unused score ${c.score}</span>` +
        ` <span class="tip info" data-tip="${escapeHtml(tip)}">ⓘ</span></li>`
      );
    })
    .join('');
  return `
    <div class="unused-trend card-flag">
      <div class="unused-trend-head">
        🧹 <b>${n} tool${n === 1 ? '' : 's'} you might not need</b>
        <span class="muted small">— offered to the model every request, but consistently unused across your chats</span>
      </div>
      <ul class="unused-trend-list">${items}</ul>
      <p class="muted small unused-trend-note">
        Every defined tool rides along in the cached prefix and costs cache-read tokens on each request.
        If one of these comes from an MCP server or tool set you don't use, disabling it shrinks every request from here on.
        This is based only on your logged chats this month — if you do use one again, it drops off this list automatically.
      </p>
    </div>`;
}

function renderToolInventory(inv: ToolInventory): string {
  if (!inv.hasData || inv.unused.length === 0) {
    return '';
  }
  const items = inv.unused.map((n) => `<li><code>${escapeHtml(n)}</code></li>`).join('');
  return `
    <details class="tools-inv card-flag">
      <summary>🧹 ${inv.unused.length} tool${inv.unused.length === 1 ? '' : 's'} defined but never called
        <span class="muted small">(dead weight in every cached request)</span></summary>
      <p class="muted small">These tools are offered to the model on every request — so they sit in your cached
        prefix and cost cache-read tokens each turn — but were never invoked in the logged period. If they come
        from an MCP server or tool set you don't use, disabling it shrinks every request from here on.</p>
      <ul class="tool-list">${items}</ul>
    </details>`;
}

function renderSummary(
  summary: Summary,
  efficiency: EfficiencyScore,
  inventory: ToolInventory,
  config: CoachConfig
): string {
  const priciest = summary.priciestMessage;
  const priciestText = priciest
    ? `${escapeHtml(formatCost(priciest.totalCostNanoAiu))} <span class="muted" title="${
        priciest.userMessage ? escapeHtml(priciest.userMessage) : ''
      }">(${escapeHtml(truncate(priciest.userMessage ?? '—', 28))})</span>`
    : '—';
  // Order: money first (month, today), then health (efficiency, cache),
  // then volume (activity), then waste signals (tools, priciest, flagged).
  return `
    <div class="cards">
      ${renderUsedCard(summary, config)}
      ${renderTodayCard(summary, config)}
      ${renderEfficiencyCard(efficiency)}
      <div class="card">
        <div class="card-label">Cache hit rate</div>
        <div class="card-value">${escapeHtml(formatPercent(summary.aggregateCacheHitRate))}</div>
        <div class="card-sub muted">cached input is ~80% cheaper</div>
      </div>
      ${renderTokenMixCard(summary)}
      <div class="card">
        <div class="card-label">Activity</div>
        <div class="card-value">${summary.chatCount.toLocaleString()} <span class="muted score-of">chat${summary.chatCount === 1 ? '' : 's'}</span></div>
        <div class="card-sub muted">${summary.messageCount.toLocaleString()} messages · ${summary.totalRequests.toLocaleString()} requests</div>
      </div>
      ${renderToolCard(inventory)}
      <div class="card">
        <div class="card-label">Priciest message</div>
        <div class="card-value">${priciestText}</div>
      </div>
      <div class="card ${summary.flaggedMessages > 0 ? 'card-flag' : ''}">
        <div class="card-label">Flagged messages</div>
        <div class="card-value">${summary.flaggedMessages.toLocaleString()}</div>
        <div class="card-sub muted">${summary.flaggedMessages > 0 ? 'expand a flagged row for advice' : 'no waste signals'}</div>
      </div>
    </div>`;
}

/** Extension version, shown in the toolbar so you can confirm which build is live. */
let extensionVersion = '';
export function setExtensionVersion(v: string): void {
  extensionVersion = v;
}

function renderHtml(
  webview: vscode.Webview,
  data: ParsedData,
  config: CoachConfig,
  history: DailySnapshot[],
  nonce: string,
  openState: Map<string, boolean>
): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const chats = groupByChat(data);
  const summary = buildSummary(chats, config);
  const efficiency = computeEfficiencyFromChats(chats, config);
  const inventory = analyzeToolInventory(data);
  const unusedTrend = analyzeUnusedToolTrend(data, config.unusedToolMinChats);

  const MAX_CHATS = 100;
  const shown = chats.slice(0, MAX_CHATS);

  const body =
    chats.length === 0
      ? renderEmptyState()
      : `
        ${renderUnusedToolTrend(unusedTrend)}
        ${renderCoverage(summary)}
        ${renderSummary(summary, efficiency, inventory, config)}
        ${renderHistory(history)}
        ${renderTokenBreakdown(summary, config)}
        ${renderModelSpend(data, config)}
        ${renderToolInventory(inventory)}
        ${
          chats.length > MAX_CHATS
            ? `<p class="muted">Showing the ${MAX_CHATS} most recent of ${chats.length.toLocaleString()} chats.</p>`
            : ''
        }
        <div class="hint muted">Grouped by chat. Click a chat to see its messages; click a message for cost drivers (tools &amp; context) and a turn-by-turn breakdown.</div>
        <div class="chats">
          ${shown.map((c) => renderChat(c, config, openState)).join('')}
        </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Token Coach</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      /* Long unbreakable strings (file paths, tokens, model ids) must wrap, not
         push the layout wider than the panel. overflow-x guards anything missed. */
      overflow-wrap: anywhere;
      overflow-x: hidden;
    }
    *, *::before, *::after { box-sizing: border-box; }
    h1 { font-size: 1.3em; margin: 0; }
    .ver {
      font-size: 0.75em; padding: 2px 7px; border-radius: 10px; align-self: center;
      background: var(--vscode-badge-background, rgba(127,127,127,0.25));
      color: var(--vscode-badge-foreground, inherit); font-variant-numeric: tabular-nums;
    }
    .small { font-size: 0.85em; }
    .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .muted { color: var(--vscode-descriptionForeground); }
    .hint { margin: 8px 0 12px; font-size: 0.9em; }
    .coverage {
      display: flex; align-items: flex-start; gap: 8px; margin: 0 0 16px;
      padding: 10px 14px; border-radius: 6px; font-size: 0.9em; line-height: 1.45;
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 35%, transparent);
    }
    .coverage-icon { flex: 0 0 auto; }
    .coverage b { font-variant-numeric: tabular-nums; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer;
      font-family: inherit; font-size: inherit;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }

    /* Summary cards */
    .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
    .card {
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 6px; padding: 12px 16px; min-width: 130px;
    }
    .card-flag { border-color: var(--vscode-editorError-foreground); }
    .card-label { font-size: 0.8em; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
    .card-value { font-size: 1.4em; font-weight: 600; margin-top: 4px; }
    .card-sub { font-size: 0.8em; margin-top: 2px; }
    .card-budget { min-width: 220px; }
    .budget-of { font-size: 0.6em; font-weight: 400; }
    .budget-bar { height: 8px; border-radius: 4px; margin-top: 8px; overflow: hidden;
      background: var(--vscode-widget-border, rgba(127,127,127,0.25)); }
    .budget-fill { display: block; height: 100%;
      background: var(--vscode-charts-green, var(--vscode-progressBar-background)); }
    .budget-fill.over { background: var(--vscode-editorError-foreground); }

    /* Efficiency grade card */
    .card-eff .grade { font-weight: 800; font-size: 1.05em; }
    .card-eff .score-of { font-size: 0.6em; font-weight: 400; }
    .card-eff.grade-good .grade { color: var(--vscode-charts-green, #4ec9b0); }
    .card-eff.grade-mid .grade { color: var(--vscode-charts-yellow, #d7ba7d); }
    .card-eff.grade-bad .grade { color: var(--vscode-editorError-foreground); }
    .card-eff.grade-bad { border-color: var(--vscode-editorError-foreground); }

    /* Per-chat grade badge (in the chat header) */
    .grade-badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 1.5em; height: 1.5em; padding: 0 4px; border-radius: 4px;
      font-weight: 800; font-size: 0.85em; cursor: help;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.4));
    }
    .grade-badge.grade-good { color: var(--vscode-charts-green, #4ec9b0); border-color: color-mix(in srgb, var(--vscode-charts-green, #4ec9b0) 50%, transparent); }
    .grade-badge.grade-mid { color: var(--vscode-charts-yellow, #d7ba7d); border-color: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 50%, transparent); }
    .grade-badge.grade-bad { color: var(--vscode-editorError-foreground); border-color: color-mix(in srgb, var(--vscode-editorError-foreground) 50%, transparent); }

    /* Unused-tool trend banner (top of dashboard) */
    .unused-trend {
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 10%, transparent);
    }
    .unused-trend-head { font-size: 1.02em; }
    .unused-trend-list {
      list-style: none; margin: 10px 0 6px; padding: 0;
      display: flex; flex-wrap: wrap; gap: 6px 10px;
    }
    .unused-trend-list li {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      border-radius: 6px; padding: 3px 9px;
    }
    .unused-trend-note { margin: 6px 0 0; line-height: 1.5; }

    /* Tool inventory (structural waste) */
    .tools-inv {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
    }
    .tools-inv > summary { cursor: pointer; font-weight: 600; }
    .tool-list { columns: 2; gap: 24px; margin: 8px 0 2px; padding-left: 18px; }
    .tool-list li { margin: 2px 0; }

    /* Model spend table */
    .model-spend {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
    }
    .model-spend > summary { cursor: pointer; font-weight: 600; margin-bottom: 6px; }
    .tag-billed, .tag-included {
      font-size: 0.7em; text-transform: uppercase; letter-spacing: .03em;
      padding: 0 5px; border-radius: 3px; margin-left: 4px;
    }
    .tag-billed { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 22%, transparent); }
    .tag-included { background: color-mix(in srgb, var(--vscode-charts-green, #4ec9b0) 22%, transparent); }

    /* Efficiency trend */
    .history {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      border-radius: 8px; padding: 10px 14px; margin-bottom: 16px;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
    }
    .history > summary { cursor: pointer; font-weight: 600; margin-bottom: 8px; }
    .hist-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .hist-chip {
      display: inline-flex; flex-direction: column; align-items: center; cursor: help;
      min-width: 42px; padding: 4px 6px; border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35));
    }
    .hist-grade { font-weight: 800; }
    .hist-chip.grade-good .hist-grade { color: var(--vscode-charts-green, #4ec9b0); }
    .hist-chip.grade-mid .hist-grade { color: var(--vscode-charts-yellow, #d7ba7d); }
    .hist-chip.grade-bad .hist-grade { color: var(--vscode-editorError-foreground); }
    .hist-date { font-size: 0.75em; }

    /* Chat (session) groups */
    .chats { display: flex; flex-direction: column; gap: 14px; }
    .chat {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      border-radius: 8px;
      background: var(--vscode-sideBar-background, rgba(127,127,127,0.04));
    }
    .chat > summary { cursor: pointer; padding: 12px 14px; list-style: none; user-select: none; border-radius: 8px; }
    .chat > summary::-webkit-details-marker { display: none; }
    .chat-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .chat-icon { font-size: 1.05em; }
    .chat-title { font-size: 1.05em; font-weight: 700; flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
    .chat-cost { font-weight: 700; font-variant-numeric: tabular-nums; }
    .chat-usd { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--vscode-charts-green, #4ec9b0); }
    .chat-tokens { font-variant-numeric: tabular-nums; }
    .chat-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 0.85em; margin-top: 4px; }
    .chat-models { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .chat-body { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 8px; }
    .chat[open] > summary { border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2)); border-radius: 8px 8px 0 0; margin-bottom: 10px; }

    /* Message rows */
    .messages { display: flex; flex-direction: column; gap: 8px; }
    .msg {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.25));
      border-left-width: 4px; border-left-color: transparent;
      border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
    }
    .msg > summary { cursor: pointer; padding: 10px 12px; list-style: none; user-select: none; border-radius: 6px; }
    .msg > summary::-webkit-details-marker { display: none; }
    .msg-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .msg-cost { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 80px; }
    .msg-usd { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--vscode-charts-green, #4ec9b0); min-width: 56px; }
    .msg-tokens { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); min-width: 70px; }
    .msg-asked { font-weight: 600; flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
    .msg-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .chip {
      font-size: 0.8em; padding: 1px 7px; border-radius: 10px;
      background: var(--vscode-badge-background, rgba(127,127,127,0.2));
      color: var(--vscode-badge-foreground, inherit);
    }
    .chip-gap {
      cursor: help;
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 22%, transparent);
      color: var(--vscode-foreground);
    }
    .msg-models { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
    .badge {
      font-size: 0.78em; padding: 1px 7px; border-radius: 4px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.35));
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .badge-x { opacity: 0.7; }
    .msg-warnings { margin-top: 6px; }
    .msg-body { padding: 4px 12px 14px; }
    .section-title { font-weight: 600; margin: 14px 0 6px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2)); }

    /* Cost drivers */
    .drivers { display: flex; gap: 16px; flex-wrap: wrap; }
    .driver-col { flex: 1 1 320px; min-width: 280px; }
    .driver-head { font-size: 0.9em; margin-bottom: 4px; }
    table.mini { width: 100%; border-collapse: collapse; font-size: 0.85em; }
    table.mini th, table.mini td {
      text-align: left; padding: 3px 8px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.15)); vertical-align: middle;
      overflow-wrap: anywhere; word-break: break-word;
    }
    table.mini .num, table.mini th.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.mini tr.highlight td { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent); }
    table.mini tr.grp td {
      font-weight: 600; padding-top: 10px;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.07));
      border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
    }

    /* "Why it cost X" story rows */
    .story { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 6px; }
    .story-row {
      display: flex; align-items: baseline; gap: 10px;
      padding: 8px 12px; border-radius: 6px; line-height: 1.45;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.25));
    }
    .story-icon { flex: 0 0 auto; }
    .story-main { flex: 1 1 300px; min-width: 0; }
    .story-cost { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bar-cell { display: flex; align-items: center; gap: 6px; }
    .bar { flex: 1; height: 8px; border-radius: 4px; background: var(--vscode-widget-border, rgba(127,127,127,0.25)); overflow: hidden; min-width: 60px; }
    .bar-fill { display: block; height: 100%; background: var(--vscode-progressBar-background, var(--vscode-button-background)); }
    .bar-pct { min-width: 34px; text-align: right; font-size: 0.9em; }
    .info { cursor: help; opacity: 0.55; margin-left: 4px; font-size: 0.85em; }
    .info:hover { opacity: 1; }
    .tag-fixed {
      font-size: 0.7em; text-transform: uppercase; letter-spacing: .03em;
      margin-left: 6px; padding: 0 5px; border-radius: 3px; cursor: help;
      background: var(--vscode-badge-background, rgba(127,127,127,0.25));
      color: var(--vscode-badge-foreground, inherit); opacity: 0.8;
    }
    /* Tooltips: a single JS-positioned floating element (#tt), not a CSS
       ::after. An ::after tooltip is clipped by any overflow ancestor and by the
       panel's own edges, so long disclaimers got cut off near the bottom/right.
       A position:fixed element clamped to the viewport is always fully visible. */
    .tip { cursor: help; }
    #tt {
      position: fixed; left: 0; top: 0; z-index: 1000;
      max-width: min(380px, 92vw); padding: 8px 11px; border-radius: 6px;
      background: var(--vscode-editorHoverWidget-background, #252526);
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.4));
      box-shadow: 0 4px 14px rgba(0,0,0,0.5);
      font-size: 12px; font-weight: 400; line-height: 1.5;
      white-space: normal; text-transform: none; letter-spacing: normal;
      pointer-events: none; opacity: 0; transition: opacity 80ms ease;
    }
    #tt.show { opacity: 1; }
    .caption { margin: 6px 0 0; }
    .attach { margin-top: 8px; }
    .attach-title { font-size: 0.8em; text-transform: uppercase; letter-spacing: .04em; }
    .attach ul { margin: 4px 0 0; padding-left: 16px; }
    .attach li { margin: 1px 0; overflow-wrap: anywhere; }
    /* Absolute file paths are long and unspaced — break them anywhere so they
       wrap inside the list instead of leaking past the panel edge. */
    .file { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }

    /* Timeline */
    .timeline { margin-top: 4px; }
    .turn-head {
      font-size: 0.8em; text-transform: uppercase; letter-spacing: .05em;
      color: var(--vscode-descriptionForeground); margin: 10px 0 2px;
    }
    .turn-calls {
      text-transform: none; letter-spacing: normal; cursor: help;
      margin-left: 6px; padding: 0 6px; border-radius: 8px; font-size: 0.95em;
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 22%, transparent);
      color: var(--vscode-foreground);
    }
    .diag { font-weight: 400; color: var(--vscode-editorWarning-foreground); text-transform: none; letter-spacing: normal; }
    .item {
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      padding: 4px 6px; border-radius: 4px;
    }
    .item-tool { padding-left: 22px; opacity: 0.95; }
    .item-icon { width: 1.2em; }
    .item-main { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
    .item-stats { font-variant-numeric: tabular-nums; }
    .item-cost { font-variant-numeric: tabular-nums; min-width: 70px; text-align: right; }
    .item-warn { flex-basis: 100%; padding-left: 22px; }

    .warn { margin: 2px 0; }
    .warn-error { color: var(--vscode-editorError-foreground); }
    .warn-warning { color: var(--vscode-editorWarning-foreground); }
    .warn-info { color: var(--vscode-editorInfo-foreground, var(--vscode-descriptionForeground)); }
    .ok { color: var(--vscode-descriptionForeground); }

    /* Severity accents */
    .msg.lvl-error  { border-left-color: var(--vscode-editorError-foreground); }
    .msg.lvl-warning { border-left-color: var(--vscode-editorWarning-foreground); }
    .msg.lvl-info { border-left-color: var(--vscode-editorInfo-foreground, gray); }
    .item.lvl-error  { background: color-mix(in srgb, var(--vscode-editorError-foreground) 12%, transparent); }
    .item.lvl-warning { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); }

    .empty { max-width: 640px; line-height: 1.5; }
    code {
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
      padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace);
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>📊 Token Coach</h1>
    ${extensionVersion ? `<span class="ver">v${escapeHtml(extensionVersion)}</span>` : ''}
    <button id="refresh" title="Re-scan logs">↻ Refresh</button>
    <button id="export" title="Save a Markdown report">⤓ Export</button>
    <span class="muted">Usage in credits (1 credit = 1 AIU = $0.01). Context sizes are estimates (~4 chars ≈ 1 token).</span>
  </div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Floating tooltip: one fixed element positioned in JS so it can never be
    // clipped by an overflow ancestor or run off the panel edge (the old CSS
    // ::after tooltip got cut off near the bottom/right). Text is set via
    // textContent, so the data-tip value is shown verbatim and can't inject HTML.
    const tt = document.createElement('div');
    tt.id = 'tt';
    document.body.appendChild(tt);
    let tipEl = null;

    function showTip(target) {
      const text = target.getAttribute('data-tip');
      if (!text) { return; }
      tipEl = target;
      tt.textContent = text;
      tt.classList.add('show');
      const PAD = 8, GAP = 6;
      const r = target.getBoundingClientRect();
      const tw = tt.offsetWidth, th = tt.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      // Prefer below the target; flip above if it would overflow the bottom.
      let top = r.bottom + GAP;
      if (top + th > vh - PAD) {
        top = r.top - GAP - th >= PAD ? r.top - GAP - th : Math.max(PAD, vh - th - PAD);
      }
      // Left-align to the target, then clamp inside the viewport on both sides.
      let left = r.left;
      if (left + tw > vw - PAD) { left = vw - tw - PAD; }
      if (left < PAD) { left = PAD; }
      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
    }

    function hideTip() {
      tt.classList.remove('show');
      tipEl = null;
    }

    document.addEventListener('mouseover', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t && t !== tipEl) { showTip(t); }
    });
    document.addEventListener('mouseout', (e) => {
      if (!tipEl) { return; }
      const to = e.relatedTarget;
      const stillInside = to && to.closest && to.closest('[data-tip]') === tipEl;
      if (!stillInside) { hideTip(); }
    });
    // The tooltip is positioned against the viewport, so any scroll makes it
    // stale — hide it rather than let it drift away from its anchor.
    window.addEventListener('scroll', hideTip, { passive: true, capture: true });

    const btn = document.getElementById('refresh');
    if (btn) {
      btn.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    }
    const exportBtn = document.getElementById('export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => vscode.postMessage({ command: 'export' }));
    }

    // Report expand/collapse (chats and messages) so the extension keeps them as
    // they were across refreshes. ('toggle' doesn't bubble, so attach to each.)
    document.querySelectorAll('details[data-id]').forEach((d) => {
      d.addEventListener('toggle', () => {
        vscode.postMessage({ command: 'toggle', id: d.dataset.id, open: d.open });
      });
    });

    // A refresh replaces the whole DOM; restore the scroll position so the view
    // doesn't jump to the top each time.
    const state = vscode.getState() || {};
    if (state.scrollY) {
      window.scrollTo(0, state.scrollY);
    }
    let scrollTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        vscode.setState({ ...(vscode.getState() || {}), scrollY: window.scrollY });
      }, 150);
    }, { passive: true });
  </script>
</body>
</html>`;
}

/** Generate a cryptographically random CSP nonce. */
function makeNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Panel singleton
// ---------------------------------------------------------------------------

export class DashboardPanel {
  public static current: DashboardPanel | undefined;
  private static readonly viewType = 'tokenCoach.dashboard';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Explicit expand/collapse state per element id (chats and messages), kept in
   * the extension host (not the webview DOM) so it survives the full re-render
   * that every refresh performs. Absent id ⇒ use the element's default (chats
   * open, messages collapsed).
   */
  private readonly openState = new Map<string, boolean>();

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly onRefreshRequested: () => void
  ) {
    this.panel = panel;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message?.command === 'refresh') {
          this.onRefreshRequested();
        } else if (message?.command === 'export') {
          void vscode.commands.executeCommand('tokenCoach.exportReport');
        } else if (message?.command === 'toggle' && typeof message.id === 'string') {
          // Remember expand/collapse so a refresh keeps chats/messages as they were.
          this.openState.set(message.id, !!message.open);
        }
      },
      null,
      this.disposables
    );
  }

  /** Create the panel if needed, otherwise reveal the existing one. */
  static createOrShow(
    data: ParsedData,
    config: CoachConfig,
    onRefreshRequested: () => void,
    history: DailySnapshot[] = []
  ): DashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      DashboardPanel.current.update(data, config, history);
      return DashboardPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Token Coach',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.current = new DashboardPanel(panel, onRefreshRequested);
    DashboardPanel.current.update(data, config, history);
    return DashboardPanel.current;
  }

  /** Re-render with fresh data. Safe to call when the panel is hidden. */
  update(data: ParsedData, config: CoachConfig, history: DailySnapshot[] = []): void {
    // Surface "how much you've used" in the editor tab title (no token count).
    let cost = 0;
    for (const r of data.requests) {
      cost += r.costNanoAiu;
    }
    this.panel.title =
      config.usdPerAiu > 0
        ? `Token Coach · ${formatUsd(cost, config.usdPerAiu)} · ${formatCredits(cost)}`
        : `Token Coach · ${formatCredits(cost)}`;

    const nonce = makeNonce();
    this.panel.webview.html = renderHtml(this.panel.webview, data, config, history, nonce, this.openState);
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
