/**
 * report.ts
 * -----------------------------------------------------------------------------
 * Builds a portable Markdown report of your Copilot usage — the "save things you
 * can keep" piece. Exported on demand (command or dashboard button), plus a
 * daily history trend the extension records over time.
 */

import { ParsedData, MessageGroup, groupByChat, analyzeToolInventory } from './logParser';
import { CoachConfig } from './coach';
import { computeEfficiency, scoreMessages, windowStart } from './efficiency';
import { formatCost, formatUsd, formatTokensCompact } from './dashboard';

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One day's recorded headline numbers, for the efficiency/savings trend. */
export interface DailySnapshot {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  score: number;
  grade: string;
  allCostNanoAiu: number;
  monthCostNanoAiu: number;
  totalTokens: number;
}

/** Build the full Markdown report. Covers every request still in the logs on
 *  this machine; the daily and monthly tables are computed from the logs
 *  themselves, so they reach back as far as the logs do. */
export function buildMarkdownReport(data: ParsedData, config: CoachConfig, generatedAt: Date): string {
  const eff = computeEfficiency(data, config, windowStart(generatedAt.getTime()));
  const inv = analyzeToolInventory(data);
  const chats = groupByChat(data);
  const showUsd = config.usdPerAiu > 0;

  let totalCost = 0;
  const byModel = new Map<string, { requests: number; tokens: number; cost: number }>();
  for (const r of data.requests) {
    totalCost += r.costNanoAiu;
    const e = byModel.get(r.model) ?? { requests: 0, tokens: 0, cost: 0 };
    e.requests += 1;
    e.tokens += r.inputTokens + r.outputTokens;
    e.cost += r.costNanoAiu;
    byModel.set(r.model, e);
  }

  const usd = (nano: number) => (showUsd ? ` (≈ ${formatUsd(nano, config.usdPerAiu)})` : '');
  const L: string[] = [];

  L.push(`# Token Coach report`);
  L.push(`_Generated ${generatedAt.toLocaleString()} · covers every Copilot chat/agent request still in the logs on this machine (Copilot keeps its newest 50 sessions by default)_`);
  L.push('');

  // Headline
  // Point at the per-conversation files right away; they sit next to this report.
  if (chats.length) {
    L.push(`## Conversations`);
    L.push('');
    L.push(
      `One file per conversation in the \`sessions\` folder next to this report: \`.md\` to read, \`.json\` for tools. ` +
        `\`requests.csv\` and \`sessions.csv\` open in Excel.`
    );
    L.push('');
    L.push(`| Started | Conversation | Messages | Requests | Cost | Details |`);
    L.push(`| --- | --- | --: | --: | --: | --- |`);
    for (const c of [...chats].sort((a, b) => b.startTime - a.startTime)) {
      const title = c.title.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 60);
      L.push(
        `| ${localDay(new Date(c.startTime))} | ${title} | ${c.messages.length} | ${c.requestCount} | ${formatCost(c.totalCostNanoAiu)}${usd(c.totalCostNanoAiu)} | [open](sessions/${c.sessionId}.md) |`
      );
    }
    L.push('');
  }

  L.push(`## Summary`);
  L.push('');
  L.push(`| Metric | Value |`);
  L.push(`| --- | --- |`);
  if (eff.hasData) {
    const lost = eff.timingWasteNanoAiu + eff.qualityWasteNanoAiu;
    L.push(`| **Lost to avoidable cache misses (last 7 days)** | ${formatCost(lost)}${usd(lost)} of ${formatCost(eff.totalCostNanoAiu)} · score ${eff.score} (${eff.grade}) |`);
    L.push(`| After idle pauses | ${formatCost(eff.timingWasteNanoAiu)}${usd(eff.timingWasteNanoAiu)} (${eff.idleMisses}) |`);
    L.push(`| Model switches / broken cache | ${formatCost(eff.qualityWasteNanoAiu)}${usd(eff.qualityWasteNanoAiu)} (${eff.breakMisses}) |`);
    if (eff.topDrag) {
      L.push(`| Top drag | ${eff.topDrag} |`);
    }
  }
  L.push(`| Total logged (all time) | ${formatCost(totalCost)}${usd(totalCost)} |`);
  L.push(`| Requests | ${data.requests.length.toLocaleString()} |`);
  L.push(`| Chats | ${chats.length.toLocaleString()} |`);
  L.push('');

  // Model spend
  const models = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
  if (models.length) {
    L.push(`## Model spend`);
    L.push('');
    L.push(`| Model | Plan | Requests | Tokens | Cost |`);
    L.push(`| --- | --- | --: | --: | --: |`);
    for (const [model, m] of models) {
      const plan = m.cost > 0 ? 'billed' : 'included';
      L.push(
        `| ${model} | ${plan} | ${m.requests.toLocaleString()} | ${formatTokensCompact(m.tokens)} | ${formatCost(m.cost)}${usd(m.cost)} |`
      );
    }
    L.push('');
  }

  // Tool overhead
  if (inv.hasData) {
    const perReqTok = Math.round(inv.perRequestChars / 4);
    L.push(`## Tool overhead`);
    L.push('');
    L.push(`- ${inv.defined.length} tools defined, ≈${perReqTok.toLocaleString()} tok shipped every request (cached prefix).`);
    L.push(`- ${inv.unused.length} defined but never called (dead weight).`);
    if (inv.unused.length) {
      L.push('');
      L.push(`<details><summary>Never-called tools</summary>`);
      L.push('');
      for (const n of inv.unused) {
        L.push(`- \`${n}\``);
      }
      L.push('');
      L.push(`</details>`);
    }
    L.push('');
  }

  // Top chats by cost
  const topChats = [...chats].sort((a, b) => b.totalCostNanoAiu - a.totalCostNanoAiu).slice(0, 10);
  if (topChats.length) {
    L.push(`## Top chats by cost`);
    L.push('');
    L.push(`| Chat | Cost | Tokens | Cache |`);
    L.push(`| --- | --: | --: | --: |`);
    for (const c of topChats) {
      const title = c.title.replace(/\|/g, '\\|').slice(0, 60);
      L.push(
        `| ${title} | ${formatCost(c.totalCostNanoAiu)} | ${formatTokensCompact(c.totalInputTokens + c.totalOutputTokens)} | ${Math.round(c.cacheHitRate * 100)}% |`
      );
    }
    L.push('');
  }

  // Month and day tables, straight from the logs (local calendar days).
  const days = new Map<string, { start: number; requests: number; tokens: number; cost: number }>();
  const months = new Map<string, { requests: number; tokens: number; cost: number; days: number }>();
  for (const r of data.requests) {
    if (r.timestamp <= 0) {
      continue;
    }
    const d = new Date(r.timestamp);
    const key = localDay(d);
    const day = days.get(key) ?? {
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
      requests: 0,
      tokens: 0,
      cost: 0,
    };
    day.requests++;
    day.tokens += r.inputTokens + r.outputTokens;
    day.cost += r.costNanoAiu;
    days.set(key, day);
  }
  for (const [key, d] of days) {
    const m = months.get(key.slice(0, 7)) ?? { requests: 0, tokens: 0, cost: 0, days: 0 };
    m.requests += d.requests;
    m.tokens += d.tokens;
    m.cost += d.cost;
    m.days++;
    months.set(key.slice(0, 7), m);
  }
  if (months.size) {
    L.push(`## By month`);
    L.push('');
    L.push(`| Month | Active days | Requests | Cost | Total tokens |`);
    L.push(`| --- | --: | --: | --: | --: |`);
    for (const [key, m] of [...months].sort((a, b) => b[0].localeCompare(a[0]))) {
      L.push(
        `| ${key} | ${m.days} | ${m.requests.toLocaleString()} | ${formatCost(m.cost)}${usd(m.cost)} | ${formatTokensCompact(m.tokens)} |`
      );
    }
    L.push('');
  }
  if (days.size) {
    const messages: MessageGroup[] = chats.flatMap((c) => c.messages);
    L.push(`## By day`);
    L.push('');
    L.push(`Score = that day alone: 100 minus 2 points per 1% of the day's spend lost to avoidable cache misses.`);
    L.push('');
    L.push(`| Date | Requests | Cost | Lost to cache | Score | Total tokens |`);
    L.push(`| --- | --: | --: | --: | --: | --: |`);
    for (const [key, d] of [...days].sort((a, b) => b[0].localeCompare(a[0]))) {
      const next = new Date(d.start);
      next.setDate(next.getDate() + 1);
      const e = scoreMessages(messages, config, d.start, next.getTime());
      const lost = e.timingWasteNanoAiu + e.qualityWasteNanoAiu;
      L.push(
        `| ${key} | ${d.requests.toLocaleString()} | ${formatCost(d.cost)}${usd(d.cost)} | ${formatCost(lost)} | ${e.score} | ${formatTokensCompact(d.tokens)} |`
      );
    }
    L.push('');
  }

  L.push(`---`);
  L.push(`_Token Coach reads GitHub Copilot's local debug logs. Costs are in AIU (1 AIU = 1e9 NanoAiu); $ figures are estimates — your GitHub billing page is the source of truth._`);
  L.push('');
  return L.join('\n');
}
