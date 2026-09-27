# Changelog

All notable changes to **Token Coach** are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.0] - 2026-09-27

### Changed — export
- **No save dialog.** Export writes straight to Token Coach's own local folder (the extension's
  global storage, `exports/token-coach-export-<date-time>`), opens `report.md`, and offers
  **Open folder**. Never inside the open repo, never a synced Documents folder. The newest 20
  exports are kept. New command: *Token Coach: Open Exports Folder*.
- **The report opens with a Conversations list**: every conversation with date, messages,
  requests, cost and an *open* link to its own file in `sessions/`. In 2.5 those per-conversation
  files existed but nothing pointed to them.
- **Readable titles.** When Copilot's title helper refused ("Sorry, I can't assist with that.")
  and stored that as the title, the conversation now shows the first message you typed.
- **The report reaches back as far as the logs do.** New *By month* and *By day* tables are built
  from the logs themselves, with each day's cache-waste score. The old *Daily trend* table showed
  only the last 30 daily snapshots, so a report looked like one month even with logs from June.

## [2.5.0] - 2026-09-27

### Added — per-session export (schema `token-coach.session/0.1`)
- **Export writes a folder**, not one file: `report.md` (the overall report), and per session
  `sessions/<id>.json` + `sessions/<id>.md`, plus `requests.csv` and `sessions.csv`.
- **Raw first.** Every numeric field on each `llm_request` line is copied as emitted, under the
  log's own names. Derived values sit apart and name their formula. Missing values are
  `"unknown"`, never zero; options that were logged but not set are `"not sent"`.
- **Per request:** purpose (`debugName`), model, status, reasoning effort / thinking budget,
  prompt size and share of the model's max prompt, long-context flag, context sources,
  attachments, and the log file + line to verify it.
- **Billing reconciliation:** credits and dollars from `copilotUsageNanoAiu`, next to credits
  recomputed from the session's own model catalog (`models.json` prices), and the gap. Two
  corrections, measured on 282 requests, close the gap to 0.025%: Claude bills new prompt
  tokens as cache writes (1.25× input), and the catalog rounds cache prices to whole units
  (gpt-5-mini lists 2, bills 2.5).
- **Per session:** VS Code and Copilot Chat versions, workspace folder, the VS Code chat session
  that mentions this log, coverage (which artifacts exist, unreadable lines, cut-off last line,
  what the logs never carry), child sessions (title helpers, subagents) with their own cost,
  the thresholds in force, and the cache-waste score marked as a heuristic.

### Changed
- **The dashboard tab title shows this month's spend**, not everything ever logged. The month
  starts like Copilot billing does: 00:00 UTC on the 1st.

## [2.4.0] - 2026-09-27

### Changed — a grade that works on real work
- **The grade now measures one thing: money lost to avoidable cache misses**, as a
  share of spend. The old grade penalized big prompts and expensive requests,
  which is what real work on a large repo looks like, while its cache score sat
  near 100% because agent loops are always warm. It graded the task, not the habit.
- **Two sub-scores: cache timing and cache quality.** Timing = the chat went idle
  past the ~5 min TTL (measured from the end of the last call, not its start).
  Quality = a model switch mid-chat, or a Claude cache miss inside the TTL.
- **Fair baselines.** Each request is compared with the previous call on the
  same model. After a pause or switch, the system prompt and tool definitions
  (which a fresh chat pays anyway) are not counted as waste. GPT-family misses
  inside the TTL are reported, not graded: their caching is best-effort.
- **The headline is money, over the last 7 days.** The card reads "Wasted · 7 days: $3.40 of
  $20.00 spent", split into idle pauses and model switches / broken cache, with the score beside it.
  Score = 100 minus 2 points per 1% of spend lost. The status bar shows the same score, and each
  day's point on the trend covers that day alone (before, every number was all-time and barely moved).
- **"Cache went cold" tips judge the message's first request.** The message
  average hid a cold restart behind the warm agent-loop turns that follow it.

### Changed — 19 settings down to 2
- Only display choices remain: `tokenCoach.showCostsIn` (dollars / credits) and
  `tokenCoach.popups`. Every threshold, the price weights, the poll interval and
  the popup timeout are now fixed defaults.

### Changed — clearer dashboard
- "Cache hit rate" card renamed **Input from cache** (all requests), so it no
  longer reads as contradicting the grade's cache scores.
- Removed the "Token mix" card; the Token & cost breakdown panel shows the same
  split in full.

### Fixed
- **"Enable logging" could report success while logging stayed off** when a
  workspace setting turned it off. It now enables it at workspace level too, and
  warns if a folder or policy setting still overrides it.

## [2.3.0] - 2026-07-02

### Changed — a fairer efficiency grade (measures avoidable waste only)
- **Warm-chat cache scoring.** The old grade used the aggregate cache ratio,
  which structurally rewarded long agent loops (high hit-rate, high cost) and
  punished short, focused questions (cold start, tiny cost) — many users sat at
  a permanent C at work for using Copilot *cheaply*. Cache reuse is now judged
  only on requests where reuse was actually possible: same chat, within the
  cache TTL. A chat's first request and one-off questions are never penalized;
  when nothing was warm-eligible, the grade simply rests on clean runs.
- **Partial credit for clean runs.** A message now scores 100 (clean), 50
  (warning) or 0 (error) instead of the old binary clean/dirty.
- **"Top drag" transparency.** The efficiency card, status-bar tooltip, chat
  badges and the exported report now name the single biggest thing pulling the
  grade down (e.g. "cache lost to >TTL idle gaps in 9 messages") — a grade you
  can act on, not just a letter.
- **New setting `tokenCoach.cacheTargetRate`** (default `0.7`) — the warm-chat
  hit rate that earns a perfect cache sub-score.
- **Section panels remember you.** Token & cost breakdown, Model spend and the
  Efficiency trend open by default, but collapsing one now survives every
  refresh (same memory as chats/messages) instead of snapping back open.

### Changed — the dashboard got an instrument-panel redesign
- **Editor-native "instrument panel" look.** Every numeral now renders in *your*
  editor's mono font with tabular figures; labels became uppercase micro-type
  with wide tracking; hairline rules and a faint graph-paper backdrop replace
  heavy boxes. Built entirely from VS Code theme variables — no fonts, no
  images, no libraries (the webview's strict CSP stays `default-src 'none'`).
- **A sticky masthead** with the Token Coach mark, version, a pulsing **live**
  badge (the panel auto-refreshes as Copilot writes its logs) and quiet
  outline-style actions.
- **KPI tiles** carry a 2px semantic accent line (hero = blue→green, efficiency
  = its grade colour, flags = red), and the "Today" hero is deliberately the
  biggest number on screen.
- **Grafana-style section rails** ("Why it cost…", "Where the tokens went",
  "Turn-by-turn"), uppercase table headers with row hover, and a staggered
  entrance animation (disabled under `prefers-reduced-motion`).

### Fixed
- **Could contend with Copilot on the shared extension host.** Every refresh
  re-read and re-parsed *all* debug-log files from scratch (~100 ms of synchronous
  CPU — `JSON.parse` of multi-MB payloads + regex scans). Because the file watcher
  fires continuously while Copilot writes its own debug log during a live session,
  that ~100 ms blocked the shared VS Code extension host repeatedly, right when
  Copilot was streaming — which could stall or disconnect it. Token Coach now
  **caches each file's parsed result by (mtime, size)** and only re-parses the one
  file that actually changed, cutting a refresh from ~100 ms to ~2–4 ms. Purely a
  performance fix; the numbers shown are unchanged.
- **Chat titles no longer go missing under the new cache.** A chat's generated
  title lives in a separate `title-*.jsonl` sidecar that Copilot often finishes
  writing *after* the last `main.jsonl` append — so the parse cache could freeze a
  finished chat on the generic "Chat a1b2…" fallback forever. Cached entries
  without a title now re-check just that sidecar (one tiny async read — no
  re-parse, no synchronous CPU, so the contention fix above stays intact).
- **The spend chart now says when it's windowed.** The daily-spend chart draws at
  most the last ~92 days so it stays readable; with older history it now shows a
  "(last 92 days)" tag and labels its total "in this window" instead of quietly
  contradicting the all-time totals elsewhere on the page.
- **Chat list cap raised 100 → 300.** With all history kept and grouped by month,
  a low cap could silently swallow the older months at the bottom of the list.

### Removed
- **The `tokenCoach.planMonthlyUsd` setting.** It promised budget-based status-bar
  tinting and a monthly reset — both removed in 2.2.0 — so the setting did nothing
  and its description was misleading. (An existing value in your settings.json is
  simply ignored.)

## [2.2.0] - 2026-07-01

Stops competing with Copilot's own credit meter. The old "used this month" figure
could only ever see the slice Copilot wrote to this machine's local debug logs, so
it read far below GitHub's number and looked broken. Token Coach now leads with
**today's** spend (a small, honest window) and keeps your whole history instead of
wiping it every month.

### Changed
- **Status bar leads with "today", not "this month".** The headline is now the
  credits used since local midnight — a figure that doesn't invite a mismatch with
  Copilot's monthly meter. The tooltip shows today plus an all-time logged total,
  and states plainly that this is only local chat/agent logs (so it reads lower
  than your account meter — use Copilot's own status menu for the real total).
- **History is kept across months.** Nothing is dropped when a new month starts.
  The chat list is now grouped **month → day → chat**: the current month is
  expanded, older months collapse to a one-line header you click to open. Opening
  a past month reveals its most recent day.
- **Dashboard totals are all-time.** The summary cards, "Spend over time" chart
  (up to the last ~92 days), model spend and coverage banner now describe your
  full logged history rather than a single calendar month.
- **Status-bar tint follows efficiency only.** No plan/budget tint — Token Coach
  doesn't track a monthly quota.

### Removed
- **The "Used · this month" card.** Copilot's own status menu already shows your
  monthly credit total, and the local logs only ever capture a fraction of it, so
  mirroring it was misleading. Removed in favour of the honest "Today" headline.

### Fixed
- **No more "enable logging" nudge once it's already on.** When there's nothing
  logged yet, the status bar now checks whether Copilot debug logging is actually
  on: if it is (e.g. a fresh setup, or a new month with rotated logs), it says
  "no usage yet" instead of telling you to turn on a setting that's already on.

## [2.1.0] - 2026-06-29

A focused usability pass: the chat list is easier to scan, the settings are far
shorter, and notifications get out of your way on their own.

### Added
- **Chats grouped by day.** The chat list is now split into collapsible day
  sections — **Today** is expanded by default, older days (Yesterday, then dated
  headers) collapse to a one-line summary you click to open. Each day header
  shows its chat count and total cost. Open/closed state is remembered across
  refreshes, like chats and messages.
- **Self-dismissing notifications.** Cost alerts and efficiency tips now close
  themselves after a few seconds so they never pile up, controlled by the new
  **`tokenCoach.notificationAutoDismissSeconds`** setting (default `3`; set `0`
  to keep classic sticky notifications with an *Open Dashboard* button).

### Changed
- **Settings slimmed down to the two that matter.** The top-level *Token Coach*
  section now holds just the **alert threshold** (`costWarnThreshold`) and the
  **monthly budget** (`planMonthlyUsd`), each rewritten with a fuller
  explanation. Everything else — token/cache warning tuning, price weights,
  notification toggles, poll interval — moved under **Token Coach: Advanced**.
- **Alert threshold raised from 3 to 25 credits.** The default no longer fires a
  notification until a single request crosses ~$0.25, so only genuinely
  expensive requests interrupt you. Existing custom values are untouched.

## [2.0.0] - 2026-06-19

A big visual release: the dashboard is rebuilt around real charts, a brand-new
user gets a one-click start, and the settings are reorganized to be readable. The
underlying logic and numbers are unchanged — same honest, local-only data, shown
far better.

### Added
- **Redesigned, chart-driven dashboard**, built on a new **zero-dependency
  inline-SVG chart kit** (`charts.ts`). No charting library, so it stays inside
  the webview's strict CSP and themes entirely through VS Code's chart palette
  (tracks light/dark automatically):
  - a dense **KPI grid** — *Used this month* with an **interactive daily-spend
    sparkline**, *Today*, an **Efficiency ring**, a **Cache ring**, and a
    **token-mix bar**;
  - **Spend over the month** — daily **stacked columns** split into fresh /
    cached / output, with the spike days obvious and per-day hover detail;
  - **Spend by model** — ranked horizontal bars (billed vs included);
  - a **Token & cost breakdown donut**;
  - an **interactive Efficiency trend** line chart with a **crosshair + tooltip
    that follows the mouse**, a fixed 0–100 scale, and A / B–C / D–F grade bands
    so the height actually means something;
  - a per-chat relative **cost bar**, so the priciest chats stand out at a glance.
- **One-click onboarding** — when Copilot debug logging is off, the empty state
  shows an **⚡ Enable Copilot logging** button that flips the two Copilot
  settings for you (no copy-pasting setting ids), plus a matching
  **`Token Coach: Enable Copilot Logging`** command.
- **⚙ Settings button** in the dashboard toolbar (and the empty state), opening
  Token Coach's settings.

### Changed
- **Settings reorganized into three labelled groups** — *Token Coach*
  (notifications + money), *Token Coach: Warnings* (the flag thresholds), and
  *Token Coach: Advanced* (cost-split weights + internals) — each with a
  plain-language description, so a new user isn't faced with a wall of numbers.
- **BREAKING — `tokenCoach.costWarnThreshold` is now measured in credits**
  (default `3`) instead of raw NanoAiu (`3000000000`). If you previously
  customised it, divide your value by 1,000,000,000 (e.g. `3000000000` → `3`).
  Defaults are unaffected.

### Removed
- **`tokenCoach.workspaceStoragePathOverride` removed from the Settings UI.**
  Auto-detection already covers every standard install; the override still works
  if set directly in `settings.json` for non-standard installs or testing.

## [1.1.1] - 2026-06-18

### Added
- **"Token & cost breakdown" section** on the dashboard, splitting your usage
  into three buckets — **fresh input**, **cached input**, and **output** — each
  with its token count, token share, and estimated AIU. Token counts come
  straight from the logs; the per-bucket AIU is **modelled** from the token mix,
  while the total AIU always matches the logs exactly (the Copilot log records
  only one total cost per request, no per-component cost).
- **"Token mix" summary card** showing the headline input-vs-output token share —
  a high input share with little output is the classic "shovel in context, get
  little produced" signal.
- **In/Out token-share chips** on each message and chat header, and a new **In/Out
  column** in the Model spend table (hover a row for the fresh/cached/output
  split and the estimated per-bucket AIU).
- Three new configurable price weights used **only** to distribute each request's
  real, logged AIU across the buckets: `tokenCoach.costInputWeight` (default `1`),
  `tokenCoach.costCachedInputWeight` (default `0.1`), and
  `tokenCoach.costOutputWeight` (default `4`). Changing them never changes the
  exact total — only how the estimated split is drawn.

### Changed
- README Marketplace badge simplified to a single "Install" badge.

## [1.1.0] - 2026-06-16

### Added
- **"Tools you might not need" banner** at the top of the dashboard. Flags tools
  that are offered to the model on every request but go consistently unused
  across your chats, using a **net counter**: +1 for each chat a tool was offered
  but never called, −1 (floored at 0) for each chat it *was* called in. A tool is
  listed once its score reaches `tokenCoach.unusedToolMinChats` (default `3`), and
  it drops off automatically the moment you use it again — so the advice
  self-corrects. Framed honestly as "unused in your logged chats," not "safe to
  delete." New configurable setting `tokenCoach.unusedToolMinChats`.
- **`Token Coach: Open Settings` command** — opens the Settings UI pre-filtered to
  Token Coach's settings, so every tunable threshold is one command away.

## [1.0.1] - 2026-06-15

### Removed
- **GitHub credit-usage lookup** — the *Token Coach: Check GitHub credit usage*
  command, the `githubBilling.ts` module, and the `tokenCoach.githubToken` /
  `tokenCoach.githubUsername` / `tokenCoach.githubOrg` settings are all gone.
  Token Coach now makes **no network calls** and reads nothing from your GitHub
  account — every figure comes straight from the local Copilot debug logs.

### Changed
- Dashboard, status-bar tooltip, and coverage notes no longer reference the
  removed command. For your real account-wide monthly total they now point to
  Copilot's own credit meter (the Copilot status menu on github.com).

## [1.0.0] - 2026-06-12

First stable release, published to the VS Code Marketplace.

### Added
- Extension icon and VS Code Marketplace metadata (banner, keywords, bugs/QnA
  links), plus a dashboard screenshot in the README.
- Coverage banner now calls out when debug logging only started **after** the 1st
  of the month, pointing to Copilot's own credit meter for the full account total.

### Changed
- **Relicensed under Apache License 2.0** (previously PolyForm Noncommercial 1.0.0)
  — now free for personal *and* commercial use, with a patent grant. See `NOTICE`.

### Fixed
- **Tooltips/disclaimers** are now a single floating element positioned in JS and
  clamped to the viewport, so long explanations are never clipped by a container
  edge or the panel border.
- **Layout overflow** — long file paths, tokens, model ids, and table cells now
  wrap inside the panel instead of leaking past its right edge.
- **Message titles** strip Copilot's injected `<system-reminder>` / context blocks
  so each row shows the question you actually typed; a message that is only an
  attachment now reads as `📎 Referenced N files: …` instead of raw XML.

## [0.5.0] - 2026-06-10

### Added
- "Why it cost X" cost story per message, built only from real logged numbers
  (cold vs cached requests).
- Hebrew explainer of Copilot billing under `docs/`.

### Changed
- **Scoped everything to the current calendar month** — status bar, dashboard,
  nudges, and exported report reset automatically on the 1st, matching GitHub's
  monthly credit meter. Older logs stay on disk.
- Status bar drops "all-time" in favour of this-month / today, with a distinct
  "new month, fresh start" state.
- Reordered summary cards (money → health → volume → waste) and clarified
  tooltips (tool *definitions* vs tools *called*; what "cached" means).

### Fixed
- Use `crypto.randomBytes` for the webview CSP nonce (was derived from
  `Date.now()`, predictable within a millisecond).
- Keep de-duplication sets bounded per pass and pad the active-days key so
  distinct-day counts can't collide.

## [0.2.4] - 2026-06-09

### Fixed
- De-duplicate Copilot log discovery by a canonical (case-folded) path key, so the
  same `main.jsonl` reached via differently-cased base paths (e.g. `c:\` vs `C:\`
  on Windows) is parsed once — fixing doubled cost, tokens, and model-call counts.

## [0.2.3] - 2026-06-08

- Initial packaged release: log parser, coaching rules, dashboard webview, status
  bar, Markdown export, and optional GitHub credit-usage lookup.

[2.0.0]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v2.0.0
[1.1.1]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v1.1.1
[1.1.0]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v1.1.0
[1.0.1]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v1.0.1
[1.0.0]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v1.0.0
[0.5.0]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v0.5.0
[0.2.4]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v0.2.4
[0.2.3]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v0.2.3
