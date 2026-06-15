/**
 * extension.ts
 * -----------------------------------------------------------------------------
 * The extension entry point. Wires together:
 *   - the status bar item (today's total cost + tokens),
 *   - the `showDashboard` / `refresh` commands,
 *   - file watchers + a backup poll so data stays live, and
 *   - notifications when a newly logged request is expensive.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
  loadAll,
  findExistingStorageBases,
  groupByChat,
  ChatGroup,
  MessageGroup,
  LlmRequestRecord,
  ParsedData,
} from './logParser';
import { analyzeRecord, analyzeMessageDrivers, CoachConfig, CoachWarning, DEFAULT_COACH_CONFIG } from './coach';
import { computeEfficiency, EfficiencyScore } from './efficiency';
import { buildMarkdownReport, DailySnapshot } from './report';
import {
  DashboardPanel,
  formatCost,
  formatCredits,
  formatUsd,
  setExtensionVersion,
} from './dashboard';

const CONFIG_SECTION = 'tokenCoach';

let statusBarItem: vscode.StatusBarItem;
let watchers: vscode.FileSystemWatcher[] = [];
let pollTimer: NodeJS.Timeout | undefined;
let refreshDebounce: NodeJS.Timeout | undefined;
/**
 * `workspaceStorage` directory derived from THIS VS Code instance's own storage
 * path — works on any install (portable, custom data-dir, Insiders, remote),
 * not just the standard per-OS location. Computed once in activate().
 */
let workspaceStorageBase = '';
/** Kept so history (globalState) and the export command can reach extension storage. */
let extensionContext: vscode.ExtensionContext;

const HISTORY_KEY = 'tokenCoach.history';
/** Throttle history writes — refresh runs often, but a daily snapshot needn't. */
let lastSnapshotMs = 0;
const SNAPSHOT_MIN_GAP_MS = 10 * 60 * 1000;

/** Ids of requests we've already seen, so we only notify about genuinely new ones.
 *  Rebuilt from the (month-scoped) data each pass, so it stays bounded. */
let seenIds = new Set<string>();
/** Suppress notifications during the very first load (historical data). */
let primed = false;

/** Message ids already seen, so inefficiency nudges fire once per new message.
 *  Rebuilt from the (month-scoped) data each pass, so it stays bounded. */
let seenMessageIds = new Set<string>();
/** Suppress inefficiency nudges on the first load (historical data). */
let nudgePrimed = false;
/** Timestamp of the last notification, so softer nudges don't stack on alerts. */
let lastNudgeMs = 0;
/** Minimum gap between inefficiency nudges, so they coach rather than nag. */
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getCoachConfig(): CoachConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    costWarnThreshold: cfg.get('costWarnThreshold', DEFAULT_COACH_CONFIG.costWarnThreshold),
    inputWarnThreshold: cfg.get('inputWarnThreshold', DEFAULT_COACH_CONFIG.inputWarnThreshold),
    lowCacheRateThreshold: cfg.get('lowCacheRateThreshold', DEFAULT_COACH_CONFIG.lowCacheRateThreshold),
    lowCacheMinInputTokens: cfg.get('lowCacheMinInputTokens', DEFAULT_COACH_CONFIG.lowCacheMinInputTokens),
    ioRatioThreshold: cfg.get('ioRatioThreshold', DEFAULT_COACH_CONFIG.ioRatioThreshold),
    ioMinInputTokens: cfg.get('ioMinInputTokens', DEFAULT_COACH_CONFIG.ioMinInputTokens),
    attachmentShareWarn: cfg.get('attachmentShareWarn', DEFAULT_COACH_CONFIG.attachmentShareWarn),
    slowToolWarnMs: cfg.get('slowToolWarnMs', DEFAULT_COACH_CONFIG.slowToolWarnMs),
    usdPerAiu: cfg.get('usdPerAiu', DEFAULT_COACH_CONFIG.usdPerAiu),
    planMonthlyUsd: cfg.get('planMonthlyUsd', DEFAULT_COACH_CONFIG.planMonthlyUsd),
    cacheIdleMinutes: cfg.get('cacheIdleMinutes', DEFAULT_COACH_CONFIG.cacheIdleMinutes),
  };
}

function getOverridePath(): string {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get('workspaceStoragePathOverride', '');
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function startOfTodayMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfMonthMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/**
 * Keep only this calendar month's records. Every consumer (status bar,
 * dashboard, nudges, exported report) sees a month-scoped view, so on the 1st
 * of each month the extension starts fresh — matching GitHub's monthly credit
 * reset. Older logs stay on disk untouched; they're just not shown.
 */
function filterToCurrentMonth(data: ParsedData): ParsedData {
  const monthStart = startOfMonthMs();
  return {
    ...data,
    requests: data.requests.filter((r) => r.timestamp >= monthStart),
    toolCalls: data.toolCalls.filter((t) => t.timestamp >= monthStart),
  };
}

function updateStatusBar(data: ParsedData, config: CoachConfig, hasOlderLogs = false): void {
  const records = data.requests;
  const todayStart = startOfTodayMs();
  // Data is already month-scoped (filterToCurrentMonth), so the sum of all
  // records IS this month's cost. The tooltip breaks it down by month / today.
  // (Token counts are intentionally not shown.)
  let monthCost = 0;
  let todayCost = 0;
  for (const r of records) {
    monthCost += r.costNanoAiu;
    if (r.timestamp >= todayStart) {
      todayCost += r.costNanoAiu;
    }
  }

  const showUsd = config.usdPerAiu > 0;

  if (records.length === 0) {
    // Distinguish "fresh month, nothing used yet" (older logs exist but are
    // outside the current month) from "logging not set up at all".
    if (hasOlderLogs) {
      statusBarItem.text = `$(graph) ${showUsd ? formatUsd(0, config.usdPerAiu) : formatCost(0)} used`;
      statusBarItem.backgroundColor = undefined;
      const md = new vscode.MarkdownString(
        '**$(graph) Token Coach** — new month, fresh start.\n\n' +
          'No Copilot usage logged this month yet. The counter resets on the 1st, like GitHub\'s credit meter.\n\n' +
          '[Open dashboard](command:tokenCoach.showDashboard)'
      );
      md.isTrusted = true;
      md.supportThemeIcons = true;
      statusBarItem.tooltip = md;
      statusBarItem.show();
      return;
    }
    statusBarItem.text = '$(graph) Token Coach: no logs';
    statusBarItem.backgroundColor = undefined;
    const md = new vscode.MarkdownString(
      'No Copilot debug logs found yet.\n\n' +
        'Enable `github.copilot.chat.agentDebugLog.enabled` and `…fileLogging.enabled`, then use Copilot Chat.\n\n' +
        '[Open dashboard](command:tokenCoach.showDashboard)'
    );
    md.isTrusted = true;
    md.supportThemeIcons = true;
    statusBarItem.tooltip = md;
    statusBarItem.show();
    return;
  }

  // Single glanceable health signal, computed from the same coaching rules the
  // dashboard uses (cache reuse + waste warnings).
  const eff = computeEfficiency(data, config);
  const monthUsd = (monthCost / 1e9) * config.usdPerAiu;

  // Lead with "how much you've used this month" — the figure that maps to
  // GitHub's monthly credit meter (it resets each month, just like GitHub).
  // The all-time total and token breakdown move to the tooltip.
  const gradeTag = eff.hasData ? `${eff.grade} · ` : '';
  const usedTag = showUsd ? `${formatUsd(monthCost, config.usdPerAiu)} used` : `${formatCost(monthCost)} used`;
  statusBarItem.text = `$(graph) ${gradeTag}${usedTag}`;
  statusBarItem.backgroundColor = statusBarColor(eff, monthUsd, config);
  statusBarItem.tooltip = buildStatusTooltip(
    { eff, monthCost, todayCost, recordCount: records.length },
    config
  );
  statusBarItem.show();
}

/**
 * Tint the status bar to flag trouble at a glance. Status bar items only support
 * warning/error theme backgrounds, so we map: poor efficiency OR over budget →
 * red; mediocre efficiency OR nearing budget → yellow; otherwise the default.
 */
function statusBarColor(
  eff: EfficiencyScore,
  monthUsd: number,
  config: CoachConfig
): vscode.ThemeColor | undefined {
  const budgetTracked = config.usdPerAiu > 0 && config.planMonthlyUsd > 0;
  const overBudget = budgetTracked && monthUsd > config.planMonthlyUsd;
  const nearBudget = budgetTracked && monthUsd >= 0.8 * config.planMonthlyUsd;

  if ((eff.hasData && eff.score < 50) || overBudget) {
    return new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  if ((eff.hasData && eff.score < 70) || nearBudget) {
    return new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  return undefined;
}

interface TooltipStats {
  eff: EfficiencyScore;
  monthCost: number;
  todayCost: number;
  recordCount: number;
}

/** Rich, clickable Markdown tooltip (replaces the old plain-text one). */
function buildStatusTooltip(s: TooltipStats, config: CoachConfig): vscode.MarkdownString {
  const showUsd = config.usdPerAiu > 0;
  const usd = (nano: number) => formatUsd(nano, config.usdPerAiu);
  const blocks: string[] = [];

  if (s.eff.hasData) {
    blocks.push(
      `**$(graph) Token Coach** — Efficiency **${s.eff.grade}** · ${s.eff.score}/100\n\n` +
        `Cache reuse ${s.eff.cacheScore}/100 · Clean runs ${s.eff.cleanScore}/100 ` +
        `_(${s.eff.cleanMessages}/${s.eff.messageCount} messages)_`
    );
  } else {
    blocks.push(`**$(graph) Token Coach**`);
  }

  // "How much you used" by scope — just the credits you spent, no plan/quota.
  const line = (label: string, nano: number) =>
    `**${label}** ${formatCredits(nano)}${showUsd ? ` (${usd(nano)})` : ''}`;
  const stats = [line('This month', s.monthCost), line('Today', s.todayCost)];
  // Two trailing spaces = a soft line break, so the stats stack tightly.
  blocks.push(stats.join('  \n'));

  blocks.push(
    `${s.recordCount.toLocaleString()} requests logged this month — resets on the 1st, like GitHub's meter. ` +
      `This is only what Copilot wrote to this machine's local debug logs, so it's a partial record ` +
      `(other machines, and ask/inline modes, aren't here) and reads lower than your full account total.`
  );
  blocks.push(
    `[Open dashboard](command:tokenCoach.showDashboard) · ` +
      `[Refresh](command:tokenCoach.refresh)`
  );

  const md = new vscode.MarkdownString(blocks.join('\n\n'));
  md.isTrusted = true; // enable command: links
  md.supportThemeIcons = true;
  return md;
}

// ---------------------------------------------------------------------------
// Refresh pipeline
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  const config = getCoachConfig();
  let data: ParsedData;
  try {
    data = await loadAll(getOverridePath(), workspaceStorageBase);
  } catch (err) {
    console.error('[Token Coach] Failed to load logs:', err);
    data = { requests: [], toolCalls: [], titles: {} };
  }
  // Month scope: everything shown resets automatically when a new month starts.
  const totalLogged = data.requests.length;
  data = filterToCurrentMonth(data);

  updateStatusBar(data, config, totalLogged > data.requests.length);

  if (DashboardPanel.current) {
    DashboardPanel.current.update(data, config, getHistory());
  }

  detectAndNotifyNew(data.requests, config);
  detectAndNotifyNudges(groupByChat(data), config);
  void recordSnapshot(data, config);
}

/**
 * Notify about newly-logged expensive requests. On the first run we just record
 * the existing ids so we don't fire a burst of notifications for old data.
 */
function detectAndNotifyNew(records: LlmRequestRecord[], config: CoachConfig): void {
  const notify = vscode.workspace.getConfiguration(CONFIG_SECTION).get('notifyOnExpensiveRequest', true);

  const current = new Set<string>();
  const newExpensive: LlmRequestRecord[] = [];
  for (const r of records) {
    current.add(r.id);
    if (seenIds.has(r.id)) {
      continue;
    }
    if (primed && r.costNanoAiu > config.costWarnThreshold) {
      newExpensive.push(r);
    }
  }
  // Replace rather than accumulate: ids that fell out of the month-scoped data
  // can never reappear, so this keeps the set bounded across months.
  seenIds = current;

  if (!primed) {
    primed = true;
    return;
  }

  if (notify && newExpensive.length > 0) {
    // Surface the single worst new request to avoid notification spam.
    newExpensive.sort((a, b) => b.costNanoAiu - a.costNanoAiu);
    const worst = newExpensive[0];
    const extra = newExpensive.length > 1 ? ` (+${newExpensive.length - 1} more)` : '';
    const advice = analyzeRecord(worst, config)
      .map((w) => w.message)
      .join(' ');
    // A cost alert takes priority, so let it suppress softer nudges for a while.
    lastNudgeMs = Date.now();
    vscode.window
      .showWarningMessage(
        `Expensive Copilot request: ${formatCost(worst.costNanoAiu)} on ${worst.model}${extra}. ${advice}`,
        'Open Dashboard'
      )
      .then((choice) => {
        if (choice === 'Open Dashboard') {
          void showDashboard();
        }
      });
  }
}

/**
 * Softer, message-level coaching: when a genuinely-new message shows an
 * actionable inefficiency (cache went cold mid-chat, or open files dominate
 * context), nudge once — throttled so it coaches rather than nags.
 */
function detectAndNotifyNudges(chats: ChatGroup[], config: CoachConfig): void {
  // Record every new message first (so we never nudge twice for the same one),
  // and collect the fresh ones to consider.
  const current = new Set<string>();
  const fresh: MessageGroup[] = [];
  for (const chat of chats) {
    for (const g of chat.messages) {
      current.add(g.id);
      if (seenMessageIds.has(g.id)) {
        continue;
      }
      fresh.push(g);
    }
  }
  // Replace rather than accumulate (same reasoning as seenIds): stays bounded.
  seenMessageIds = current;

  // First load just primes the seen-set so we don't nudge on historical data.
  if (!nudgePrimed) {
    nudgePrimed = true;
    return;
  }

  const notify = vscode.workspace.getConfiguration(CONFIG_SECTION).get('notifyOnInefficiency', true);
  if (!notify || fresh.length === 0) {
    return;
  }
  if (Date.now() - lastNudgeMs < NUDGE_COOLDOWN_MS) {
    return;
  }

  // Only the actionable drivers are worth interrupting for.
  const ACTIONABLE = new Set(['cache-expired-idle', 'low-cache-hit', 'heavy-attachments']);
  const candidates: Array<{ group: MessageGroup; warning: CoachWarning }> = [];
  for (const g of fresh) {
    const w = analyzeMessageDrivers(g, config).find((d) => ACTIONABLE.has(d.rule));
    if (w) {
      candidates.push({ group: g, warning: w });
    }
  }
  if (candidates.length === 0) {
    return;
  }

  candidates.sort((a, b) => b.group.startTime - a.group.startTime);
  const top = candidates[0];
  lastNudgeMs = Date.now();
  vscode.window
    .showInformationMessage(`Token Coach: ${top.warning.message}`, 'Open Dashboard')
    .then((choice) => {
      if (choice === 'Open Dashboard') {
        void showDashboard();
      }
    });
}

/** Debounced refresh, used by watchers that can fire in rapid bursts. */
function scheduleRefresh(): void {
  if (refreshDebounce) {
    clearTimeout(refreshDebounce);
  }
  refreshDebounce = setTimeout(() => void refresh(), 400);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function showDashboard(): Promise<void> {
  const config = getCoachConfig();
  const raw = await loadAll(getOverridePath(), workspaceStorageBase);
  const data = filterToCurrentMonth(raw);
  // Keep the seen-sets in sync so opening the dashboard doesn't re-trigger alerts.
  for (const r of data.requests) {
    seenIds.add(r.id);
  }
  for (const chat of groupByChat(data)) {
    for (const g of chat.messages) {
      seenMessageIds.add(g.id);
    }
  }
  primed = true;
  nudgePrimed = true;
  await recordSnapshot(data, config);
  DashboardPanel.createOrShow(data, config, () => void refresh(), getHistory());
  updateStatusBar(data, config, raw.requests.length > data.requests.length);
}

// ---------------------------------------------------------------------------
// History + export ("saving things")
// ---------------------------------------------------------------------------

/** Local `YYYY-MM-DD` for grouping daily snapshots. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getHistory(): DailySnapshot[] {
  return extensionContext?.globalState.get<DailySnapshot[]>(HISTORY_KEY, []) ?? [];
}

/**
 * Record (or update) today's snapshot of the headline numbers, so the dashboard
 * and exported report can show a trend over time. Throttled, and only one entry
 * per calendar day (re-written as the day's totals grow).
 */
async function recordSnapshot(data: ParsedData, config: CoachConfig): Promise<void> {
  if (!extensionContext || data.requests.length === 0) {
    return;
  }
  const now = Date.now();
  const date = localDateKey(new Date());
  const history = getHistory();
  const last = history[history.length - 1];
  // Skip frequent rewrites unless it's a new day or enough time has passed.
  if (last && last.date === date && now - lastSnapshotMs < SNAPSHOT_MIN_GAP_MS) {
    return;
  }
  lastSnapshotMs = now;

  // Data is month-scoped, so the sum of all records is this month's cost.
  let monthCost = 0;
  let totalTokens = 0;
  for (const r of data.requests) {
    monthCost += r.costNanoAiu;
    totalTokens += r.inputTokens + r.outputTokens;
  }
  const eff = computeEfficiency(data, config);
  const snap: DailySnapshot = {
    date,
    score: eff.score,
    grade: eff.grade,
    allCostNanoAiu: monthCost,
    monthCostNanoAiu: monthCost,
    totalTokens,
  };

  if (last && last.date === date) {
    history[history.length - 1] = snap;
  } else {
    history.push(snap);
  }
  if (history.length > 365) {
    history.splice(0, history.length - 365);
  }
  await extensionContext.globalState.update(HISTORY_KEY, history);
}

/** Build a Markdown report and let the user save it, then open it. */
async function exportReport(): Promise<void> {
  const config = getCoachConfig();
  const data = filterToCurrentMonth(await loadAll(getOverridePath(), workspaceStorageBase));
  if (data.requests.length === 0) {
    vscode.window.showWarningMessage('Token Coach: no Copilot usage logged this month — nothing to export.');
    return;
  }
  const md = buildMarkdownReport(data, config, getHistory(), new Date());

  const defaultName = `token-coach-report-${localDateKey(new Date())}.md`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = folder ? vscode.Uri.joinPath(folder, defaultName) : vscode.Uri.file(defaultName);
  const target = await vscode.window.showSaveDialog({
    title: 'Export Token Coach report',
    defaultUri,
    filters: { Markdown: ['md'], 'All files': ['*'] },
  });
  if (!target) {
    return;
  }

  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(`Token Coach: could not write the report — ${String(err)}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}

// ---------------------------------------------------------------------------
// Watchers / polling
// ---------------------------------------------------------------------------

async function setupWatchers(context: vscode.ExtensionContext): Promise<void> {
  disposeWatchers();

  const bases = await findExistingStorageBases(getOverridePath(), workspaceStorageBase);
  for (const base of bases) {
    // Watch only the Copilot debug logs under each storage root.
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(base),
      '**/GitHub.copilot-chat/debug-logs/**/main.jsonl'
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
    watchers.push(watcher);
    context.subscriptions.push(watcher);
  }
}

function disposeWatchers(): void {
  for (const w of watchers) {
    w.dispose();
  }
  watchers = [];
}

function setupPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  const seconds = vscode.workspace.getConfiguration(CONFIG_SECTION).get('pollIntervalSeconds', 20);
  if (seconds && seconds > 0) {
    pollTimer = setInterval(() => void refresh(), seconds * 1000);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Derive the `workspaceStorage` directory from the extension's own storage path,
 * which VS Code sets correctly for every install kind. `globalStorageUri` is
 * `<userDataDir>/User/globalStorage/<publisher>.<name>`, so two levels up +
 * `workspaceStorage` is the folder Copilot writes its debug logs under.
 */
function deriveWorkspaceStorageBase(context: vscode.ExtensionContext): string {
  try {
    const globalStorage = context.globalStorageUri.fsPath;
    const userDir = path.dirname(path.dirname(globalStorage)); // -> <userDataDir>/User
    return path.join(userDir, 'workspaceStorage');
  } catch {
    return '';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  setExtensionVersion(String(context.extension.packageJSON.version ?? ''));
  workspaceStorageBase = deriveWorkspaceStorageBase(context);
  console.log('[Token Coach] workspaceStorage base:', workspaceStorageBase || '(derive failed; using OS defaults)');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tokenCoach.showDashboard';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenCoach.showDashboard', () => void showDashboard()),
    vscode.commands.registerCommand('tokenCoach.refresh', () => void refresh()),
    vscode.commands.registerCommand('tokenCoach.exportReport', () => void exportReport())
  );

  // React to relevant settings changes: re-read thresholds, restart watchers /
  // polling if the storage path or interval changed.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      if (
        e.affectsConfiguration(`${CONFIG_SECTION}.workspaceStoragePathOverride`) ||
        e.affectsConfiguration(`${CONFIG_SECTION}.pollIntervalSeconds`)
      ) {
        void setupWatchers(context);
        setupPolling();
      }
      void refresh();
    })
  );

  // Kick things off.
  void setupWatchers(context);
  setupPolling();
  void refresh();
}

export function deactivate(): void {
  disposeWatchers();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (refreshDebounce) {
    clearTimeout(refreshDebounce);
    refreshDebounce = undefined;
  }
  statusBarItem?.dispose();
}
