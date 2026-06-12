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
  /** 0–100 — how close aggregate cache reuse is to the target rate. */
  cacheScore: number;
  /** 0–100 — share of messages with no real (warning/error) waste signal. */
  cleanScore: number;
  /** Aggregate cachedTokens / inputTokens across all messages, [0, 1]. */
  cacheHitRate: number;
  /** Number of messages with no warning/error issue. */
  cleanMessages: number;
  /** Total messages scored. */
  messageCount: number;
}

/** Cache hit rate that earns a perfect cache sub-score. ~70% is a healthy chat. */
const CACHE_TARGET = 0.7;
/** Weights: cache reuse dominates cost, so it carries the larger share. */
const CACHE_WEIGHT = 0.6;
const CLEAN_WEIGHT = 0.4;

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
 * Does this message carry a *real* waste signal? We count only `warning`/`error`
 * level issues (large input, low mid-chat cache, heavy attachments, expensive
 * request) — benign `info` notes (cold-start, slow-tool, tiny-output) are
 * expected and shouldn't drag the grade down.
 */
function messageHasIssue(group: MessageGroup, config: CoachConfig): boolean {
  const all = [...aggregateWarnings(group.requests, config), ...analyzeMessageDrivers(group, config)];
  const level = highestLevel(all);
  return level === 'warning' || level === 'error';
}

/**
 * Core scorer: turn any set of messages into a grade. Both the all-time
 * aggregate and the per-chat grade run through this, so they stay consistent.
 */
export function scoreMessages(messages: MessageGroup[], config: CoachConfig): EfficiencyScore {
  let totalInput = 0;
  let totalCached = 0;
  let cleanMessages = 0;

  for (const g of messages) {
    totalInput += g.totalInputTokens;
    totalCached += g.totalCachedTokens;
    if (!messageHasIssue(g, config)) {
      cleanMessages++;
    }
  }

  const messageCount = messages.length;
  const cacheHitRate = totalInput > 0 ? totalCached / totalInput : 0;
  const cacheScore = Math.min(100, Math.round((cacheHitRate / CACHE_TARGET) * 100));
  const cleanScore = messageCount > 0 ? Math.round((cleanMessages / messageCount) * 100) : 100;
  const score = Math.round(CACHE_WEIGHT * cacheScore + CLEAN_WEIGHT * cleanScore);

  return {
    hasData: messageCount > 0,
    score,
    grade: gradeForScore(score),
    cacheScore,
    cleanScore,
    cacheHitRate,
    cleanMessages,
    messageCount,
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
