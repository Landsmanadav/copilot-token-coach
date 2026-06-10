/**
 * coach.ts
 * -----------------------------------------------------------------------------
 * The rules engine. Given a single `LlmRequestRecord` and a set of (configurable)
 * thresholds, it produces zero or more `CoachWarning`s explaining how the
 * developer could spend fewer tokens / less money.
 *
 * The key idea behind the whole extension: raw token counts are a poor proxy for
 * cost. `copilotUsageNanoAiu` is the real cost, and `cachedTokens` can slash it
 * by ~80%. So the rules lean heavily on cost and cache utilization.
 */

import { LlmRequestRecord, MessageGroup } from './logParser';

/** Severity for a warning. Drives row coloring in the dashboard. */
export type WarningLevel = 'info' | 'warning' | 'error';

export interface CoachWarning {
  /** Stable rule identifier, e.g. "expensive-request". */
  rule: string;
  level: WarningLevel;
  /** Human-readable, actionable advice. */
  message: string;
}

/** All the tunable thresholds, sourced from extension settings. */
export interface CoachConfig {
  /** NanoAiu above which a request is "expensive". */
  costWarnThreshold: number;
  /** inputTokens above which a request has a "large input". */
  inputWarnThreshold: number;
  /** Cache hit rate below which we warn (when input is also large). */
  lowCacheRateThreshold: number;
  /** Minimum inputTokens before the low-cache rule fires. */
  lowCacheMinInputTokens: number;
  /** inputTokens/outputTokens ratio above which output is "tiny". */
  ioRatioThreshold: number;
  /** Minimum inputTokens before the tiny-output rule fires (so "huge" means huge). */
  ioMinInputTokens: number;
  /** Share (0–1) of a turn's input that attachments/open files may occupy before warning. */
  attachmentShareWarn: number;
  /** A tool taking longer than this (ms) across a message is flagged. */
  slowToolWarnMs: number;
  /** US dollars per 1 AIU (GitHub: 1 AI credit = $0.01, 1 AIU ≈ 1 credit). 0 hides $. */
  usdPerAiu: number;
  /** Monthly plan price per user (Copilot Business = $19). Kept for status-bar tinting. */
  planMonthlyUsd: number;
  /**
   * Idle minutes after which the prompt cache is assumed to have expired. The
   * Claude (Anthropic) cache TTL is ~5 min (sliding); OpenAI's is ~5–10 min.
   */
  cacheIdleMinutes: number;
}

/** Sensible defaults, mirroring the values declared in package.json. */
export const DEFAULT_COACH_CONFIG: CoachConfig = {
  costWarnThreshold: 3_000_000_000,
  inputWarnThreshold: 50_000,
  lowCacheRateThreshold: 0.5,
  lowCacheMinInputTokens: 20_000,
  ioRatioThreshold: 1000,
  ioMinInputTokens: 10_000,
  attachmentShareWarn: 0.4,
  slowToolWarnMs: 10_000,
  usdPerAiu: 0.01,
  planMonthlyUsd: 19,
  cacheIdleMinutes: 5,
};

/** Rough chars→tokens estimate. Context payload sizes are measured in chars. */
const CHARS_PER_TOKEN = 4;

/**
 * A turn this small, with no tools and a single agent turn, is a quick edit or
 * Q&A — the kind a base (included) model handles fine. Above it, premium may be
 * justified, so we don't nag.
 */
const PREMIUM_TRIVIAL_MAX_INPUT = 8000;

/** Friendly idle-gap label from a count of minutes: "12 min", "1.5 h". */
function formatGapMinutes(mins: number): string {
  if (mins >= 90) {
    return `${(mins / 60).toFixed(1)} h`;
  }
  return `${mins} min`;
}

/**
 * Evaluate every rule against a single request.
 * Returns the list of warnings it triggered (possibly empty).
 */
export function analyzeRecord(record: LlmRequestRecord, config: CoachConfig): CoachWarning[] {
  const warnings: CoachWarning[] = [];

  // 1. Expensive request (the headline cost rule).
  if (record.costNanoAiu > config.costWarnThreshold) {
    warnings.push({
      rule: 'expensive-request',
      level: 'error',
      message: 'Expensive request — consider splitting the task into smaller, focused steps.',
    });
  }

  // NOTE: cache is judged at the *message* level (see analyzeMessageDrivers),
  // not per request. A single cold turn (e.g. turn 0) shouldn't make a
  // well-cached message look bad, and the first message of a chat is cold by
  // definition — both need chat context this per-request view doesn't have.

  // 2. Large input regardless of cache.
  if (record.inputTokens > config.inputWarnThreshold) {
    warnings.push({
      rule: 'large-input',
      level: 'warning',
      message: 'Large input — close irrelevant files/tabs so less context is sent each turn.',
    });
  }

  // 3. Huge input, tiny output — often a sign agent mode was overkill. Requires
  //    the input to actually be large, so trivial side-calls (e.g. a 2-token
  //    classification on 2K input) don't get mislabelled as "huge input".
  if (
    record.inputTokens > config.ioMinInputTokens &&
    record.outputTokens > 0 &&
    record.inputTokens / record.outputTokens > config.ioRatioThreshold
  ) {
    warnings.push({
      rule: 'tiny-output',
      level: 'info',
      message: 'Tiny output for a huge input — did this really need agent mode / full context?',
    });
  }

  return warnings;
}

/**
 * Aggregate warnings across a set of requests (one message group), de-duplicated
 * by rule. Used to summarize "what's wrong with this message" without repeating
 * the same advice once per turn.
 */
export function aggregateWarnings(records: LlmRequestRecord[], config: CoachConfig): CoachWarning[] {
  const byRule = new Map<string, CoachWarning>();
  for (const r of records) {
    for (const w of analyzeRecord(r, config)) {
      if (!byRule.has(w.rule)) {
        byRule.set(w.rule, w);
      }
    }
  }
  return [...byRule.values()];
}

/**
 * Message-level coaching that looks at *cost drivers* rather than a single
 * request: open files/attachments dominating context, and slow/heavy tools.
 * These complement the per-request rules and answer "what's taking too much?".
 */
export function analyzeMessageDrivers(group: MessageGroup, config: CoachConfig): CoachWarning[] {
  const warnings: CoachWarning[] = [];

  // Cache — judged on the message's AGGREGATE hit rate (not the worst single
  // turn), and aware of where the message sits in the chat:
  //   • First message of a chat → cache is cold by definition. Not a problem;
  //     show a calm info note only if it's actually low, never a warning.
  //   • Later message with low cache → the real signal: the chat likely grew
  //     past the cache window or its context changed.
  const isFirstInChat = group.chatMessageIndex === 0;
  const cacheLow =
    group.totalInputTokens > config.lowCacheMinInputTokens &&
    group.cacheHitRate < config.lowCacheRateThreshold;

  // Did enough idle time pass before this message to expire the prompt cache?
  // We have the real cache numbers, so we only blame idle when cache *also*
  // actually dropped — no false positives from a gap that stayed warm.
  const cacheIdleMs = Math.max(0, config.cacheIdleMinutes) * 60_000;
  const idleGap = group.idleGapMsBefore ?? 0;
  const idleExpired = !isFirstInChat && cacheIdleMs > 0 && idleGap >= cacheIdleMs;

  if (cacheLow && isFirstInChat) {
    warnings.push({
      rule: 'cold-start',
      level: 'info',
      message:
        'First message of the chat — caching starts cold, so low reuse here is expected. ' +
        'Staying in this chat reuses the cache (and lowers cost) on later turns.',
    });
  } else if (cacheLow && idleExpired) {
    const mins = Math.round(idleGap / 60_000);
    warnings.push({
      rule: 'cache-expired-idle',
      level: 'warning',
      message:
        `Cache went cold after a ~${formatGapMinutes(mins)} pause — past the ~5 min prompt-cache window, so ` +
        `the cached context expired and was re-billed at the full (much higher) input rate this turn. ` +
        `Keep a thread warm by sending the next message within ~5 min, or batch related questions together.`,
    });
  } else if (cacheLow) {
    warnings.push({
      rule: 'low-cache-hit',
      level: 'warning',
      message:
        'Low cache reuse mid-chat — the conversation likely outgrew the cache window or its ' +
        'context changed between turns. If this is a new/unrelated task, a fresh focused chat ' +
        'can be cheaper than continuing this large one.',
    });
  }

  // Attachments (open editors) eating a big share of the *controllable* context.
  // The system prompt and tool schemas are large but fixed and cached, and the
  // developer can't trim them — so we exclude them from the denominator and
  // measure attachments against the context the developer actually controls
  // (history, open files, memory, …).
  const FIXED = new Set(['systemPrompt', 'tools']);
  const totalCtxChars = group.peakContext
    .filter((s) => !FIXED.has(s.key))
    .reduce((s, c) => s + c.chars, 0);
  const attachChars = group.peakContext.find((s) => s.key === 'attachments')?.chars ?? 0;
  const attachTokens = attachChars / CHARS_PER_TOKEN;
  if (
    totalCtxChars > 0 &&
    attachChars / totalCtxChars > config.attachmentShareWarn &&
    attachTokens > 400
  ) {
    const share = Math.round((attachChars / totalCtxChars) * 100);
    const n = group.peakAttachments.length;
    warnings.push({
      rule: 'heavy-attachments',
      level: 'warning',
      message:
        `Open/attached files are ~${share}% of the logged context` +
        `${n ? ` (${n} file${n === 1 ? '' : 's'}, ≈${Math.round(attachTokens).toLocaleString()} tok)` : ''} — close unused editors/tabs.`,
    });
  }

  // Premium (billed) model used for a tiny, tool-free, single-turn ask — a base
  // model included in the plan would very likely have done it for $0. cost > 0
  // is Copilot's own signal that the request consumed premium budget.
  if (
    group.totalCostNanoAiu > 0 &&
    group.totalInputTokens < PREMIUM_TRIVIAL_MAX_INPUT &&
    group.toolCalls.length === 0 &&
    group.turnCount <= 1
  ) {
    const model =
      Object.entries(group.modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'a premium model';
    warnings.push({
      rule: 'premium-overkill',
      level: 'info',
      message:
        `Small, billed turn on ${model} (≈${Math.round(group.totalInputTokens / 1000)}k tok, no tools) — ` +
        `base models (e.g. GPT-4.1 / GPT-4o) are included in your plan. Pick one from the model dropdown for ` +
        `quick edits & questions to save premium budget.`,
    });
  }

  // A tool that dominated wall-clock time across the message.
  const slow = group.toolSummary.find((t) => t.durationMs > config.slowToolWarnMs);
  if (slow) {
    warnings.push({
      rule: 'slow-tool',
      level: 'info',
      message:
        `Tool "${slow.name}" took ${(slow.durationMs / 1000).toFixed(1)}s across ` +
        `${slow.calls} call${slow.calls === 1 ? '' : 's'} — heavy tool use lengthens turns and grows context.`,
    });
  }

  return warnings;
}

/** Rank used to pick the "worst" warning on a record. */
const LEVEL_RANK: Record<WarningLevel, number> = { info: 1, warning: 2, error: 3 };

/**
 * Return the most severe level among a set of warnings, or `undefined` if there
 * are none. Used by the dashboard to color a row.
 */
export function highestLevel(warnings: CoachWarning[]): WarningLevel | undefined {
  let worst: WarningLevel | undefined;
  for (const w of warnings) {
    if (!worst || LEVEL_RANK[w.level] > LEVEL_RANK[worst]) {
      worst = w.level;
    }
  }
  return worst;
}
