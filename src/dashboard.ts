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
import {
  LlmRequestRecord,
  MessageGroup,
  ChatGroup,
  ToolCallRecord,
  ToolSummary,
  ContextSource,
  AttachmentInfo,
  ParsedData,
  groupByChat,
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

// ---------------------------------------------------------------------------
// Formatting helpers (exported so the status bar can reuse them).
// ---------------------------------------------------------------------------

/** 1e9 NanoAiu == 1 AIU. Display cost in AIU, which is far more readable. */
export function formatCost(nanoAiu: number): string {
  return `${(nanoAiu / 1e9).toFixed(2)} AIU`;
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

interface Summary {
  totalCostNanoAiu: number;
  monthCostNanoAiu: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  chatCount: number;
  messageCount: number;
  aggregateCacheHitRate: number;
  priciestMessage?: MessageGroup;
  flaggedMessages: number;
}

function buildSummary(chats: ChatGroup[], config: CoachConfig): Summary {
  let totalCost = 0;
  let monthCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalRequests = 0;
  let messageCount = 0;
  let flagged = 0;
  let priciest: MessageGroup | undefined;

  // Start of the current calendar month — the plan's credits reset monthly.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  for (const chat of chats) {
    for (const g of chat.messages) {
      messageCount++;
      totalCost += g.totalCostNanoAiu;
      if (g.startTime >= monthStart) {
        monthCost += g.totalCostNanoAiu;
      }
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
    }
  }

  return {
    totalCostNanoAiu: totalCost,
    monthCostNanoAiu: monthCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalRequests,
    chatCount: chats.length,
    messageCount,
    aggregateCacheHitRate: totalInput > 0 ? totalCached / totalInput : 0,
    priciestMessage: priciest,
    flaggedMessages: flagged,
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
    'JSON schemas for every tool the agent can call (read_file, edit, run, …). Fixed per request and usually cached — often the single largest chunk.',
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

/** "Open editors and stuff" — where the context came from, with share bars. */
function renderContextTable(sources: ContextSource[], attachments: AttachmentInfo[]): string {
  if (sources.length === 0) {
    return '<p class="muted small">No context breakdown available (older logs may not record it).</p>';
  }
  const total = sources.reduce((s, c) => s + c.chars, 0) || 1;
  const fixedKeys = new Set(['systemPrompt', 'tools']);
  let hasFixed = false;
  const rows = sources
    .map((c) => {
      const pct = Math.round((c.chars / total) * 100);
      const isAttach = c.key === 'attachments';
      const isFixed = fixedKeys.has(c.key);
      hasFixed = hasFixed || isFixed;
      const help = SOURCE_HELP[c.key] ?? '';
      return `
        <tr class="${isAttach ? 'highlight' : ''}">
          <td>
            <span class="src-label">${escapeHtml(c.label)}</span>
            ${isFixed ? '<span class="tip tip-left tag-fixed" data-tip="Fixed per request and usually cached — you can’t trim this.">cached</span>' : ''}
            ${help ? '<span class="tip tip-left info" data-tip="' + escapeHtml(help) + '">ⓘ</span>' : ''}
          </td>
          <td class="num">${escapeHtml(approxTokens(c.chars))}</td>
          <td class="bar-cell">
            <span class="bar"><span class="bar-fill" style="width:${pct}%"></span></span>
            <span class="bar-pct muted">${pct}%</span>
          </td>
        </tr>`;
    })
    .join('');

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
    `<p class="muted small caption">Estimated from logged context (~4 chars ≈ 1 token); hover a source for details.` +
    `${hasFixed ? ' “cached” items (system prompt, tool definitions) are fixed per request and you can’t trim them.' : ''}</p>`;

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
        <div class="driver-head">🔧 Tools taking the most</div>
        ${renderToolTable(group.toolSummary)}
      </div>
      <div class="driver-col">
        <div class="driver-head">📎 Where context came from <span class="muted small">(logged items; system prompt &amp; cached history not itemized)</span></div>
        ${renderContextTable(group.peakContext, group.peakAttachments)}
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

  return `
    <details class="chat" data-id="${escapeHtml(chat.sessionId)}"${isOpen ? ' open' : ''}>
      <summary>
        <div class="chat-head">
          <span class="chat-icon">🧵</span>
          <span class="chat-title" title="${escapeHtml(chat.title)}">${escapeHtml(truncate(chat.title, 70))}</span>
          <span class="chat-cost">${escapeHtml(formatCost(chat.totalCostNanoAiu))}</span>
          ${usd}
          <span class="chat-tokens muted">${escapeHtml(formatTokensCompact(chat.totalInputTokens + chat.totalOutputTokens))} tok</span>
        </div>
        <div class="chat-meta muted">
          <span>${escapeHtml(meta)}</span>
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
      <h2>No Copilot debug logs found yet</h2>
      <p>To collect data, enable both of these settings in VS Code, then use Copilot Chat a few times:</p>
      <ul>
        <li><code>github.copilot.chat.agentDebugLog.enabled</code> → <code>true</code></li>
        <li><code>github.copilot.chat.agentDebugLog.fileLogging.enabled</code> → <code>true</code></li>
      </ul>
      <p>Logs are written to your VS Code <code>workspaceStorage</code> under
        <code>GitHub.copilot-chat/debug-logs/&lt;session&gt;/main.jsonl</code>.</p>
      <p><button id="refresh">Refresh</button></p>
    </div>`;
}

/** "Plan budget" gauge: this month's estimated spend vs the plan's $ allowance. */
function renderBudgetCard(summary: Summary, config: CoachConfig): string {
  if (config.usdPerAiu <= 0 || config.planMonthlyUsd <= 0) {
    return '';
  }
  const monthUsd = (summary.monthCostNanoAiu / 1e9) * config.usdPerAiu;
  const plan = config.planMonthlyUsd;
  const pct = Math.min(100, Math.round((monthUsd / plan) * 100));
  const over = monthUsd > plan;
  const help =
    `Estimate — your GitHub billing page is the source of truth. We compute ` +
    `usage = copilotUsageNanoAiu × $${config.usdPerAiu} (1 AIU ≈ 1 AI credit ≈ $0.01) vs a ` +
    `$${plan.toFixed(0)}/month allowance. It can differ from GitHub's % because the real ` +
    `allowance may include a flex amount on top of the plan price, and some base-model usage ` +
    `isn't charged. To match GitHub exactly, calibrate: set planMonthlyUsd to your real monthly ` +
    `allowance, or scale usdPerAiu by (GitHub % ÷ this %).`;
  return `
    <div class="card card-budget ${over ? 'card-flag' : ''}">
      <div class="card-label">Plan budget · this month <span class="muted small">(est.)</span> <span class="tip info" data-tip="${escapeHtml(help)}">ⓘ</span></div>
      <div class="card-value">${escapeHtml(formatUsd(summary.monthCostNanoAiu, config.usdPerAiu))} <span class="muted budget-of">/ $${plan.toFixed(0)}</span></div>
      <div class="budget-bar"><span class="budget-fill ${over ? 'over' : ''}" style="width:${pct}%"></span></div>
      <div class="card-sub muted">~${pct}% of your $${plan.toFixed(0)}/mo credits (estimate)${over ? ' — over!' : ''}</div>
    </div>`;
}

function renderSummary(summary: Summary, config: CoachConfig): string {
  const priciest = summary.priciestMessage;
  const priciestText = priciest
    ? `${escapeHtml(formatCost(priciest.totalCostNanoAiu))} <span class="muted" title="${
        priciest.userMessage ? escapeHtml(priciest.userMessage) : ''
      }">(${escapeHtml(truncate(priciest.userMessage ?? '—', 28))})</span>`
    : '—';
  const totalUsd =
    config.usdPerAiu > 0
      ? `<div class="card-sub muted">≈ ${escapeHtml(formatUsd(summary.totalCostNanoAiu, config.usdPerAiu))} all-time</div>`
      : '';

  return `
    <div class="cards">
      <div class="card">
        <div class="card-label">Total cost</div>
        <div class="card-value">${escapeHtml(formatCost(summary.totalCostNanoAiu))}</div>
        ${totalUsd}
      </div>
      ${renderBudgetCard(summary, config)}
      <div class="card">
        <div class="card-label">Total tokens</div>
        <div class="card-value">${formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}</div>
        <div class="card-sub muted">${escapeHtml(formatTokensCompact(summary.totalInputTokens))} in · ${escapeHtml(formatTokensCompact(summary.totalOutputTokens))} out</div>
      </div>
      <div class="card">
        <div class="card-label">Chats</div>
        <div class="card-value">${summary.chatCount.toLocaleString()}</div>
        <div class="card-sub muted">${summary.messageCount.toLocaleString()} messages</div>
      </div>
      <div class="card">
        <div class="card-label">Messages</div>
        <div class="card-value">${summary.messageCount.toLocaleString()}</div>
        <div class="card-sub muted">${summary.totalRequests.toLocaleString()} requests</div>
      </div>
      <div class="card">
        <div class="card-label">Cache hit rate</div>
        <div class="card-value">${escapeHtml(formatPercent(summary.aggregateCacheHitRate))}</div>
      </div>
      <div class="card">
        <div class="card-label">Priciest message</div>
        <div class="card-value">${priciestText}</div>
      </div>
      <div class="card ${summary.flaggedMessages > 0 ? 'card-flag' : ''}">
        <div class="card-label">Flagged messages</div>
        <div class="card-value">${summary.flaggedMessages.toLocaleString()}</div>
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

  const MAX_CHATS = 100;
  const shown = chats.slice(0, MAX_CHATS);

  const body =
    chats.length === 0
      ? renderEmptyState()
      : `
        ${renderSummary(summary, config)}
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
    }
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
    .chat-title { font-size: 1.05em; font-weight: 700; flex: 1 1 240px; }
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
    .msg-asked { font-weight: 600; flex: 1 1 240px; }
    .msg-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .chip {
      font-size: 0.8em; padding: 1px 7px; border-radius: 10px;
      background: var(--vscode-badge-background, rgba(127,127,127,0.2));
      color: var(--vscode-badge-foreground, inherit);
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
    }
    table.mini .num, table.mini th.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.mini tr.highlight td { background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent); }
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
    /* Reliable CSS tooltip (native title= is flaky inside webviews). */
    .tip { position: relative; }
    .tip[data-tip]:hover::after {
      content: attr(data-tip);
      position: absolute; left: 0; top: calc(100% + 5px); z-index: 30;
      width: max-content; max-width: min(320px, 80vw);
      padding: 7px 10px; border-radius: 5px;
      background: var(--vscode-editorHoverWidget-background, #252526);
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.4));
      box-shadow: 0 3px 10px rgba(0,0,0,0.45);
      font-size: 12px; font-weight: 400; line-height: 1.5;
      white-space: normal; text-transform: none; letter-spacing: normal;
    }
    /* Right-side tooltips open leftward so they don't run off the panel edge. */
    .tip-left[data-tip]:hover::after { left: auto; right: 0; }
    .caption { margin: 6px 0 0; }
    .attach { margin-top: 8px; }
    .attach-title { font-size: 0.8em; text-transform: uppercase; letter-spacing: .04em; }
    .attach ul { margin: 4px 0 0; padding-left: 16px; }
    .attach li { margin: 1px 0; }
    .file { font-family: var(--vscode-editor-font-family, monospace); }

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
    .item-main { flex: 1 1 200px; }
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
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>📊 Token Coach</h1>
    ${extensionVersion ? `<span class="ver">v${escapeHtml(extensionVersion)}</span>` : ''}
    <button id="refresh" title="Re-scan logs">↻ Refresh</button>
    <span class="muted">Cost in AIU (1 AIU = 1,000,000,000 NanoAiu). Context sizes are estimates (~4 chars ≈ 1 token).</span>
  </div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const btn = document.getElementById('refresh');
    if (btn) {
      btn.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
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

/** Generate a CSP nonce without relying on Math.random. */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    // Time-derived but good enough for a CSP nonce (not security-sensitive here).
    text += chars.charAt((Date.now() + i * 7919) % chars.length);
  }
  return text;
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
    onRefreshRequested: () => void
  ): DashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      DashboardPanel.current.update(data, config);
      return DashboardPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Token Coach',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.current = new DashboardPanel(panel, onRefreshRequested);
    DashboardPanel.current.update(data, config);
    return DashboardPanel.current;
  }

  /** Re-render with fresh data. Safe to call when the panel is hidden. */
  update(data: ParsedData, config: CoachConfig): void {
    // Surface the headline totals in the editor tab title.
    let cost = 0;
    let tokens = 0;
    for (const r of data.requests) {
      cost += r.costNanoAiu;
      tokens += r.inputTokens + r.outputTokens;
    }
    this.panel.title = `Token Coach · ${formatCost(cost)} · ${formatTokensCompact(tokens)} tok`;

    const nonce = makeNonce();
    this.panel.webview.html = renderHtml(this.panel.webview, data, config, nonce, this.openState);
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
