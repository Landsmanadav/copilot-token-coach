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
  findLogFiles,
  findExistingStorageBases,
  groupByChat,
  ChatGroup,
  MessageGroup,
  LlmRequestRecord,
  ParsedData,
} from './logParser';
import { analyzeRecord, analyzeMessageDrivers, CoachConfig, CoachWarning, DEFAULT_COACH_CONFIG } from './coach';
import { computeEfficiency, EfficiencyScore, windowStart } from './efficiency';
import { buildMarkdownReport, DailySnapshot } from './report';
import { buildSessionExports, eventsCsv, requestsCsv, sessionMarkdown, sessionsCsv, toolCallsCsv, toolsCsv } from './sessionExport';
import {
  DashboardPanel,
  formatCost,
  formatCredits,
  formatUsd,
  setExtensionVersion,
} from './dashboard';

const CONFIG_SECTION = 'tokenCoach';

/** The two Copilot settings that turn on the local debug logs Token Coach reads. */
const COPILOT_LOG_SECTION = 'github.copilot.chat.agentDebugLog';
const COPILOT_LOG_KEYS = ['enabled', 'fileLogging.enabled'] as const;

/** True only when BOTH Copilot debug-log settings are on. */
function isLoggingEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration(COPILOT_LOG_SECTION);
  return COPILOT_LOG_KEYS.every((k) => cfg.get<boolean>(k, false) === true);
}

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
 *  Rebuilt from the loaded data each pass, so it stays bounded. */
let seenIds = new Set<string>();
/** Suppress notifications during the very first load (historical data). */
let primed = false;

/** Message ids already seen, so inefficiency nudges fire once per new message.
 *  Rebuilt from the loaded data each pass, so it stays bounded. */
let seenMessageIds = new Set<string>();
/** Suppress inefficiency nudges on the first load (historical data). */
let nudgePrimed = false;
/** Timestamp of the last notification, so softer nudges don't stack on alerts. */
let lastNudgeMs = 0;
/** Minimum gap between inefficiency nudges, so they coach rather than nag. */
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;
/** This build's version, stamped on every export. */
let extensionVersion = '';
/** Popups close themselves after this many seconds so they never pile up. */
const NOTIFICATION_SECONDS = 3;
/** Backup refresh on top of the file watcher. */
const POLL_SECONDS = 20;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getCoachConfig(): CoachConfig {
  // Since v2.4 the only user-facing choices are about display. Every threshold
  // is a fixed default (see DEFAULT_COACH_CONFIG); the grade no longer needs tuning.
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const showDollars = cfg.get<string>('showCostsIn', 'dollars') !== 'credits';
  return {
    ...DEFAULT_COACH_CONFIG,
    usdPerAiu: showDollars ? DEFAULT_COACH_CONFIG.usdPerAiu : 0,
  };
}

/** The one popup switch: expensive-request alerts and waste tips. */
function popupsEnabled(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('popups', true);
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

function updateStatusBar(data: ParsedData, config: CoachConfig): void {
  const records = data.requests;
  const todayStart = startOfTodayMs();
  // The status bar leads with TODAY's spend — a small, honest window that doesn't
  // invite a mismatch with Copilot's own monthly credit meter (which Copilot
  // already shows in its status menu). The all-time logged total is in the
  // tooltip. (Token counts are intentionally not shown.)
  let todayCost = 0;
  let allTimeCost = 0;
  for (const r of records) {
    allTimeCost += r.costNanoAiu;
    if (r.timestamp >= todayStart) {
      todayCost += r.costNanoAiu;
    }
  }

  const showUsd = config.usdPerAiu > 0;

  if (records.length === 0) {
    // Two distinct empty states. Only nudge to enable logging when it's actually
    // OFF — if the agent debug log is already on and there's simply nothing
    // logged yet (e.g. a brand-new setup, or a fresh month with rotated logs),
    // never re-prompt to turn it on; just say there's no usage yet.
    const loggingOn = isLoggingEnabled();
    statusBarItem.text = loggingOn
      ? '$(graph) Token Coach: no usage yet'
      : '$(graph) Token Coach: logging off';
    statusBarItem.backgroundColor = undefined;
    const md = new vscode.MarkdownString(
      loggingOn
        ? '**$(graph) Token Coach** — Copilot debug logging is on; no usage logged yet.\n\n' +
            'Use Copilot Chat a few times and your usage will appear here.\n\n' +
            '[Open dashboard](command:tokenCoach.showDashboard) · [Refresh](command:tokenCoach.refresh)'
        : 'No Copilot debug logs found yet.\n\n' +
            'Enable `github.copilot.chat.agentDebugLog.enabled` and `…fileLogging.enabled`, then use Copilot Chat.\n\n' +
            '[Open dashboard](command:tokenCoach.showDashboard)'
    );
    md.isTrusted = true;
    md.supportThemeIcons = true;
    statusBarItem.tooltip = md;
    statusBarItem.show();
    return;
  }

  // The headline: money lost to avoidable cache misses over the last 7 days.
  const eff = computeEfficiency(data, config, windowStart());

  // Lead with "how much you've used today". Copilot's own menu already shows the
  // monthly credit total, so Token Coach doesn't try to mirror (and undercount) it.
  const gradeTag = eff.hasData ? `score ${eff.score} · ` : '';
  const usedTag = showUsd ? `${formatUsd(todayCost, config.usdPerAiu)} today` : `${formatCost(todayCost)} today`;
  statusBarItem.text = `$(graph) ${gradeTag}${usedTag}`;
  statusBarItem.backgroundColor = statusBarColor(eff);
  statusBarItem.tooltip = buildStatusTooltip(
    { eff, todayCost, allTimeCost, recordCount: records.length },
    config
  );
  statusBarItem.show();
}

/**
 * Tint the status bar to flag poor efficiency at a glance. Status bar items only
 * support warning/error theme backgrounds, so we map: poor efficiency → red;
 * mediocre → yellow; otherwise the default. (No plan/budget tint — Token Coach
 * doesn't track a monthly quota; see the honest-logged-usage design note.)
 */
function statusBarColor(eff: EfficiencyScore): vscode.ThemeColor | undefined {
  if (eff.hasData && eff.score < 50) {
    return new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  if (eff.hasData && eff.score < 70) {
    return new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  return undefined;
}

interface TooltipStats {
  eff: EfficiencyScore;
  todayCost: number;
  allTimeCost: number;
  recordCount: number;
}

/** Rich, clickable Markdown tooltip (replaces the old plain-text one). */
function buildStatusTooltip(s: TooltipStats, config: CoachConfig): vscode.MarkdownString {
  const showUsd = config.usdPerAiu > 0;
  const usd = (nano: number) => formatUsd(nano, config.usdPerAiu);
  const blocks: string[] = [];

  if (s.eff.hasData) {
    const money = (nano: number) => (showUsd ? usd(nano) : formatCredits(nano));
    const lost = s.eff.timingWasteNanoAiu + s.eff.qualityWasteNanoAiu;
    blocks.push(
      `**$(graph) Token Coach** — last 7 days: **${money(lost)} lost** of ${money(s.eff.totalCostNanoAiu)} · ` +
        `score **${s.eff.score}** (${s.eff.grade})\n\n` +
        `${money(s.eff.timingWasteNanoAiu)} after idle pauses (${s.eff.idleMisses}) · ` +
        `${money(s.eff.qualityWasteNanoAiu)} from model switches / broken cache (${s.eff.breakMisses})`
    );
  } else {
    blocks.push(`**$(graph) Token Coach**`);
  }

  // "How much you used" by scope — just the credits you spent, no plan/quota.
  const line = (label: string, nano: number) =>
    `**${label}** ${formatCredits(nano)}${showUsd ? ` (${usd(nano)})` : ''}`;
  const stats = [line('Today', s.todayCost), line('All-time logged', s.allTimeCost)];
  // Two trailing spaces = a soft line break, so the stats stack tightly.
  blocks.push(stats.join('  \n'));

  blocks.push(
    `${s.recordCount.toLocaleString()} requests logged on this machine. This is only the Copilot ` +
      `chat/agent sessions written to local debug logs (other machines and ask/inline modes aren't here), ` +
      `so it reads lower than your GitHub account meter. For your monthly credit total, use Copilot's own status menu.`
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
  // All logged history is kept — nothing is wiped at a month boundary. The
  // dashboard groups it by month; the status bar shows today.
  updateStatusBar(data, config);

  if (DashboardPanel.current) {
    DashboardPanel.current.update(data, config, getHistory(), isLoggingEnabled());
  }

  detectAndNotifyNew(data.requests, config);
  detectAndNotifyNudges(groupByChat(data), config);
  void recordSnapshot(data, config);
}

/**
 * Show a notification that closes itself after a few seconds, so alerts and tips
 * never pile up in the corner. VS Code's `showWarningMessage` can't be dismissed
 * from code, so it's rendered as a notification-area progress task that
 * resolves on a timer.
 */
function notifyAutoDismiss(_kind: 'warning' | 'info', message: string): void {
  // Auto-dismiss path: a notification-area task that simply waits, then resolves
  // so VS Code closes it for us.
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: message },
    () => new Promise<void>((resolve) => setTimeout(resolve, NOTIFICATION_SECONDS * 1000))
  );
}

/**
 * Notify about newly-logged expensive requests. On the first run we just record
 * the existing ids so we don't fire a burst of notifications for old data.
 */
function detectAndNotifyNew(records: LlmRequestRecord[], config: CoachConfig): void {
  const notify = popupsEnabled();

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
  // Replace rather than accumulate: rebuild from the freshly loaded data each
  // pass so the set stays bounded and never grows without limit.
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
    notifyAutoDismiss(
      'warning',
      `Expensive Copilot request: ${formatCost(worst.costNanoAiu)} on ${worst.model}${extra}. ${advice}`
    );
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

  const notify = popupsEnabled();
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
  notifyAutoDismiss('info', `Token Coach: ${top.warning.message}`);
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
  const data = await loadAll(getOverridePath(), workspaceStorageBase);
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
  DashboardPanel.createOrShow(data, config, () => void refresh(), getHistory(), isLoggingEnabled());
  updateStatusBar(data, config);
}

/**
 * One-click onboarding: flip the two Copilot debug-log settings on (User scope),
 * so the user doesn't have to hunt for setting ids. Then refresh so the panel
 * reflects the new state.
 */
async function enableLogging(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(COPILOT_LOG_SECTION);
  try {
    for (const key of COPILOT_LOG_KEYS) {
      await cfg.update(key, true, vscode.ConfigurationTarget.Global);
      // A workspace value beats the global one. If this project turned logging
      // off, turn it on here too, or the global switch silently does nothing.
      if (cfg.inspect<boolean>(key)?.workspaceValue === false) {
        await cfg.update(key, true, vscode.ConfigurationTarget.Workspace);
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Token Coach: couldn't enable Copilot logging automatically (${String(err)}). ` +
        `Set ${COPILOT_LOG_SECTION}.enabled and .fileLogging.enabled to true in Settings.`
    );
    return;
  }
  if (!isLoggingEnabled()) {
    vscode.window.showWarningMessage(
      'Token Coach: Copilot debug logging is still off — a folder or policy setting overrides it. ' +
        `Check ${COPILOT_LOG_SECTION}.enabled and .fileLogging.enabled in Settings (Workspace and Folder tabs).`
    );
    await refresh();
    return;
  }
  vscode.window.showInformationMessage(
    'Token Coach: Copilot debug logging is on. Use Copilot Chat a few times, then Refresh — your usage will appear here.'
  );
  await refresh();
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

  // A snapshot is one calendar day, so its cost is what was logged *that day*
  // (since local midnight) — re-written as the day progresses. This makes the
  // trend a per-day spend line, not a monotonic all-time total. Tokens stay
  // all-time as trend context.
  const todayStart = startOfTodayMs();
  let dayCost = 0;
  let totalTokens = 0;
  for (const r of data.requests) {
    totalTokens += r.inputTokens + r.outputTokens;
    if (r.timestamp >= todayStart) {
      dayCost += r.costNanoAiu;
    }
  }
  // Each day's point on the trend is that day alone, so improvement shows.
  const eff = computeEfficiency(data, config, todayStart);
  const snap: DailySnapshot = {
    date,
    score: eff.score,
    grade: eff.grade,
    allCostNanoAiu: dayCost,
    monthCostNanoAiu: dayCost,
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

/** Copilot's OpenTelemetry JSON-lines file, when the user has turned it on. */
function otelOutfile(): string | undefined {
  const f = vscode.workspace.getConfiguration('github.copilot.chat.otel').get<string>('outfile', '');
  return f && f.trim() ? f.trim() : undefined;
}

/**
 * Turn on Copilot's OpenTelemetry file export (without message content) so the
 * export can add cache-write and reasoning tokens, which the debug log omits.
 */
async function enableCacheWriteCapture(): Promise<void> {
  const existing = otelOutfile();
  if (existing) {
    vscode.window.showInformationMessage(`Token Coach: Copilot already writes OpenTelemetry to ${existing}. The next export will read it.`);
    return;
  }
  if (!extensionContext) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Token Coach: turn on Copilot\'s OpenTelemetry file export? It records token counts per request (including cache writes and reasoning tokens) ' +
      'to a local file. Prompts and responses are NOT recorded. It changes your Copilot settings; turn it off in Settings any time.',
    { modal: true },
    'Turn on'
  );
  if (choice !== 'Turn on') {
    return;
  }
  const dir = vscode.Uri.joinPath(extensionContext.globalStorageUri, 'otel');
  await vscode.workspace.fs.createDirectory(dir);
  const file = vscode.Uri.joinPath(dir, 'copilot-otel.jsonl').fsPath;
  const cfg = vscode.workspace.getConfiguration('github.copilot.chat.otel');
  try {
    await cfg.update('outfile', file, vscode.ConfigurationTarget.Global);
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
    await cfg.update('captureContent', false, vscode.ConfigurationTarget.Global);
  } catch (err) {
    vscode.window.showErrorMessage(`Token Coach: could not change Copilot's OpenTelemetry settings — ${String(err)}`);
    return;
  }
  vscode.window.showInformationMessage(
    `Token Coach: Copilot will write token counts to ${file}. Only new requests are covered; exports include cache writes from now on.`
  );
}

/** The folder the user last exported to, offered first next time. */
const LAST_EXPORT_FOLDER_KEY = 'tokenCoach.lastExportFolder';

/**
 * Export a folder: the overall Markdown report plus one JSON and
 * one Markdown file per session, and CSV tables across sessions. Read-only on
 * the Copilot logs; every write goes into a new, timestamped folder under the
 * extension's own storage, with no dialog.
 */
async function exportReport(): Promise<void> {
  try {
    await runExport();
  } catch (err) {
    // Any failure must be visible; a silent no-op looks like a dead button.
    vscode.window.showErrorMessage(`Token Coach: export failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runExport(): Promise<void> {
  // The user picks the folder first (reading big logs can take a while, and the
  // dialog must not look like a dead button); the last choice is offered next time.
  const last = extensionContext?.globalState.get<string>(LAST_EXPORT_FOLDER_KEY);
  const picked = await vscode.window.showOpenDialog({
    title: 'Token Coach export — choose where to create the export folder',
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: last ? vscode.Uri.parse(last) : vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: 'Export here',
  });
  if (!picked?.[0]) {
    return;
  }
  await extensionContext?.globalState.update(LAST_EXPORT_FOLDER_KEY, picked[0].toString());

  const config = getCoachConfig();
  const loaded = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Token Coach: reading Copilot logs…' },
    async () => ({
      files: await findLogFiles(getOverridePath(), workspaceStorageBase),
      data: await loadAll(getOverridePath(), workspaceStorageBase),
    })
  );
  const { files, data } = loaded;
  if (data.requests.length === 0) {
    vscode.window.showWarningMessage('Token Coach: no Copilot usage logged yet — nothing to export.');
    return;
  }

  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${localDateKey(now)}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const root = vscode.Uri.joinPath(picked[0], `token-coach-export-${stamp}`);
  const write = (uri: vscode.Uri, text: string) => vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));

  try {
    const sessions = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Token Coach: building the export…' },
      () => buildSessionExports(files, data, config, extensionVersion, now, { otelFile: otelOutfile() })
    );
    const sessionsDir = vscode.Uri.joinPath(root, 'sessions');
    await vscode.workspace.fs.createDirectory(sessionsDir);
    for (const s of sessions) {
      const id = s.session.debugSessionId;
      await write(vscode.Uri.joinPath(sessionsDir, `${id}.json`), JSON.stringify(s, null, 2));
      await write(vscode.Uri.joinPath(sessionsDir, `${id}.md`), sessionMarkdown(s));
    }
    await write(vscode.Uri.joinPath(root, 'requests.csv'), requestsCsv(sessions));
    await write(vscode.Uri.joinPath(root, 'sessions.csv'), sessionsCsv(sessions));
    await write(vscode.Uri.joinPath(root, 'events.csv'), eventsCsv(sessions));
    await write(vscode.Uri.joinPath(root, 'tools.csv'), toolsCsv(sessions));
    await write(vscode.Uri.joinPath(root, 'tool-calls.csv'), toolCallsCsv(sessions));
    await write(vscode.Uri.joinPath(root, 'report.md'), buildMarkdownReport(data, config, now));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'report.md'));
    await vscode.window.showTextDocument(doc);
    const choice = await vscode.window.showInformationMessage(
      `Token Coach: exported ${sessions.length} session${sessions.length === 1 ? '' : 's'}.`,
      'Open folder'
    );
    if (choice === 'Open folder') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.joinPath(root, 'report.md'));
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Token Coach: could not write the export — ${String(err)}`);
  }
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
  pollTimer = setInterval(() => void refresh(), POLL_SECONDS * 1000);
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
  extensionVersion = String(context.extension.packageJSON.version ?? '');
  setExtensionVersion(extensionVersion);
  workspaceStorageBase = deriveWorkspaceStorageBase(context);
  console.log('[Token Coach] workspaceStorage base:', workspaceStorageBase || '(derive failed; using OS defaults)');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tokenCoach.showDashboard';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenCoach.showDashboard', () => void showDashboard()),
    vscode.commands.registerCommand('tokenCoach.refresh', () => void refresh()),
    vscode.commands.registerCommand('tokenCoach.exportReport', () => void exportReport()),
    vscode.commands.registerCommand('tokenCoach.enableCacheWriteCapture', () => void enableCacheWriteCapture()),
    vscode.commands.registerCommand('tokenCoach.enableLogging', () => void enableLogging()),
    // Open VS Code's Settings UI pre-filtered to this extension's settings.
    vscode.commands.registerCommand('tokenCoach.openSettings', () =>
      void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
    )
  );

  // React to relevant settings changes: re-read thresholds, restart watchers /
  // polling if the storage path or interval changed.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      if (e.affectsConfiguration(`${CONFIG_SECTION}.workspaceStoragePathOverride`)) {
        void setupWatchers(context);
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
