# MarvinCode — Upstream Patch Ledger

Every upstream (Microsoft) file this fork modifies is listed here, with how to re-apply after a monthly `release/1.xx` merge. New functionality lives in fork-owned directories that never conflict:

- `src/vs/platform/agentGraph/` (planned, Phase 3)
- `src/vs/workbench/contrib/agentGraph/` (planned, Phase 3–5)
- `extensions/kanban/` (planned, Phase 1)
- `extensions/agent-runner/` (planned, Phase 6)

**Budget: 7 modified upstream files maximum.** Every edit is wrapped in `// FORK:agentGraph begin/end` markers (JSON files excepted). Never modify extHost/mainThread RPC protocol files or `vscode.proposed.*.d.ts`.

## Modified upstream files

| # | File | What | Re-apply note |
|---|------|------|---------------|
| 1 | `product.json` | MarvinCode branding: nameShort/nameLong, applicationName, dataFolderName, sharedDataFolderName, server/tunnel names, win32* identity (fresh GUIDs), darwinBundleIdentifier, urlProtocol | On conflict, keep our values for all identity fields; take upstream for everything else (builtInExtensions versions etc.) |
| 2 | `build/gulpfile.extensions.ts` | Added `extensions/kanban/tsconfig.json` (and later `extensions/agent-runner/tsconfig.json`) to the hardcoded `compilations` array | Re-add the fork lines to the array, alphabetical position is cosmetic |
| 3 | `.eslint-allowed-javascript-files` | Added `extensions/kanban/media/board.js` (hand-written webview script, same pattern as media-preview) | Re-add the one line, alphabetical position is cosmetic |

## Merge procedure (monthly)

1. `git fetch upstream`
2. `git checkout -b merge/1.<xx+1> fork/main && git merge upstream/release/1.<xx+1>`
3. Resolve conflicts per the table above.
4. `npm install` → `npm run typecheck-client` → `scripts\code.bat`
5. Smoke test: open a Kanban board; one Claude Code turn visible via `agentGraph.dumpRecent`; one built-in chat tool call visible in the graph.
6. Fast-forward `fork/main`.
