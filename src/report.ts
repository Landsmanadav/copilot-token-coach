/**
 * report.ts
 * -----------------------------------------------------------------------------
 * Builds a portable Markdown report of your Copilot usage — the "save things you
 * can keep" piece. Exported on demand (command or dashboard button), plus a
 * daily history trend the extension records over time.
 */

import { ParsedData, groupByChat, analyzeToolInventory } from './logParser';
import { CoachConfig } from './coach';
import { computeEfficiency } from './efficiency';
import { formatCost, formatUsd, formatTokensCompact } from './dashboard';

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

/** Build the full Markdown report string for the given data + history.
 *  The data is month-scoped upstream (extension.ts), so all totals are
 *  "this month" and the report starts fresh each calendar month. */
export function buildMarkdownReport(
  data: ParsedData,
  config: CoachConfig,
  history: DailySnapshot[],
  generatedAt: Date
): string {
  const eff = computeEfficiency(data, config);
  const inv = analyzeToolInventory(data);
  const chats = groupByChat(data);
  const showUsd = config.usdPerAiu > 0;

  let monthCost = 0;
  const byModel = new Map<string, { requests: number; tokens: number; cost: number }>();
  for (const r of data.requests) {
    monthCost += r.costNanoAiu;
    const e = byModel.get(r.model) ?? { requests: 0, tokens: 0, cost: 0 };
    e.requests += 1;
    e.tokens += r.inputTokens + r.outputTokens;
    e.cost += r.costNanoAiu;
    byModel.set(r.model, e);
  }

  const usd = (nano: number) => (showUsd ? ` (≈ ${formatUsd(nano, config.usdPerAiu)})` : '');
  const L: string[] = [];

  const monthName = generatedAt.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  L.push(`# Token Coach report — ${monthName}`);
  L.push(`_Generated ${generatedAt.toLocaleString()} · covers the current calendar month only (resets on the 1st)_`);
  L.push('');

  // Headline
  L.push(`## Summary`);
  L.push('');
  L.push(`| Metric | Value |`);
  L.push(`| --- | --- |`);
  if (eff.hasData) {
    L.push(`| **Efficiency** | ${eff.grade} · ${eff.score}/100 (cache ${eff.cacheScore}, clean ${eff.cleanScore}) |`);
  }
  L.push(`| This month (logged) | ${formatCost(monthCost)}${usd(monthCost)} |`);
  if (showUsd && config.planMonthlyUsd > 0) {
    const mUsd = (monthCost / 1e9) * config.usdPerAiu;
    const pct = Math.round((mUsd / config.planMonthlyUsd) * 100);
    L.push(`| Of plan | ${formatUsd(monthCost, config.usdPerAiu)} of $${config.planMonthlyUsd.toFixed(0)} plan (${pct}%) |`);
  }
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

  // History trend
  if (history.length) {
    L.push(`## Daily trend`);
    L.push('');
    L.push(`| Date | Grade | Score | This-month cost | Total tokens |`);
    L.push(`| --- | --- | --: | --: | --: |`);
    for (const h of history.slice(-30)) {
      L.push(
        `| ${h.date} | ${h.grade} | ${h.score} | ${formatCost(h.monthCostNanoAiu)}${usd(h.monthCostNanoAiu)} | ${formatTokensCompact(h.totalTokens)} |`
      );
    }
    L.push('');
  }

  L.push(`---`);
  L.push(`_Token Coach reads GitHub Copilot's local debug logs. Costs are in AIU (1 AIU = 1e9 NanoAiu); $ figures are estimates — your GitHub billing page is the source of truth._`);
  L.push('');
  return L.join('\n');
}
