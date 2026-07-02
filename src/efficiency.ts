/**
 * efficiency.ts
 * -----------------------------------------------------------------------------
 * Collapses the per-message coaching signals (cache reuse + waste warnings) into
 * a single, glanceable **efficiency grade** (A–F) and score (0–100), computed
 * entirely from the GitHub Copilot debug-log data.
 *
 * The score is deliberately simple and explainable (the tooltip/card spells it
 * out), weighted toward cache because cached input is by far the biggest cost
 * lever in Copilot's NanoAiu billing.
 */

import { ParsedData, ChatGroup, MessageGroup, groupByChat } from './logParser';
import { CoachConfig, aggregateWarnings, analyzeMessageDrivers, highestLevel } from './coach';

export interface EfficiencyScore {
  /** False when there are no messages to score yet. */
  hasData: boolean;
  /** Overall 0–100 (weighted blend of the two sub-scores). */
  score: number;
  /** Letter grade derived from `score`. */
  grade: string;
  /**
   * 0–100 — cache reuse measured ONLY where reuse was possible: requests that
   * are not the first of their chat and follow the previous request within the
   * cache TTL ("warm-eligible"). A chat's first request is cold by definition
   * and short, focused chats are the CHEAP behaviour — neither should drag the
   * grade. -1 when no request was warm-eligible (score falls back to clean).
   */
  cacheScore: number;
  /** 0–100 — severity-weighted: each message scores 100 (clean/info), 50 (warning), 0 (error). */
  cleanScore: number;
  /** Cache rate over warm-eligible requests, [0, 1]. 0 when none were eligible. */
  cacheHitRate: number;
  /** True when at least one request was warm-eligible (cache sub-score applies). */
  hasCacheData: boolean;
  /** Number of messages with no warning/error issue at all. */
  cleanMessages: number;
  /** Total messages scored. */
  messageCount: number;
  /** The single biggest thing dragging the grade, human-readable. Undefined when nothing drags. */
  topDrag?: string;
}

/** Weights: cache reuse dominates cost, so it carries the larger share. */
const CACHE_WEIGHT = 0.6;
const CLEAN_WEIGHT = 0.4;

/** Short human phrasing for the rules that can drag the grade. */
const DRAG_LABELS: Record<string, (n: number) => string> = {
  'cache-expired-idle': (n) => `cache lost to >TTL idle gaps in ${n} message${n === 1 ? '' : 's'}`,
  'low-cache-hit': (n) => `low mid-chat cache reuse in ${n} message${n === 1 ? '' : 's'}`,
  'heavy-attachments': (n) => `open/attached files dominate context in ${n} message${n === 1 ? '' : 's'}`,
  'large-input': (n) => `very large prompts in ${n} message${n === 1 ? '' : 's'}`,
  'expensive-request': (n) => `expensive requests in ${n} message${n === 1 ? '' : 's'}`,
};

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

/**
 * Core scorer: turn any set of messages into a grade. Both the all-time
 * aggregate and the per-chat grade run through this, so they stay consistent.
 *
 * The philosophy (v2.3): measure AVOIDABLE waste only.
 *   • Cache — judged only on "warm-eligible" requests: not the first request of
 *     their chat, and within the cache TTL of the previous request. A chat's
 *     first request is structurally cold, and a user who asks one focused
 *     question per chat is being CHEAP, not inefficient — the old aggregate
 *     ratio punished exactly that (and rewarded long agent loops that burn far
 *     more credits at a high hit-rate). No warm-eligible requests → the cache
 *     component simply doesn't apply and the grade rests on clean runs.
 *   • Clean — severity-weighted with partial credit (warning = 50, error = 0)
 *     instead of the old binary clean/dirty.
 */
export function scoreMessages(messages: MessageGroup[], config: CoachConfig): EfficiencyScore {
  const messageCount = messages.length;

  // ---- Cache component: walk each chat's requests chronologically; a request
  // is warm-eligible when the previous model call in the same chat happened
  // within the cache TTL — i.e. the prefix SHOULD still be warm.
  const bySession = new Map<string, MessageGroup[]>();
  for (const g of messages) {
    const list = bySession.get(g.sessionId);
    if (list) {
      list.push(g);
    } else {
      bySession.set(g.sessionId, [g]);
    }
  }
  const idleMs = config.cacheIdleMinutes > 0 ? config.cacheIdleMinutes * 60_000 : Infinity;
  let eligibleInput = 0;
  let eligibleCached = 0;
  for (const groups of bySession.values()) {
    const requests = groups
      .flatMap((g) => g.requests)
      .sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < requests.length; i++) {
      const gap = requests[i].timestamp - requests[i - 1].timestamp;
      if (gap < idleMs && requests[i].inputTokens > 0) {
        eligibleInput += requests[i].inputTokens;
        eligibleCached += requests[i].cachedTokens;
      }
    }
  }
  const hasCacheData = eligibleInput > 0;
  const cacheHitRate = hasCacheData ? eligibleCached / eligibleInput : 0;
  const target = Math.max(0.05, Math.min(1, config.cacheTargetRate));
  const cacheScore = hasCacheData ? Math.min(100, Math.round((cacheHitRate / target) * 100)) : -1;

  // ---- Clean component: severity-weighted partial credit, plus the top drag.
  let sevSum = 0;
  let cleanMessages = 0;
  const dragCounts = new Map<string, number>();
  for (const g of messages) {
    const all = [...aggregateWarnings(g.requests, config), ...analyzeMessageDrivers(g, config)];
    const level = highestLevel(all);
    if (level === 'error') {
      sevSum += 0;
    } else if (level === 'warning') {
      sevSum += 50;
    } else {
      sevSum += 100;
      cleanMessages++;
      continue;
    }
    for (const w of all) {
      if (w.level === 'warning' || w.level === 'error') {
        dragCounts.set(w.rule, (dragCounts.get(w.rule) ?? 0) + 1);
      }
    }
  }
  const cleanScore = messageCount > 0 ? Math.round(sevSum / messageCount) : 100;

  const score = hasCacheData
    ? Math.round(CACHE_WEIGHT * cacheScore + CLEAN_WEIGHT * cleanScore)
    : cleanScore;

  // ---- Top drag: the most frequent warning/error rule; if none, a below-target
  // warm cache is the only other thing that can be dragging.
  let topDrag: string | undefined;
  const worstRule = [...dragCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worstRule) {
    topDrag = (DRAG_LABELS[worstRule[0]] ?? ((n: number) => `${worstRule[0]} in ${n} message${n === 1 ? '' : 's'}`))(worstRule[1]);
  } else if (hasCacheData && cacheScore < 100) {
    topDrag = `warm-chat cache reuse at ${Math.round(cacheHitRate * 100)}% (target ${Math.round(target * 100)}%)`;
  }

  return {
    hasData: messageCount > 0,
    score,
    grade: gradeForScore(score),
    cacheScore,
    cleanScore,
    cacheHitRate,
    hasCacheData,
    cleanMessages,
    messageCount,
    topDrag,
  };
}

/** Compute the all-time efficiency score from already-grouped chats. */
export function computeEfficiencyFromChats(chats: ChatGroup[], config: CoachConfig): EfficiencyScore {
  const messages: MessageGroup[] = [];
  for (const chat of chats) {
    messages.push(...chat.messages);
  }
  return scoreMessages(messages, config);
}

/** Score a single chat (session) on its own. Used for the per-chat grade badge. */
export function computeChatEfficiency(chat: ChatGroup, config: CoachConfig): EfficiencyScore {
  return scoreMessages(chat.messages, config);
}

/** Convenience wrapper: group raw parsed data, then score it. Used by the status bar. */
export function computeEfficiency(data: ParsedData, config: CoachConfig): EfficiencyScore {
  return computeEfficiencyFromChats(groupByChat(data), config);
}
