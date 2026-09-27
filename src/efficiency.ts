/**
 * efficiency.ts
 * -----------------------------------------------------------------------------
 * The efficiency grade (A–F, 0–100). v2.4: it measures ONE thing — money lost
 * to avoidable prompt-cache misses — as a share of what was spent.
 *
 * Why only cache: it is the one big cost lever the developer controls. Large
 * prompts and expensive agent runs are what real work looks like on a big repo;
 * the old grade penalised them and ended up grading the task, not the habit.
 * They still show up as tips on the message rows, they just don't move the grade.
 *
 * How a request is judged:
 *   • It is compared with the previous call on the SAME model in the same chat
 *     (a different model can never reuse another model's cache). The prefix it
 *     could have reused is min(its input, that call's input).
 *   • Reuse at or above half of that prefix counts as warm. Below it is a miss.
 *   • A miss after a pause longer than the cache TTL (from the end of the last
 *     call) is a TIMING miss: the user let the cache expire.
 *   • Inside the TTL, a message that switched the chat to another model is a
 *     QUALITY miss: the whole history was re-billed on the new model.
 *   • A miss inside the TTL on a Claude model is a QUALITY miss: something in the
 *     context changed and broke the prefix. Claude's cache is deterministic, so
 *     this is real. OpenAI-family caching is best-effort and routing-dependent
 *     (measured: misses at 0 s gaps), so those are counted as provider misses and
 *     kept out of the grade.
 *   • Money lost = missed tokens × (fresh − cached) price per token, with the
 *     per-token price taken from the request's own logged cost.
 */

import { ParsedData, ChatGroup, MessageGroup, LlmRequestRecord, groupByChat } from './logParser';
import { CoachConfig } from './coach';

export interface EfficiencyScore {
  /** False when there are no messages to score yet. */
  hasData: boolean;
  /** Overall 0–100: 100 minus the avoidable-waste share, scaled. */
  score: number;
  /** Letter grade derived from `score`. */
  grade: string;
  /** 0–100 — the same scale applied to timing waste alone (pauses past the TTL). */
  timingScore: number;
  /** 0–100 — the same scale applied to quality waste alone (broken prefix, model switch). */
  qualityScore: number;
  /** Money lost to cache expiry after idle pauses (NanoAiu). */
  timingWasteNanoAiu: number;
  /** Money lost to a broken prefix or a mid-chat model switch (NanoAiu). */
  qualityWasteNanoAiu: number;
  /** Everything spent in the scored messages (NanoAiu). */
  totalCostNanoAiu: number;
  /** Requests where cache reuse was possible and was checked. */
  checkedRequests: number;
  /** Misses caused by pauses past the TTL. */
  idleMisses: number;
  /** Misses caused by a broken prefix or model switch. */
  breakMisses: number;
  /** Misses on best-effort (non-Claude) caching — shown, not graded. */
  providerMisses: number;
  /** Total messages scored. */
  messageCount: number;
  /** Only requests at or after this time (and before `untilTs`, if given) were counted. 0 = all time. */
  sinceTs: number;
  /** The single biggest thing dragging the grade, human-readable. Undefined when nothing drags. */
  topDrag?: string;
}

/** Reuse below this share of the reusable prefix is a miss. */
const MISS_BELOW = 0.5;
/** Prefixes smaller than this can't be cached by the providers at all. */
const MIN_CACHEABLE_TOKENS = 2048;
/** Each 1% of spend lost costs this many points: 5% lost → 90, 10% → 80, 25% → 50. */
const POINTS_PER_WASTE_PCT = 2;
/** Rough chars→tokens estimate for the logged context sizes. */
const CHARS_PER_TOKEN = 4;

/** Claude's prompt cache is deterministic; other providers' is best-effort. */
function hasDeterministicCache(model: string): boolean {
  return /claude|anthropic/i.test(model);
}

/** Map a 0–100 score to a school-style letter grade. */
export function gradeForScore(score: number): string {
  if (score >= 90) {
    return 'A';
  }
  if (score >= 75) {
    return 'B';
  }
  if (score >= 60) {
    return 'C';
  }
  if (score >= 45) {
    return 'D';
  }
  return 'F';
}

function scoreFromWaste(waste: number, total: number): number {
  if (total <= 0) {
    return 100;
  }
  return Math.max(0, Math.round(100 - (waste / total) * 100 * POINTS_PER_WASTE_PCT));
}

/**
 * NanoAiu saved per token when an input token is read from cache instead of
 * sent fresh, derived from this request's own logged cost and the price weights.
 */
function savingPerCachedToken(r: LlmRequestRecord, config: CoachConfig): number {
  const fresh = Math.max(0, r.inputTokens - r.cachedTokens);
  const weighted =
    fresh * config.costInputWeight +
    r.cachedTokens * config.costCachedInputWeight +
    r.outputTokens * config.costOutputWeight;
  if (weighted <= 0 || r.costNanoAiu <= 0) {
    return 0;
  }
  const perWeight = r.costNanoAiu / weighted;
  return perWeight * Math.max(0, config.costInputWeight - config.costCachedInputWeight);
}

/** System prompt + tool definitions: the part of a prompt every chat pays for. */
function fixedPromptTokens(r: LlmRequestRecord): number {
  let chars = 0;
  for (const s of r.contextBreakdown ?? []) {
    if (s.key === 'systemPrompt' || s.key === 'tools') {
      chars += s.chars;
    }
  }
  return chars / CHARS_PER_TOKEN;
}

const fmtMoney = (nano: number, usdPerAiu: number): string =>
  usdPerAiu > 0 ? `$${((nano / 1e9) * usdPerAiu).toFixed(2)}` : `${(nano / 1e9).toFixed(1)} credits`;

/**
 * Core scorer: turn any set of messages into a grade. Both the all-time
 * aggregate and the per-chat grade run through this, so they stay consistent.
 */
export function scoreMessages(
  messages: MessageGroup[],
  config: CoachConfig,
  sinceTs = 0,
  untilTs = Infinity
): EfficiencyScore {
  const ttlMs = config.cacheIdleMinutes > 0 ? config.cacheIdleMinutes * 60_000 : Infinity;

  const bySession = new Map<string, MessageGroup[]>();
  for (const g of messages) {
    const list = bySession.get(g.sessionId);
    if (list) {
      list.push(g);
    } else {
      bySession.set(g.sessionId, [g]);
    }
  }

  let totalCost = 0;
  let timingWaste = 0;
  let qualityWaste = 0;
  let checked = 0;
  let idleMisses = 0;
  let breakMisses = 0;
  let providerMisses = 0;
  let counted = 0;

  for (const groups of bySession.values()) {
    groups.sort((a, b) => a.startTime - b.startTime);
    const lastByModel = new Map<string, LlmRequestRecord>();
    let lastInSession: LlmRequestRecord | undefined;
    for (const g of groups) {
      const reqs = [...g.requests].sort((a, b) => a.timestamp - b.timestamp);
      reqs.forEach((r, i) => {
        // Earlier requests still walk the chain (they are the baseline a later
        // request is compared with); only the window's requests are counted.
        const inWindow = r.timestamp >= sinceTs && r.timestamp < untilTs;
        if (inWindow) {
          totalCost += r.costNanoAiu;
          counted++;
        }
        const sameModelPrev = lastByModel.get(r.model);
        // A model switch only counts at a message boundary: background helpers
        // on other models run inside a message and never share its cache.
        const switched = !sameModelPrev && i === 0 && lastInSession !== undefined;
        const prev = sameModelPrev ?? (switched ? lastInSession : undefined);
        lastByModel.set(r.model, r);
        lastInSession = r;
        if (!inWindow || !prev || r.inputTokens <= 0) {
          return;
        }
        const reusable = Math.min(r.inputTokens, prev.inputTokens);
        if (reusable < MIN_CACHEABLE_TOKENS) {
          return;
        }
        checked++;
        if (!switched && r.cachedTokens >= reusable * MISS_BELOW) {
          return;
        }
        const missed = Math.max(0, reusable - r.cachedTokens);
        const saving = savingPerCachedToken(r, config);
        // After a pause or a model switch, even a fresh chat would pay the
        // system prompt and tool definitions cold. Only the history was avoidable.
        const historyMissed = Math.max(0, missed - fixedPromptTokens(r));
        const gap = r.timestamp - (prev.timestamp + prev.durationMs);
        if (gap >= ttlMs) {
          // Past the TTL the cache was gone anyway, switch or not.
          if (historyMissed > 0) {
            timingWaste += historyMissed * saving;
            idleMisses++;
          }
        } else if (switched) {
          if (historyMissed > 0) {
            qualityWaste += historyMissed * saving;
            breakMisses++;
          }
        } else if (hasDeterministicCache(r.model)) {
          qualityWaste += missed * saving;
          breakMisses++;
        } else {
          providerMisses++;
        }
      });
    }
  }

  const score = scoreFromWaste(timingWaste + qualityWaste, totalCost);

  let topDrag: string | undefined;
  if (timingWaste > 0 || qualityWaste > 0) {
    const money = (n: number) => fmtMoney(n, config.usdPerAiu);
    topDrag =
      timingWaste >= qualityWaste
        ? `${money(timingWaste)} lost to ${idleMisses} idle pause${idleMisses === 1 ? '' : 's'}`
        : `${money(qualityWaste)} lost to ${breakMisses} cache break${breakMisses === 1 ? '' : 's'}`;
  }

  return {
    hasData: counted > 0,
    score,
    grade: gradeForScore(score),
    timingScore: scoreFromWaste(timingWaste, totalCost),
    qualityScore: scoreFromWaste(qualityWaste, totalCost),
    timingWasteNanoAiu: timingWaste,
    qualityWasteNanoAiu: qualityWaste,
    totalCostNanoAiu: totalCost,
    checkedRequests: checked,
    idleMisses,
    breakMisses,
    providerMisses,
    messageCount: messages.length,
    sinceTs,
    topDrag,
  };
}

/** The headline window: the grade and the money lost cover the last 7 days. */
export const WINDOW_DAYS = 7;

/** Start of the headline window (local midnight, 7 days back including today). */
export function windowStart(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (WINDOW_DAYS - 1));
  return d.getTime();
}

/** Score already-grouped chats; pass `sinceTs` to count only a recent window. */
export function computeEfficiencyFromChats(
  chats: ChatGroup[],
  config: CoachConfig,
  sinceTs = 0
): EfficiencyScore {
  const messages: MessageGroup[] = [];
  for (const chat of chats) {
    messages.push(...chat.messages);
  }
  return scoreMessages(messages, config, sinceTs);
}

/** Score a single chat (session) on its own. Used for the per-chat grade badge. */
export function computeChatEfficiency(chat: ChatGroup, config: CoachConfig): EfficiencyScore {
  return scoreMessages(chat.messages, config);
}

/** Convenience wrapper: group raw parsed data, then score it. */
export function computeEfficiency(data: ParsedData, config: CoachConfig, sinceTs = 0): EfficiencyScore {
  return computeEfficiencyFromChats(groupByChat(data), config, sinceTs);
}
