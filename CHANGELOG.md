# Changelog

All notable changes to **Token Coach** are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.1]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v1.0.1
[1.0.0]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v1.0.0
[0.5.0]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v0.5.0
[0.2.4]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v0.2.4
[0.2.3]: https://github.com/Landsmanadav/copilot-token-coach/releases/tag/v0.2.3
