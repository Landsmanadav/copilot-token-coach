# Token Coach — Project Guide

This document explains **what the extension does and how it's built**, then how to
**run it locally** and how to **publish it** to the marketplace.

For the user-facing feature summary and settings reference, see [README.md](README.md).

---

## 1. What we built

A read-only VS Code extension that turns GitHub Copilot's local debug logs into a
cost & efficiency coach. It never modifies Copilot or makes network calls — it
only reads the JSONL logs Copilot already writes and visualizes them.

### Features, in the order we built them

1. **Log parsing** — scans `workspaceStorage/*/GitHub.copilot-chat/debug-logs/*/main.jsonl`
   across macOS / Windows / Linux (and Insiders / VSCodium), parses JSONL
   line-by-line, and tolerates malformed/truncated lines. Extracts `llm_request`
   events (model, input/output/cached tokens, `copilotUsageNanoAiu` cost, cache
   hit rate) and `tool_call` events.

2. **Cost, not tokens** — the headline metric is `copilotUsageNanoAiu`, because
   caching can cut the cost of the *same* tokens by ~80%. The tool surfaces cost
   and cache hit rate everywhere.

3. **Message grouping** — one user message fans out, in agent mode, into many
   requests across several turns (and sometimes a cheaper side-model like
   `gpt-4o-mini`). We roll all of those up into one "message" summary.

4. **Chat grouping** — each debug session is one chat/conversation. Messages are
   grouped under their chat, labelled with the chat's **generated title** (read
   from the `title-*.jsonl` sidecar) or the first message. Hierarchy:
   **Chat → Message → turn-by-turn (request + nested tool calls)**.

5. **Cost drivers** ("where the tokens went"):
   - **Tools** ranked by calls, total time, and payload injected.
   - **Context breakdown** — including the **system prompt** and **tool
     definitions** (read from the `system_prompt_*.json` / `tools_*.json`
     sidecars; the tool schemas are often the single biggest chunk), plus
     attachments / open editors (with the actual file names and sizes),
     workspace structure, memory, environment/terminal context, etc.

6. **Coaching rules** — expensive request; **chat-aware cache** (a cold first
   message is expected and gets a calm info note, while a genuinely low-cache
   *later* message is flagged); large input; tiny-output; heavy attachments;
   slow tool. All thresholds are configurable.

7. **Dollars / credits** — GitHub's June 2026 usage billing prices 1 AI credit =
   $0.01, and 1 AIU ≈ 1 credit. We show USD next to AIU and a "plan budget ·
   this month" gauge vs your plan's allowance (Business = $19). Rate and plan
   price are configurable.

8. **Dashboard webview** — collapsible chat → message → turn tree, summary cards,
   severity-highlighted rows, hover tooltips that explain every metric, a tab
   title showing live totals, and expand/scroll state that survives refreshes.

9. **Status bar + live updates** — today's cost/tokens in the status bar; a file
   watcher (plus a backup poll) re-parses on new log writes and can notify on a
   new expensive request.

### Code layout

```
src/
├── extension.ts   # activate/deactivate, status bar, watcher + poll, commands, settings
├── logParser.ts   # find + parse logs; group into messages and chats; read sidecars
├── coach.ts       # rules engine (per-request + per-message/chat), config defaults
└── dashboard.ts   # webview HTML/CSS, rendering, formatting, open-state persistence
```

Data flow: `loadAll()` → `{requests, toolCalls, titles}` → `groupByChat()` →
`ChatGroup[]` (each containing `MessageGroup[]`) → rendered by `dashboard.ts`;
`coach.ts` evaluates warnings at render time using the user's configured thresholds.

---

## 2. Run it locally

### Prerequisites

- **Node.js** 18+ and **npm**.
- **VS Code** (stable, Insiders, or VSCodium).
- GitHub Copilot Chat installed, with debug logging enabled (so there's data):

  ```jsonc
  "github.copilot.chat.agentDebugLog.enabled": true,
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
  ```

  Then use Copilot Chat a few times to generate logs.

### Build

```bash
npm install
npm run compile      # or: npm run watch   (recompile on save)
```

### Option A — Extension Development Host (for developing)

1. Open this folder in VS Code.
2. Press **F5** (runs the `Run Extension` launch config, which compiles first).
3. A second VS Code window — the **Extension Development Host** — opens with the
   extension loaded.
4. In that window, click the **`$(graph)` status bar item** (bottom right) or run
   **“Token Coach: Show Dashboard”** from the Command Palette
   (`Cmd/Ctrl+Shift+P`).

Reload the dev host with `Cmd/Ctrl+R` after code changes (with `npm run watch`
running), or stop/restart F5.

### Option B — Install the packaged extension into your real VS Code

```bash
npm install -g @vscode/vsce      # the VS Code Extension manager CLI
npm run package                  # runs `vsce package` → token-coach-0.1.0.vsix
code --install-extension token-coach-0.1.0.vsix
```

Or in VS Code: **Extensions** view → `…` menu → **Install from VSIX…**. Reload
when prompted. To uninstall: `code --uninstall-extension <publisher>.token-coach`.

> Sharing the `.vsix` file with someone else lets them install it the same way —
> no marketplace needed.

---

## 3. Publish to a marketplace

Publishing is optional — the `.vsix` above is enough for personal/team use. To
list it on the **Visual Studio Marketplace** so anyone can install it by name:

### One-time setup

1. **Create a publisher.** Go to <https://marketplace.visualstudio.com/manage>,
   sign in with a Microsoft account, and create a **publisher** (pick an ID, e.g.
   `your-name`). Note that ID.

2. **Get a Personal Access Token (PAT).** In Azure DevOps
   (<https://dev.azure.com>), create a token with:
   - Organization: **All accessible organizations**
   - Scopes: **Marketplace → Manage**

   Copy the token (you only see it once).

3. **Set `publisher` in [package.json](package.json).** Change
   `"publisher": "token-coach"` to your publisher ID. Also recommended
   before publishing:
   - add `"repository": { "type": "git", "url": "https://github.com/you/token-coach" }`
     (vsce warns without it),
   - add a 128×128 `"icon": "images/icon.png"`,
   - confirm a unique `name`, a good `displayName`/`description`, and bump
     `version`.

4. **Log in once:**

   ```bash
   vsce login <your-publisher-id>     # paste the PAT when prompted
   ```

### Publish

```bash
vsce package                # sanity-check: build the .vsix and review warnings
vsce publish                # uploads the current version

# or bump the version automatically as you publish:
vsce publish patch          # 0.1.0 -> 0.1.1
vsce publish minor          # 0.1.0 -> 0.2.0
```

You can also publish non-interactively with `vsce publish -p <PAT>` (useful in
CI). The listing appears on the Marketplace within a minute or two; users then
install with **Extensions: Install** or
`code --install-extension <publisher>.token-coach`.

### Optional: Open VSX (for VSCodium / non-Microsoft editors)

The MS Marketplace only serves official VS Code. To reach VSCodium, Gitpod, etc.,
also publish to [Open VSX](https://open-vsx.org):

```bash
npm install -g ovsx
# create a namespace + token at open-vsx.org first
ovsx create-namespace <your-publisher-id> -p <ovsx-token>
ovsx publish token-coach-0.1.0.vsix -p <ovsx-token>
```

### Publishing checklist

- [ ] `publisher` set to your real publisher ID
- [ ] `version` bumped (Marketplace rejects re-publishing the same version)
- [ ] `repository`, `icon`, `displayName`, `description` present
- [ ] `README.md` and `LICENSE` in place (they become the listing page)
- [ ] `npm run compile` clean; `vsce package` shows no blocking warnings
- [ ] tested the packaged `.vsix` in a clean VS Code window
