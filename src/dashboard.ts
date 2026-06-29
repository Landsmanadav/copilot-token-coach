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
import {
  CHART,
  SEMANTIC,
  columns,
  ring,
  donut,
  segmentedBar,
  rankedBars,
  lineChart,
  type ColumnSeries,
} from './charts';

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
// Daily spend series — drives the "spend over the month" column chart and the
// "Used" card sparkline. Built straight from the (month-scoped) requests on
// disk: each request's REAL logged cost, split into fresh / cached / output via
// the same splitCost() the rest of the dashboard uses (the three parts sum back
// to the exact logged total). Idle days are filled with zeros so the chart shows
// the true day-to-day cadence, not a compressed list of active days only.
// ---------------------------------------------------------------------------

interface DaySpend {
  /** Local `YYYY-MM-DD`. */
  dayKey: string;
  /** Start-of-day timestamp (for sorting + axis labels). */
  ts: number;
  fresh: number;
  cached: number;
  output: number;
  /** Exact logged total for the day (== fresh + cached + output, by construction). */
  total: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Bucket the month's requests into per-day spend, split fresh/cached/output.
 * Fills every calendar day from the 1st of the month through today so idle days
 * render as gaps (honest cadence), even if logging only started mid-month.
 */
function buildDailySpend(data: ParsedData, config: CoachConfig): DaySpend[] {
  const byDay = new Map<string, DaySpend>();
  for (const r of data.requests) {
    if (r.timestamp <= 0) {
      continue;
    }
    const key = dayKeyOf(r.timestamp);
    const part = splitCost(
      r.costNanoAiu,
      r.inputTokens - r.cachedTokens,
      r.cachedTokens,
      r.outputTokens,
      config
    );
    const e =
      byDay.get(key) ??
      { dayKey: key, ts: startOfDay(r.timestamp), fresh: 0, cached: 0, output: 0, total: 0 };
    e.fresh += part.input;
    e.cached += part.cached;
    e.output += part.output;
    e.total += r.costNanoAiu;
    byDay.set(key, e);
  }
  if (byDay.size === 0) {
    return [];
  }
  // Fill the month-to-date axis: 1st of the current month → today (local).
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const days: DaySpend[] = [];
  for (let d = new Date(monthStart); d <= now; d.setDate(d.getDate() + 1)) {
    const ts = startOfDay(d.getTime());
    const key = dayKeyOf(ts);
    days.push(byDay.get(key) ?? { dayKey: key, ts, fresh: 0, cached: 0, output: 0, total: 0 });
  }
  return days;
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

function renderChat(
  chat: ChatGroup,
  config: CoachConfig,
  openState: Map<string, boolean>,
  maxChatCost: number
): string {
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
        <div class="chat-bar tip" data-tip="${escapeHtml(
          `This chat is ${formatCost(chat.totalCostNanoAiu)}${
            maxChatCost > 0 ? ` — ${Math.round((chat.totalCostNanoAiu / maxChatCost) * 100)}% of your priciest chat this month` : ''
          }.`
        )}"><span class="chat-bar-fill" style="width:${
          maxChatCost > 0 ? Math.round((chat.totalCostNanoAiu / maxChatCost) * 100) : 0
        }%"></span></div>
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

// ---- Day grouping --------------------------------------------------------

/** Day-section heading: "Today", "Yesterday", or a full local date. */
function dayHeading(dayKey: string, ts: number): string {
  const now = new Date();
  const todayKey = dayKeyOf(now.getTime());
  // A timestamp one millisecond before today's midnight lands in yesterday.
  const yesterdayKey = dayKeyOf(startOfDay(now.getTime()) - 1);
  if (dayKey === todayKey) {
    return 'Today';
  }
  if (dayKey === yesterdayKey) {
    return 'Yesterday';
  }
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Render the chat list grouped into collapsible day sections (newest first).
 * Today's section is open by default so the panel opens on what's current; older
 * days collapse to a one-line header you can click to expand. The open/closed
 * choice is remembered across refreshes via openState (keyed `day:<YYYY-MM-DD>`),
 * exactly like chats and messages.
 */
function renderChatsByDay(
  chats: ChatGroup[],
  config: CoachConfig,
  openState: Map<string, boolean>,
  maxChatCost: number
): string {
  // Chats arrive newest-first, so a single pass keeps each day contiguous and in
  // order. Group by the local day of each chat's last activity.
  interface DayBucket {
    key: string;
    ts: number;
    chats: ChatGroup[];
    cost: number;
  }
  const days: DayBucket[] = [];
  for (const chat of chats) {
    const key = dayKeyOf(chat.lastTime);
    let bucket = days.length ? days[days.length - 1] : undefined;
    if (!bucket || bucket.key !== key) {
      bucket = { key, ts: startOfDay(chat.lastTime), chats: [], cost: 0 };
      days.push(bucket);
    }
    bucket.chats.push(chat);
    bucket.cost += chat.totalCostNanoAiu;
  }

  const todayKey = dayKeyOf(new Date().getTime());
  return days
    .map((d) => {
      const id = `day:${d.key}`;
      const isToday = d.key === todayKey;
      const isOpen = openState.has(id) ? openState.get(id)! : isToday;
      const n = d.chats.length;
      const usd =
        config.usdPerAiu > 0
          ? ` <span class="day-usd">${escapeHtml(formatUsd(d.cost, config.usdPerAiu))}</span>`
          : '';
      return `
        <details class="day" data-id="${escapeHtml(id)}"${isOpen ? ' open' : ''}>
          <summary>
            <span class="day-title">${escapeHtml(dayHeading(d.key, d.ts))}</span>
            <span class="day-count muted">${n} chat${n === 1 ? '' : 's'}</span>
            <span class="day-cost">${escapeHtml(formatCost(d.cost))}${usd}</span>
          </summary>
          <div class="day-body">
            ${d.chats.map((c) => renderChat(c, config, openState, maxChatCost)).join('')}
          </div>
        </details>`;
    })
    .join('');
}

/**
 * Onboarding empty state. Two flavours:
 *   • logging OFF → a one-click "Enable logging" button (the extension writes the
 *     two Copilot settings for you) — exactly what a brand-new user needs the
 *     first time, no copy-pasting setting ids.
 *   • logging ON but no data yet → "use Copilot, then Refresh".
 */
function renderEmptyState(loggingEnabled: boolean): string {
  if (!loggingEnabled) {
    return `
    <div class="empty">
      <div class="empty-icon">📊</div>
      <h2>Let’s turn on Copilot’s usage logging</h2>
      <p>Token Coach reads GitHub Copilot’s local debug logs to show exactly where your credits go — but
        Copilot doesn’t write those logs until you switch them on. One click does it (it just flips two
        VS Code settings; nothing leaves your machine):</p>
      <p class="empty-actions">
        <button id="enableLogging" class="primary">⚡ Enable Copilot logging</button>
        <button id="emptySettings" class="ghost">⚙ Settings</button>
      </p>
      <p class="muted small">Then use Copilot Chat a few times and the dashboard fills in automatically.
        Prefer to do it by hand? Set
        <code>github.copilot.chat.agentDebugLog.enabled</code> and
        <code>github.copilot.chat.agentDebugLog.fileLogging.enabled</code> to <code>true</code>.</p>
    </div>`;
  }
  return `
    <div class="empty">
      <div class="empty-icon">✅</div>
      <h2>Logging is on — no usage logged this month yet</h2>
      <p>Token Coach shows the current calendar month only — it starts fresh on the 1st, like GitHub’s
        credit meter. Use Copilot Chat a few times, then refresh to see your spend, cache reuse, and
        where the tokens go.</p>
      <p class="empty-actions">
        <button id="emptyRefresh" class="primary">↻ Refresh</button>
        <button id="emptySettings" class="ghost">⚙ Settings</button>
      </p>
      <p class="muted small">Logs are written under
        <code>workspaceStorage/…/GitHub.copilot-chat/debug-logs/&lt;session&gt;/main.jsonl</code>.</p>
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
function renderUsedCard(summary: Summary, config: CoachConfig, daily: DaySpend[]): string {
  const showUsd = config.usdPerAiu > 0;
  const monthRange = formatMonthToDateRange();
  const fmtNano = (nano: number) => (showUsd ? formatUsd(nano, config.usdPerAiu) : formatCost(nano));
  // Daily spend trend under the headline — the "is this a spike or steady?" read.
  // Interactive: hover anywhere to read off that day's spend.
  const maxDay = Math.max(...daily.map((d) => d.total / 1e9), 0);
  const spark =
    daily.length >= 2
      ? `<div class="card-spark">${lineChart(
          daily.map((d) => ({
            label: formatDateShort(d.ts),
            value: d.total / 1e9,
            tip: `${formatDateShort(d.ts)} · ${fmtNano(d.total)}`,
          })),
          { height: 54, min: 0, max: maxDay || 1, lineColor: CHART.blue, bare: true }
        )}</div>`
      : '';
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
    <div class="card card-budget card-wide card-hero">
      <div class="card-label">Used · this month <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value">${escapeHtml(value)}</div>
      <div class="card-sub muted">${escapeHtml(formatCredits(summary.totalCostNanoAiu))} · ${escapeHtml(monthRange)}</div>
      ${spark}
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
  const col =
    eff.score >= 75 ? CHART.green : eff.score >= 50 ? CHART.yellow : CHART.red;
  return `
    <div class="card card-eff ${gradeClass(eff.score)}">
      <div class="card-label">Efficiency <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-ringrow">
        ${ring(eff.score / 100, { label: eff.grade, sub: `${eff.score}`, color: col, size: 76, thickness: 8 })}
        <div class="card-ringtext">
          <div class="card-sub muted">Cache reuse ${eff.cacheScore}</div>
          <div class="card-sub muted">Clean ${eff.cleanScore} <span class="muted">(${eff.cleanMessages}/${eff.messageCount})</span></div>
        </div>
      </div>
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
  const mixBar = segmentedBar(
    [
      { label: 'Fresh', value: fresh, color: SEMANTIC.fresh, tip: `Fresh input — ${formatTokens(fresh)} tok, billed full price` },
      { label: 'Cached', value: cached, color: SEMANTIC.cached, tip: `Cached input — ${formatTokens(cached)} tok, ~80% cheaper` },
      { label: 'Output', value: output, color: SEMANTIC.output, tip: `Output — ${formatTokens(output)} tok generated` },
    ],
    { legend: false }
  );
  return `
    <div class="card card-wide">
      <div class="card-label">Token mix <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value">${inputPct}% <span class="muted score-of">in</span> · ${outputPct}% <span class="muted score-of">out</span></div>
      <div class="card-mixbar">${mixBar}</div>
      <div class="card-sub muted">in: ${escapeHtml(formatTokensCompact(fresh))} fresh + ${escapeHtml(
        formatTokensCompact(cached)
      )} cached · out: ${escapeHtml(formatTokensCompact(output))}</div>
    </div>`;
}

/** Colour for an efficiency score, matching the A–F grade bands. */
function scoreColor(score: number): string {
  return score >= 75 ? CHART.green : score >= 50 ? CHART.yellow : CHART.red;
}

/**
 * Daily efficiency trend as an INTERACTIVE line chart: a fixed 0–100 scale with
 * grade-band tints (so the height means something), dots coloured by grade, and
 * a crosshair + tooltip that follows the mouse to read off any day's detail.
 * The fixed scale is deliberate — auto-scaling made a few-point change look like
 * a cliff; on 0–100 the line sits where it honestly is.
 */
function renderHistory(history: DailySnapshot[]): string {
  if (history.length < 2) {
    return ''; // need at least two days to call it a trend
  }
  const recent = history.slice(-14);
  const points = recent.map((h) => ({
    label: h.date.slice(5),
    value: h.score,
    dotColor: scoreColor(h.score),
    tip: `${h.date} · grade ${h.grade} · ${h.score}/100 · month ${formatCost(
      h.monthCostNanoAiu
    )} · ${formatTokensCompact(h.totalTokens)} tok`,
  }));
  const lastColor = scoreColor(recent[recent.length - 1].score);
  const chart = lineChart(points, {
    height: 150,
    min: 0,
    max: 100,
    lineColor: lastColor,
    gridAt: [50, 75],
    bands: [
      { from: 0, to: 50, color: 'color-mix(in srgb, var(--vscode-charts-red, #f14c4c) 9%, transparent)' },
      { from: 50, to: 75, color: 'color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 9%, transparent)' },
      { from: 75, to: 100, color: 'color-mix(in srgb, var(--vscode-charts-green, #4ec9b0) 9%, transparent)' },
    ],
  });
  return `
    <details class="history" open>
      <summary>📈 Efficiency trend <span class="muted small">(score 0–100 per day — hover the chart for that day’s detail)</span></summary>
      <div class="hist-bands muted small">
        <span class="hist-band-key"><span class="hist-band-dot" style="background:var(--vscode-charts-green,#4ec9b0)"></span>75–100 (A)</span>
        <span class="hist-band-key"><span class="hist-band-dot" style="background:var(--vscode-charts-yellow,#d7ba7d)"></span>50–74 (B–C)</span>
        <span class="hist-band-key"><span class="hist-band-dot" style="background:var(--vscode-charts-red,#f14c4c)"></span>below 50 (D–F)</span>
      </div>
      ${chart}
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
  const tokDonut = donut(
    [
      { label: 'Fresh input', value: fresh, color: SEMANTIC.fresh, tip: `Fresh input — ${formatTokens(fresh)} tok (full price)` },
      { label: 'Cached input', value: cached, color: SEMANTIC.cached, tip: `Cached input — ${formatTokens(cached)} tok (~80% cheaper)` },
      { label: 'Output', value: output, color: SEMANTIC.output, tip: `Output — ${formatTokens(output)} tok` },
    ],
    { label: formatTokensCompact(tokenTotal), sub: 'tokens' }
  );
  const donutLegend = [
    { label: 'Fresh input', color: SEMANTIC.fresh, tokens: fresh },
    { label: 'Cached input', color: SEMANTIC.cached, tokens: cached },
    { label: 'Output', color: SEMANTIC.output, tokens: output },
  ]
    .map(
      (s) =>
        `<span class="segbar-key"><span class="segbar-dot" style="background:${s.color}"></span>${s.label} <span class="muted">${escapeHtml(
          formatTokensCompact(s.tokens)
        )}</span></span>`
    )
    .join('');
  return `
    <details class="model-spend" open>
      <summary>🔬 Token &amp; cost breakdown
        <span class="muted small">(input ${inputPct}% / output ${100 - inputPct}% · per-bucket AIU is an estimate <span class="tip info" data-tip="${escapeHtml(
          help
        )}">ⓘ</span>)</span></summary>
      <div class="breakdown-row">
        <div class="breakdown-viz">${tokDonut}<div class="segbar-legend">${donutLegend}</div></div>
        <table class="mini">
          <thead><tr><th>Bucket</th><th class="num">Tokens</th><th class="num">Token share</th><th class="num">AIU (est.)</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </details>`;
}

/**
 * "Spend over the month" — the headline column chart: daily credits, each day's
 * column split into fresh / cached / output. The single most useful view a cost
 * dashboard can open with (are you spiking or steady?). Idle days show as gaps.
 */
function renderSpendChart(daily: DaySpend[], config: CoachConfig): string {
  const active = daily.filter((d) => d.total > 0);
  if (active.length < 1) {
    return '';
  }
  const series: ColumnSeries[] = [
    { key: 'fresh', label: 'Fresh input', color: SEMANTIC.fresh },
    { key: 'cached', label: 'Cached input', color: SEMANTIC.cached },
    { key: 'output', label: 'Output', color: SEMANTIC.output },
  ];
  const showUsd = config.usdPerAiu > 0;
  const fmt = (nano: number) => (showUsd ? formatUsd(nano, config.usdPerAiu) : formatCost(nano));
  const bars = daily.map((d) => ({
    values: [d.fresh, d.cached, d.output],
    tip:
      d.total > 0
        ? `${formatDateShort(d.ts)} — ${fmt(d.total)} · fresh ${formatCost(d.fresh)} / cached ${formatCost(
            d.cached
          )} / output ${formatCost(d.output)}`
        : `${formatDateShort(d.ts)} — no logged usage`,
  }));
  const total = daily.reduce((s, d) => s + d.total, 0);
  const peak = active.reduce((m, d) => (d.total > m.total ? d : m), active[0]);
  const first = daily[0];
  const last = daily[daily.length - 1];
  const legend = series
    .map(
      (s) =>
        `<span class="segbar-key"><span class="segbar-dot" style="background:${s.color}"></span>${escapeHtml(
          s.label
        )}</span>`
    )
    .join('');
  return `
    <div class="panel panel-chart">
      <div class="panel-head">
        <span class="panel-title">💵 Spend over the month</span>
        <span class="panel-legend">${legend}</span>
      </div>
      <div class="chart-body">${columns(bars, series, { height: 150 })}</div>
      <div class="chart-axis muted">
        <span>${escapeHtml(formatDateShort(first.ts))}</span>
        <span class="chart-axis-mid tip" data-tip="${escapeHtml(
          `Highest-spend day this month: ${formatDateShort(peak.ts)} at ${fmt(peak.total)}.`
        )}">▲ peak ${escapeHtml(fmt(peak.total))}</span>
        <span>${escapeHtml(formatDateShort(last.ts))}</span>
      </div>
      <div class="panel-foot muted">${escapeHtml(fmt(total))} total this month · ${active.length} active day${
        active.length === 1 ? '' : 's'
      }</div>
    </div>`;
}

/** "Spend by model" — the overview ranked bars (detail lives in the table below). */
function renderModelBars(data: ParsedData, config: CoachConfig): string {
  const rows = buildModelSpend(data, config);
  if (rows.length === 0) {
    return '';
  }
  const showUsd = config.usdPerAiu > 0;
  const top = rows.slice(0, 7);
  const bars = top.map((r) => {
    const billed = r.cost > 0;
    const usd = showUsd ? ` <span class="muted">(${escapeHtml(formatUsd(r.cost, config.usdPerAiu))})</span>` : '';
    const tag = billed
      ? '<span class="tag-billed">billed</span>'
      : '<span class="tag-included">included</span>';
    return {
      labelHtml: `<span class="badge">${escapeHtml(r.model)}</span> ${tag}`,
      value: r.cost,
      valueHtml: `${escapeHtml(formatCost(r.cost))}${usd}`,
      color: billed ? CHART.blue : CHART.green,
      tip: `${r.requests.toLocaleString()} request${r.requests === 1 ? '' : 's'} · ${formatTokensCompact(
        r.tokens
      )} tokens · ${formatCost(r.cost)}`,
    };
  });
  const more =
    rows.length > top.length
      ? `<div class="panel-foot muted">+${rows.length - top.length} more model${
          rows.length - top.length === 1 ? '' : 's'
        } — full detail in the table below</div>`
      : '';
  return `
    <div class="panel panel-chart">
      <div class="panel-head"><span class="panel-title">💸 Spend by model</span></div>
      ${rankedBars(bars)}
      ${more}
    </div>`;
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
  config: CoachConfig,
  daily: DaySpend[]
): string {
  const priciest = summary.priciestMessage;
  const priciestText = priciest
    ? `${escapeHtml(formatCost(priciest.totalCostNanoAiu))} <span class="muted" title="${
        priciest.userMessage ? escapeHtml(priciest.userMessage) : ''
      }">(${escapeHtml(truncate(priciest.userMessage ?? '—', 28))})</span>`
    : '—';
  // Cache ring: higher reuse is better, so it warms green as it climbs.
  const cacheRate = summary.aggregateCacheHitRate;
  const cacheCol = cacheRate >= 0.6 ? CHART.green : cacheRate >= 0.3 ? CHART.yellow : CHART.red;
  // Order: money first (month, today), then health (efficiency, cache),
  // then volume (activity), then waste signals (tools, priciest, flagged).
  return `
    <div class="cards kpi-grid">
      ${renderUsedCard(summary, config, daily)}
      ${renderTodayCard(summary, config)}
      ${renderEfficiencyCard(efficiency)}
      <div class="card">
        <div class="card-label">Cache hit rate</div>
        <div class="card-ringrow">
          ${ring(cacheRate, { label: formatPercent(cacheRate), color: cacheCol, size: 76, thickness: 8 })}
          <div class="card-ringtext"><div class="card-sub muted">cached input is<br/>~80% cheaper</div></div>
        </div>
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
  openState: Map<string, boolean>,
  loggingEnabled: boolean
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
  const daily = buildDailySpend(data, config);

  const MAX_CHATS = 100;
  const shown = chats.slice(0, MAX_CHATS);

  const body =
    chats.length === 0
      ? renderEmptyState(loggingEnabled)
      : `
        ${renderUnusedToolTrend(unusedTrend)}
        ${renderCoverage(summary)}
        ${renderSummary(summary, efficiency, inventory, config, daily)}
        <div class="chart-row">
          ${renderSpendChart(daily, config)}
          ${renderModelBars(data, config)}
        </div>
        ${renderHistory(history)}
        ${renderTokenBreakdown(summary, config)}
        ${renderModelSpend(data, config)}
        ${renderToolInventory(inventory)}
        ${
          chats.length > MAX_CHATS
            ? `<p class="muted">Showing the ${MAX_CHATS} most recent of ${chats.length.toLocaleString()} chats.</p>`
            : ''
        }
        <div class="hint muted">Grouped by day, then by chat — today is open, older days are collapsed (click a day to expand it). Click a chat to see its messages; click a message for cost drivers (tools &amp; context) and a turn-by-turn breakdown.</div>
        <div class="chats">
          ${(() => {
            const maxChatCost = Math.max(...shown.map((c) => c.totalCostNanoAiu), 1);
            return renderChatsByDay(shown, config, openState, maxChatCost);
          })()}
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
    .chats { display: flex; flex-direction: column; gap: 18px; }

    /* Day sections: a collapsible header per calendar day (today open by default) */
    .day { border: 0; }
    .day > summary {
      cursor: pointer; list-style: none; user-select: none;
      display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      padding: 6px 2px 8px; margin: 0;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
    }
    .day > summary::-webkit-details-marker { display: none; }
    .day > summary::before {
      content: '▸'; display: inline-block; flex: 0 0 auto;
      color: var(--vscode-descriptionForeground); transition: transform 0.12s ease;
    }
    .day[open] > summary::before { transform: rotate(90deg); }
    .day-title { font-size: 1.08em; font-weight: 700; }
    .day-count { font-size: 0.85em; font-weight: 400; }
    .day-cost { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; }
    .day-usd { font-weight: 600; color: var(--vscode-charts-green, #4ec9b0); }
    .day-body { display: flex; flex-direction: column; gap: 14px; padding: 12px 0 4px; }

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

    /* ===================================================================== */
    /* Observability chart kit (charts.ts) — dense KPI grid + chart panels.   */
    /* ===================================================================== */

    /* KPI grid: cards on a real grid so tiles align in clean rows/columns. */
    .cards.kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 12px; align-items: stretch;
    }
    .kpi-grid .card { display: flex; flex-direction: column; min-width: 0; }
    .kpi-grid .card-budget { min-width: 0; }
    .card-wide { grid-column: span 2; }
    .card-hero .card-value { font-size: 1.95em; }
    .card-spark { margin-top: 10px; }
    .card-mixbar { margin-top: 10px; }
    .card-ringrow { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
    .card-ringtext { display: flex; flex-direction: column; gap: 2px; min-width: 0; line-height: 1.35; }
    @media (max-width: 520px) { .card-wide { grid-column: span 1; } }

    /* SVG primitives */
    .spark { display: block; width: 100%; }
    .ring, .donut { flex: 0 0 auto; display: block; }
    .ring-label { fill: var(--vscode-foreground); font-weight: 800; font-size: 19px;
      font-variant-numeric: tabular-nums; font-family: var(--vscode-font-family); }
    .ring-sub { fill: var(--vscode-descriptionForeground); font-size: 9px;
      text-transform: uppercase; letter-spacing: .04em; font-family: var(--vscode-font-family); }
    .donut .ring-label { font-size: 16px; }
    .cols .col-hit { cursor: help; transition: fill 80ms ease; }
    .cols .col-hit:hover { fill: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }

    /* Chart panels (the main + secondary rows) */
    .chart-row {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px; margin-bottom: 16px;
    }
    .panel {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
      border-radius: 8px; padding: 12px 14px;
      background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
      display: flex; flex-direction: column; min-width: 0;
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .panel-title { font-weight: 600; }
    .panel-legend { display: flex; gap: 10px 14px; flex-wrap: wrap; font-size: 0.8em; }
    .panel-foot { font-size: 0.8em; margin-top: 8px; }
    .chart-body { width: 100%; }
    .chart-axis { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.75em; margin-top: 4px; gap: 8px; }
    .chart-axis-mid { font-variant-numeric: tabular-nums; cursor: help; }

    /* Ranked horizontal bars (model spend overview) */
    .ranked { display: flex; flex-direction: column; gap: 9px; }
    .ranked-row { display: grid; grid-template-columns: minmax(110px, 1.3fr) 2fr minmax(70px, auto); align-items: center; gap: 10px; }
    .ranked-label { min-width: 0; overflow-wrap: anywhere; font-size: 0.9em; }
    .ranked-track { height: 10px; border-radius: 5px; overflow: hidden;
      background: var(--vscode-widget-border, rgba(127,127,127,0.22)); }
    .ranked-fill { display: block; height: 100%; border-radius: 5px; }
    .ranked-value { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 0.88em; }

    /* 100%-segmented bar (token mix / context split) */
    .segbar-wrap { width: 100%; }
    .segbar { display: flex; height: 12px; border-radius: 6px; overflow: hidden;
      background: var(--vscode-widget-border, rgba(127,127,127,0.18)); }
    .segbar-part { display: block; height: 100%; }
    .segbar-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; font-size: 0.82em; }
    .segbar-key { display: inline-flex; align-items: center; gap: 5px; }
    .segbar-dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; flex: 0 0 auto; }

    /* Token & cost breakdown — donut beside the table */
    .breakdown-row { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
    .breakdown-viz { display: flex; flex-direction: column; align-items: center; gap: 8px; flex: 0 0 auto; }
    .breakdown-viz .segbar-legend { flex-direction: column; gap: 4px; }
    .breakdown-row table.mini { flex: 1 1 300px; }

    /* Efficiency trend area-line above the day chips */
    .hist-trend { margin-bottom: 12px; cursor: help; }

    /* Per-chat relative cost bar (which chats cost the most, at a glance) */
    .chat-bar { height: 4px; border-radius: 3px; margin-top: 8px; cursor: help;
      background: var(--vscode-widget-border, rgba(127,127,127,0.18)); overflow: hidden; }
    .chat-bar-fill { display: block; height: 100%; border-radius: 3px;
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 80%, transparent); }

    /* Interactive line chart (efficiency trend) — SVG plot + HTML dot overlay */
    .hist-bands { display: flex; gap: 14px; flex-wrap: wrap; margin: 2px 0 8px; }
    .hist-band-key { display: inline-flex; align-items: center; gap: 5px; }
    .hist-band-dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; opacity: 0.85; }
    .linechart-wrap { margin-top: 2px; }
    .linechart-plot { position: relative; width: 100%; cursor: crosshair; }
    .linechart-svg { display: block; width: 100%; border-radius: 4px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.18)); }
    .lc-dots { position: absolute; inset: 0; pointer-events: none; }
    /* HTML dots stay perfectly round regardless of the SVG's horizontal stretch. */
    .lc-dot { position: absolute; width: 7px; height: 7px; border-radius: 50%;
      transform: translate(-50%, -50%); border: 1.5px solid var(--vscode-editor-background); }
    .lc-cross { position: absolute; top: 0; bottom: 0; width: 1px; display: none;
      background: var(--vscode-charts-foreground, var(--vscode-foreground)); opacity: 0.4;
      pointer-events: none; transform: translateX(-0.5px); }
    .lc-hot { position: absolute; width: 11px; height: 11px; border-radius: 50%; display: none;
      transform: translate(-50%, -50%); pointer-events: none;
      box-shadow: 0 0 0 3px var(--vscode-editor-background); }
    .lc-hit { position: absolute; inset: 0; }
    .linechart-x { display: flex; justify-content: space-between; margin-top: 6px; font-size: 0.75em; gap: 4px; }
    .lc-xlabel { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* Bare "sparkline" mode for KPI cards: no chrome, just the interactive trend. */
    .linechart-wrap.bare .linechart-svg { border: none; border-radius: 0; }

    /* Onboarding: empty-state action buttons */
    .empty-icon { font-size: 2.4em; line-height: 1; margin-bottom: 6px; }
    .empty h2 { margin: 4px 0 10px; }
    .empty-actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
    button.primary {
      font-size: 1.02em; padding: 9px 16px; font-weight: 600;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.ghost {
      background: transparent; color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.45)); padding: 9px 16px;
    }
    button.ghost:hover { background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>📊 Token Coach</h1>
    ${extensionVersion ? `<span class="ver">v${escapeHtml(extensionVersion)}</span>` : ''}
    <button id="refresh" title="Re-scan logs">↻ Refresh</button>
    <button id="export" title="Save a Markdown report">⤓ Export</button>
    <button id="settings" title="Open Token Coach settings">⚙ Settings</button>
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

    // Interactive line charts: a crosshair + a tooltip that follows the mouse,
    // reading off the nearest day's detail. Point data is the data-pts JSON the
    // lineChart() helper emits (positions as %, plus colour + tip text).
    document.querySelectorAll('.linechart-plot').forEach((plot) => {
      let pts;
      try { pts = JSON.parse(plot.dataset.pts || '[]'); } catch (err) { pts = []; }
      if (!pts.length) { return; }
      const cross = plot.querySelector('.lc-cross');
      const hot = plot.querySelector('.lc-hot');
      const len = pts.length;

      function moveTo(clientX) {
        const rect = plot.getBoundingClientRect();
        if (!rect.width) { return; }
        let frac = (clientX - rect.left) / rect.width;
        frac = Math.max(0, Math.min(1, frac));
        const i = Math.round(frac * (len - 1));
        const p = pts[i];
        if (!p) { return; }
        if (cross) { cross.style.left = p.x + '%'; cross.style.display = 'block'; }
        if (hot) {
          hot.style.left = p.x + '%'; hot.style.top = p.y + '%';
          hot.style.background = p.c; hot.style.display = 'block';
        }
        tt.textContent = p.t;
        tt.classList.add('show');
        const PAD = 8, GAP = 12;
        const tw = tt.offsetWidth, th = tt.offsetHeight;
        const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        const px = rect.left + (p.x / 100) * rect.width;
        const py = rect.top + (p.y / 100) * rect.height;
        let top = py - GAP - th;
        if (top < PAD) { top = py + GAP; }
        if (top + th > vh - PAD) { top = Math.max(PAD, vh - th - PAD); }
        let left = px - tw / 2;
        if (left + tw > vw - PAD) { left = vw - tw - PAD; }
        if (left < PAD) { left = PAD; }
        tt.style.left = left + 'px';
        tt.style.top = top + 'px';
      }

      plot.addEventListener('mousemove', (e) => moveTo(e.clientX));
      plot.addEventListener('mouseleave', (e) => {
        if (cross) { cross.style.display = 'none'; }
        if (hot) { hot.style.display = 'none'; }
        const to = e.relatedTarget;
        if (!(to && to.closest && to.closest('[data-tip]'))) { hideTip(); }
      });
    });

    const btn = document.getElementById('refresh');
    if (btn) {
      btn.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    }
    const exportBtn = document.getElementById('export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => vscode.postMessage({ command: 'export' }));
    }
    // Onboarding + toolbar buttons. Each has a unique id so there's no
    // duplicate-id clash with the toolbar's Refresh.
    const wire = (id, command) => {
      const el = document.getElementById(id);
      if (el) { el.addEventListener('click', () => vscode.postMessage({ command })); }
    };
    wire('enableLogging', 'enableLogging');
    wire('emptyRefresh', 'refresh');
    wire('settings', 'openSettings');
    wire('emptySettings', 'openSettings');

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

  /** Whether Copilot debug logging is on — drives which empty state we show. */
  private loggingEnabled = true;

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
        } else if (message?.command === 'enableLogging') {
          void vscode.commands.executeCommand('tokenCoach.enableLogging');
        } else if (message?.command === 'openSettings') {
          void vscode.commands.executeCommand('tokenCoach.openSettings');
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
    history: DailySnapshot[] = [],
    loggingEnabled = true
  ): DashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      DashboardPanel.current.update(data, config, history, loggingEnabled);
      return DashboardPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Token Coach',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.current = new DashboardPanel(panel, onRefreshRequested);
    DashboardPanel.current.update(data, config, history, loggingEnabled);
    return DashboardPanel.current;
  }

  /** Re-render with fresh data. Safe to call when the panel is hidden. */
  update(data: ParsedData, config: CoachConfig, history: DailySnapshot[] = [], loggingEnabled = true): void {
    this.loggingEnabled = loggingEnabled;

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
    this.panel.webview.html = renderHtml(
      this.panel.webview,
      data,
      config,
      history,
      nonce,
      this.openState,
      this.loggingEnabled
    );
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
