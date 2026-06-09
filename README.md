# Token Coach

A VS Code extension that reads **GitHub Copilot's local debug logs**, analyzes
token usage and cost, and coaches you toward cheaper usage patterns.

It is strictly **read-only** — it never modifies Copilot or sends anything over
the network. It only reads the JSONL debug logs Copilot already writes to disk.

> 📘 See **[GUIDE.md](GUIDE.md)** for what we built & how it works, plus detailed
> **local-install** and **publishing** instructions.

## Why cost, not tokens?

The real cost metric is **`copilotUsageNanoAiu`**, *not* raw token counts. The
big lever is caching: `cachedTokens` dramatically reduce cost. In real data, two
~29K-input requests cost **3.78 AIU vs 0.66 AIU** — an **83% difference purely
from caching**.

So this tool surfaces:

- **Cost** in AIU (`1 AIU = 1,000,000,000 NanoAiu`),
- **Cache hit rate** (`cachedTokens / inputTokens`), and
- **Coaching warnings** that flag expensive requests and low cache utilization.

## Features

- **Log parser** — finds every `main.jsonl` under VS Code's `workspaceStorage`
  (cross-platform), parses it line-by-line, and tolerates malformed lines.
- **Rules engine** — flags expensive requests, low cache hits on large inputs,
  oversized inputs, and huge-input/tiny-output requests. All thresholds are
  configurable.
- **Status bar** — shows the all-time total cost and tokens (so it always
  reflects your data, even if Copilot wasn't used today); hover for a today /
  this-month / all-time breakdown, click to open the dashboard.
- **Dashboard, grouped by chat → message** — the top level is each **chat**
  (one Copilot conversation / debug session), labelled with its generated title
  (e.g. "Basic React app template") or the first message, and rolled up to its
  own cost, tokens, cache rate, message/request/tool counts and models.
  Everything starts collapsed; click a chat to reveal its messages, where
  **one row = one message you asked**. Agent mode
  fans a single message out into many requests across several turns (and
  sometimes several models, e.g. a cheap `gpt-4o-mini` for side-tasks alongside
  the main model), so each row rolls those up into a summary: total cost,
  tokens, cache hit rate, and which models were used. Warning rows are
  highlighted. Expand a message to see:
  - **Where the tokens went** — the cost drivers. A **tools** table (calls,
    total time, payload injected) surfaces tools "taking too much" (e.g. lots of
    `read_file`/`create_file`), and a **context** breakdown shows where the
    prompt came from — the **system prompt** and **tool definitions** (read from
    the `system_prompt_*.json` / `tools_*.json` sidecar files Copilot writes
    next to the log; these are fixed per request and usually cached, and the
    tool schemas are often the single largest chunk), plus **attachments / open
    editors** (with the actual file names and sizes), workspace structure,
    memory, environment/terminal context, etc. Hover any source for an
    explanation.
  - **Turn-by-turn** — the main request of each turn with its tool calls nested
    underneath ("the main one, and then inside").

  The editor tab title shows the live totals (e.g. `Token Coach · 14.67 AIU ·
  524k tok`), and expanded rows + scroll position are preserved across the live
  refreshes.
- **Dollars & plan budget** — AIU is converted to USD (1 AIU ≈ $0.01) and shown
  alongside the raw cost, with a "this month vs your $19/mo plan" budget gauge.
  See [Cost in dollars](#cost-in-dollars-credits).

  > Note on context sizes: Copilot only itemizes the in-prompt context blocks on
  > the first turn (attachments, workspace, memory, …); later turns log just the
  > delta. The system prompt and tool schemas come from sidecar files. All sizes
  > are therefore **estimates** (~4 chars ≈ 1 token) shown as a share of the
  > breakdown, which is close to — but not exactly — the model's input token
  > count.
- **Live updates** — a file watcher (plus a backup poll) re-parses logs when
  Copilot writes new entries, and notifies you when a new request is expensive.

## 1. Enable Copilot debug logging

The extension can only show data if Copilot is writing logs. In VS Code settings
(`Cmd/Ctrl+,`), set **both** of these to `true`:

```jsonc
"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

Copilot then writes logs to:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<session>/main.jsonl` |
| Windows | `%APPDATA%\Code\User\workspaceStorage\<hash>\GitHub.copilot-chat\debug-logs\<session>\main.jsonl` |
| Linux | `~/.config/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<session>/main.jsonl` |

**Works on any computer — no path configuration needed.** The extension finds
this folder automatically: it derives it from VS Code's *own* storage location
(`context.globalStorageUri`), which is correct for every install — standard,
**portable mode**, a custom `--user-data-dir`, **Insiders**, **VSCodium**, etc.
The standard per-OS locations above are also scanned as a fallback. If yours is
somewhere truly non-standard, set `tokenCoach.workspaceStoragePathOverride` to
point at your `workspaceStorage` directory.

> Note: the extension reads logs on the machine/host where it runs. In a Remote
> SSH / WSL / Dev Container / Codespaces window, install it in that same remote
> so it sees the remote logs.

## 2. Build

```bash
npm install
npm run compile
```

Use `npm run watch` to recompile on save while developing.

## 3. Run in the Extension Development Host

1. Open this folder in VS Code.
2. Press **F5** (runs the `Run Extension` launch config, which compiles first).
3. A new **Extension Development Host** window opens with the extension loaded.
4. In that window, make sure the two Copilot debug settings above are enabled,
   then use Copilot Chat a few times.
5. Click the status bar item (or run **“Token Coach: Show Dashboard”**
   from the Command Palette) to open the dashboard.

## 4. Package to a `.vsix`

```bash
npm install -g @vscode/vsce   # if you don't have it
npm run package               # runs `vsce package`
```

This produces `token-coach-0.1.0.vsix`, which you can install with
**Extensions: Install from VSIX…** or:

```bash
code --install-extension token-coach-0.1.0.vsix
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `tokenCoach.costWarnThreshold` | `3000000000` | Flag cost (NanoAiu) above this (= 3 AIU). |
| `tokenCoach.inputWarnThreshold` | `50000` | Flag `inputTokens` above this. |
| `tokenCoach.lowCacheRateThreshold` | `0.5` | Cache hit rate below this is "low". |
| `tokenCoach.lowCacheMinInputTokens` | `20000` | Minimum input before the low-cache rule fires. |
| `tokenCoach.ioRatioThreshold` | `1000` | Flag `inputTokens/outputTokens` above this. |
| `tokenCoach.ioMinInputTokens` | `10000` | Minimum input before the tiny-output rule fires, so small side-calls aren't mislabelled "huge input". |
| `tokenCoach.attachmentShareWarn` | `0.4` | Flag a message when open/attached files exceed this share of its logged context. |
| `tokenCoach.slowToolWarnMs` | `10000` | Flag a message when one tool consumes more than this many ms (summed across calls). |
| `tokenCoach.usdPerAiu` | `0.01` | US dollars per 1 AIU (1 AI credit = $0.01, 1 AIU ≈ 1 credit). Set `0` to hide dollar figures. |
| `tokenCoach.planMonthlyUsd` | `19` | Your monthly plan price (Business = $19, Enterprise/Pro+ = $39) for the budget gauge. |
| `tokenCoach.notifyOnExpensiveRequest` | `true` | Notify when a new request exceeds the cost threshold. |
| `tokenCoach.pollIntervalSeconds` | `20` | Backup poll interval; `0` disables polling. |
| `tokenCoach.workspaceStoragePathOverride` | `""` | Optional explicit `workspaceStorage` path (testing / non-standard installs). |

## Cost in dollars (credits)

As of **June 1, 2026**, GitHub Copilot moved to usage-based billing: **1 GitHub AI
credit = $0.01**, and each plan includes a monthly dollar allowance of credits
(**Business = $19**, **Enterprise / Pro+ = $39**). Empirically, **1 AIU ≈ 1 AI
credit ≈ $0.01** — e.g. a 0.66 AIU Haiku request (mostly cached input) works out
to ≈ $0.0065 at real model rates, matching `0.66 × $0.01`.

So the dashboard shows:

- **Dollar figures** next to AIU on each message and in the summary cards.
- A **"Plan budget · this month"** gauge: this calendar month's estimated spend
  vs your plan's allowance (the status bar tooltip shows the same).

Both the rate (`usdPerAiu`) and plan price (`planMonthlyUsd`) are settings, so you
can recalibrate. These are **estimates** for coaching, not a billing statement —
your GitHub billing page is the source of truth. The estimate can differ from
GitHub's % because (a) the real monthly allowance may include a *flex* amount on
top of the plan price, and (b) some base-model usage isn't charged against
credits. **To match GitHub exactly:** set `planMonthlyUsd` to your real monthly
allowance, or scale `usdPerAiu` by `(GitHub's % ÷ the % shown here)` — e.g. if
GitHub says 82% and the card shows 91%, set `usdPerAiu` to `0.01 × 82/91 ≈ 0.009`
(or `planMonthlyUsd` to `19 × 91/82 ≈ 21`).

Sources: [GitHub Copilot is moving to usage-based billing](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/) ·
[Models and pricing for GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) ·
[Plans for GitHub Copilot](https://docs.github.com/en/copilot/get-started/plans)

## Coaching rules

| Rule | Condition | Advice |
| --- | --- | --- |
| Expensive request | `cost > costWarnThreshold` | Split the task into smaller, focused steps. |
| Cold start (info) | first message of a chat with low aggregate cache | None needed — the cache is cold on the first message; staying in the chat reuses it next turn. |
| Low cache hit | a **later** message (not the first) with large input and `cacheHitRate < lowCacheRateThreshold` | The chat likely outgrew the cache window or its context changed; for a new task, a fresh focused chat can be cheaper. |
| Large input | `inputTokens > inputWarnThreshold` | Close irrelevant files/tabs to shrink context. |
| Tiny output | `inputTokens > ioMinInputTokens` **and** `inputTokens / outputTokens > ioRatioThreshold` | Reconsider whether agent mode / full context was needed. |
| Heavy attachments | attachments > `attachmentShareWarn` of logged context | Close unused editors/tabs — open files are bloating context. |
| Slow tool | one tool's total time > `slowToolWarnMs` | Heavy tool use lengthens turns and grows context. |

## Project structure

```
token-coach/
├── package.json      # manifest: commands, settings, activation
├── tsconfig.json
├── src/
│   ├── extension.ts  # activate/deactivate, status bar, watcher, commands
│   ├── logParser.ts  # find + parse jsonl
│   ├── coach.ts      # rules engine
│   └── dashboard.ts  # webview HTML + update logic
└── README.md
```

## Acceptance test

With Copilot debug logging enabled, use Copilot Chat a few times, then open the
dashboard. It should list real requests with cost and cache hit rate, and
highlight any expensive ones.

## License

MIT — see [LICENSE](LICENSE).
