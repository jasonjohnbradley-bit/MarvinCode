# MarvinCode — Upstream Patch Ledger

Every upstream (Microsoft) file this fork modifies is listed here, with how to re-apply after a monthly `release/1.xx` merge. New functionality lives in fork-owned directories that never conflict:

- `src/vs/platform/agentGraph/`
- `src/vs/workbench/contrib/agentGraph/`
- `extensions/kanban/`
- `extensions/agent-runner/`

**Budget: 8 modified upstream files maximum.** Every edit is wrapped in `// FORK:agentGraph begin/end` markers (JSON files excepted). Never modify extHost/mainThread RPC protocol files or `vscode.proposed.*.d.ts`.

## Modified upstream files

| # | File | What | Re-apply note |
|---|------|------|---------------|
| 1 | `product.json` | MarvinCode branding: nameShort/nameLong, applicationName, dataFolderName, sharedDataFolderName, server/tunnel names, win32* identity (fresh GUIDs), darwinBundleIdentifier, urlProtocol | On conflict, keep our values for all identity fields; take upstream for everything else (builtInExtensions versions etc.) |
| 2 | `build/gulpfile.extensions.ts` | Added `extensions/kanban/tsconfig.json` (and later `extensions/agent-runner/tsconfig.json`) to the hardcoded `compilations` array | Re-add the fork lines to the array, alphabetical position is cosmetic |
| 3 | `.eslint-allowed-javascript-files` | Added `extensions/kanban/media/board.js` (hand-written webview script, same pattern as media-preview) | Re-add the one line, alphabetical position is cosmetic |
| 4 | `src/vs/code/electron-main/app.ts` | agentGraph: service registration (`services.set`) + IPC channel registration, both in `// FORK:agentGraph` blocks | Re-add the two marked blocks next to the Encryption service/channel lines |
| 5 | `src/vs/workbench/workbench.desktop.main.ts` | One side-effect import of `contrib/agentGraph` in a `// FORK:agentGraph` block | Re-add the marked import at the end of the contrib imports |
| 6 | `build/filters.ts` | Hygiene exclusions for `contrib/agentGraph/.../media/**` (indentation) and `media/vendor/**` (copyright) in `// FORK:agentGraph` blocks | Re-add the two marked globs |
| 7 | `src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts` | `IToolFinishedEvent` + `onDidFinishTool` emitter on the concrete class (NOT the interface — avoids mock/test churn); `invokeTool` renamed to private `_doInvokeTool` and wrapped by a try/finally that fires the event. All in `// FORK:agentGraph` blocks | If upstream refactors `invokeTool`, re-apply: rename their method to `_doInvokeTool`, re-add the wrapper + emitter + event interface. ~30 lines total |

## Merge procedure (monthly)

1. `git fetch upstream`
2. `git checkout -b merge/1.<xx+1> fork/main && git merge upstream/release/1.<xx+1>`
3. Resolve conflicts per the table above.
4. `npm install` → `npm run typecheck-client` → `./scripts/code.sh` (macOS) / `scripts\code.bat` (Windows)
5. Smoke test: open a Kanban board; one Claude Code turn visible via `agentGraph.dumpRecent`; one built-in chat tool call visible in the graph.
6. Fast-forward `fork/main`.
