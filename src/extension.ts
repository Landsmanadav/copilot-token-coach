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
import { loadAll, findExistingStorageBases, LlmRequestRecord, ParsedData } from './logParser';
import { analyzeRecord, CoachConfig, DEFAULT_COACH_CONFIG } from './coach';
import {
  DashboardPanel,
  formatCost,
  formatTokens,
  formatTokensCompact,
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

/** Ids of requests we've already seen, so we only notify about genuinely new ones. */
const seenIds = new Set<string>();
/** Suppress notifications during the very first load (historical data). */
let primed = false;

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

function updateStatusBar(records: LlmRequestRecord[], config: CoachConfig): void {
  const todayStart = startOfTodayMs();
  const monthStart = startOfMonthMs();
  // Accumulate three scopes so the status bar can show the (always-meaningful)
  // all-time total while the tooltip breaks it down by today / this month.
  let allCost = 0;
  let allTokens = 0;
  let monthCost = 0;
  let todayCost = 0;
  let todayTokens = 0;
  for (const r of records) {
    const t = r.inputTokens + r.outputTokens;
    allCost += r.costNanoAiu;
    allTokens += t;
    if (r.timestamp >= monthStart) {
      monthCost += r.costNanoAiu;
    }
    if (r.timestamp >= todayStart) {
      todayCost += r.costNanoAiu;
      todayTokens += t;
    }
  }

  const showUsd = config.usdPerAiu > 0;

  if (records.length === 0) {
    statusBarItem.text = '$(graph) Token Coach: no logs';
    statusBarItem.tooltip =
      'No Copilot debug logs found. Enable github.copilot.chat.agentDebugLog.enabled and ' +
      '...fileLogging.enabled, then use Copilot Chat. Click to open the dashboard.';
  } else {
    // Show the all-time total — it always reflects the data on disk, so the bar
    // never looks empty just because Copilot wasn't used *today*.
    const usdTag = showUsd ? ` · ~${formatUsd(allCost, config.usdPerAiu)}` : '';
    statusBarItem.text = `$(graph) ${formatCost(allCost)}${usdTag} · ${formatTokensCompact(allTokens)} tok`;

    const lines = [
      `Token Coach`,
      `All-time: ${formatCost(allCost)}${showUsd ? ` (≈ ${formatUsd(allCost, config.usdPerAiu)})` : ''} · ${formatTokens(allTokens)} tok`,
    ];
    if (showUsd && config.planMonthlyUsd > 0) {
      const monthUsd = (monthCost / 1e9) * config.usdPerAiu;
      const pct = Math.round((monthUsd / config.planMonthlyUsd) * 100);
      lines.push(
        `This month: ${formatUsd(monthCost, config.usdPerAiu)} of $${config.planMonthlyUsd.toFixed(0)} plan (${pct}%)`
      );
    }
    lines.push(
      `Today: ${formatCost(todayCost)}${showUsd ? ` (≈ ${formatUsd(todayCost, config.usdPerAiu)})` : ''} · ${formatTokens(todayTokens)} tok`
    );
    lines.push(`${records.length.toLocaleString()} requests on disk · click to open the dashboard.`);
    statusBarItem.tooltip = lines.join('\n');
  }
  statusBarItem.show();
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

  updateStatusBar(data.requests, config);

  if (DashboardPanel.current) {
    DashboardPanel.current.update(data, config);
  }

  detectAndNotifyNew(data.requests, config);
}

/**
 * Notify about newly-logged expensive requests. On the first run we just record
 * the existing ids so we don't fire a burst of notifications for old data.
 */
function detectAndNotifyNew(records: LlmRequestRecord[], config: CoachConfig): void {
  const notify = vscode.workspace.getConfiguration(CONFIG_SECTION).get('notifyOnExpensiveRequest', true);

  const newExpensive: LlmRequestRecord[] = [];
  for (const r of records) {
    if (seenIds.has(r.id)) {
      continue;
    }
    seenIds.add(r.id);
    if (primed && r.costNanoAiu > config.costWarnThreshold) {
      newExpensive.push(r);
    }
  }

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
  // Keep the seen-set in sync so opening the dashboard doesn't re-trigger alerts.
  for (const r of data.requests) {
    seenIds.add(r.id);
  }
  primed = true;
  DashboardPanel.createOrShow(data, config, () => void refresh());
  updateStatusBar(data.requests, config);
}

/**
 * Anchor our dollar estimate to GitHub's authoritative billing number. The user
 * reads what GitHub actually shows used THIS MONTH (a $ amount is best — it's
 * unambiguous; a % is accepted but assumes the configured allowance), and we
 * rescale `usdPerAiu` so our figure matches. This closes the systematic gap
 * (flex allowance + uncharged base-model usage) in one step.
 */
async function calibrateToGitHub(): Promise<void> {
  const config = getCoachConfig();
  if (config.usdPerAiu <= 0) {
    vscode.window.showWarningMessage(
      'Token Coach: dollar estimates are disabled (usdPerAiu = 0). Set it to ~0.01 first, then calibrate.'
    );
    return;
  }

  const data = await loadAll(getOverridePath(), workspaceStorageBase);
  const monthStart = startOfMonthMs();
  let monthCostNano = 0;
  for (const r of data.requests) {
    if (r.timestamp >= monthStart) {
      monthCostNano += r.costNanoAiu;
    }
  }
  const ourUsd = (monthCostNano / 1e9) * config.usdPerAiu;
  if (ourUsd <= 0) {
    vscode.window.showWarningMessage('Token Coach: no usage recorded this month to calibrate against.');
    return;
  }

  const input = await vscode.window.showInputBox({
    title: 'Calibrate to GitHub billing',
    prompt:
      `We estimate $${ourUsd.toFixed(2)} used this month. Open your GitHub usage page and enter what it ` +
      `actually shows for THIS MONTH — a $ amount (best, e.g. 15.58) or a percentage (e.g. 82%).`,
    placeHolder: 'e.g. 15.58   or   82%',
    ignoreFocusOut: true,
  });
  if (!input) {
    return;
  }

  const trimmed = input.trim();
  let targetUsd: number;
  if (trimmed.endsWith('%')) {
    const pct = parseFloat(trimmed.slice(0, -1));
    if (!isFinite(pct)) {
      vscode.window.showErrorMessage('Token Coach: could not read that percentage.');
      return;
    }
    targetUsd = (pct / 100) * config.planMonthlyUsd;
  } else {
    targetUsd = parseFloat(trimmed.replace(/[$,\s]/g, ''));
    if (!isFinite(targetUsd)) {
      vscode.window.showErrorMessage('Token Coach: could not read that amount.');
      return;
    }
  }
  if (targetUsd <= 0) {
    vscode.window.showErrorMessage('Token Coach: the calibration target must be greater than 0.');
    return;
  }

  const newRate = Number((config.usdPerAiu * (targetUsd / ourUsd)).toFixed(6));
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('usdPerAiu', newRate, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    `Token Coach calibrated: 1 AIU ≈ $${newRate} (was $${config.usdPerAiu}). This month now ≈ $${targetUsd.toFixed(2)}. ` +
      `If the % still differs, set "tokenCoach.planMonthlyUsd" to your real monthly allowance (base + flex).`
  );
  await refresh();
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
  setExtensionVersion(String(context.extension.packageJSON.version ?? ''));
  workspaceStorageBase = deriveWorkspaceStorageBase(context);
  console.log('[Token Coach] workspaceStorage base:', workspaceStorageBase || '(derive failed; using OS defaults)');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tokenCoach.showDashboard';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenCoach.showDashboard', () => void showDashboard()),
    vscode.commands.registerCommand('tokenCoach.refresh', () => void refresh()),
    vscode.commands.registerCommand('tokenCoach.calibrate', () => void calibrateToGitHub())
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
