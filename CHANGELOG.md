# Changelog

All notable changes to **Token Coach** are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
