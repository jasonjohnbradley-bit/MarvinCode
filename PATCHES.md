# MarvinCode — Upstream Patch Ledger

Every upstream (Microsoft) file this fork modifies is listed here, with how to re-apply after a monthly `release/1.xx` merge. New functionality lives in fork-owned directories that never conflict:

- `src/vs/platform/agentGraph/`
- `src/vs/workbench/contrib/agentGraph/`
- `src/vs/workbench/contrib/launchDarkly/`
- `src/vs/workbench/contrib/marvinBridge/`
- `extensions/kanban/`
- `extensions/agent-runner/`
- `extensions/claude-bridge/`
- `extensions/langfuse/`
- `extensions/windows-vm/` (Windows VM desktop via local Guacamole RDP gateway in the Integrated Browser)
- `extensions/theme-token-effort/`
- `extensions/theme-dracula/` (vendored Dracula Official theme, MIT; sets the default `workbench.colorTheme`)

**Budget: 13 modified upstream files maximum.** Every edit is wrapped in `// FORK:agentGraph begin/end` markers (JSON files excepted). Never modify extHost/mainThread RPC protocol files or `vscode.proposed.*.d.ts`.

## Modified upstream files

| # | File | What | Re-apply note |
|---|------|------|---------------|
| 1 | `product.json` | Token Effort branding: nameShort/nameLong and win32 display names are "Token Effort"; internal identity stays `marvincode` (applicationName, dataFolderName, sharedDataFolderName, server/tunnel names, mutexes, darwinBundleIdentifier, urlProtocol, fresh win32 GUIDs) so existing profiles/data keep loading. Also adds `extensionsGallery` pointing at Open VSX (open-vsx.org) plus its `linkProtectionTrustedDomains` entry — OSS builds ship no gallery, so extension search/install is dead without it | On conflict, keep our values for all identity fields; take upstream for everything else (builtInExtensions versions etc.) |
| 2 | `build/gulpfile.extensions.ts` | Added `extensions/kanban/tsconfig.json` (and later `extensions/agent-runner/tsconfig.json`, `extensions/claude-bridge/tsconfig.json`, `extensions/langfuse/tsconfig.json` and `extensions/windows-vm/tsconfig.json`) to the hardcoded `compilations` array | Re-add the fork lines to the array, alphabetical position is cosmetic |
| 3 | `.eslint-allowed-javascript-files` | Added `extensions/kanban/media/board.js` (hand-written webview script, same pattern as media-preview) | Re-add the one line, alphabetical position is cosmetic |
| 4 | `src/vs/code/electron-main/app.ts` | agentGraph: service registration (`services.set`) + IPC channel registration, both in `// FORK:agentGraph` blocks | Re-add the two marked blocks next to the Encryption service/channel lines |
| 5 | `src/vs/workbench/workbench.desktop.main.ts` | Two side-effect imports (`contrib/agentGraph`, `contrib/marvinBridge`) in one `// FORK:agentGraph` block | Re-add the marked imports at the end of the contrib imports |
| 6 | `build/filters.ts` | Hygiene exclusions for `contrib/agentGraph/.../media/**` (indentation) and `media/vendor/**` (copyright) in `// FORK:agentGraph` blocks | Re-add the two marked globs |
| 7 | `src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts` | `IToolFinishedEvent` + `onDidFinishTool` emitter on the concrete class (NOT the interface — avoids mock/test churn); `invokeTool` renamed to private `_doInvokeTool` and wrapped by a try/finally that fires the event. All in `// FORK:agentGraph` blocks | If upstream refactors `invokeTool`, re-apply: rename their method to `_doInvokeTool`, re-add the wrapper + emitter + event interface. ~30 lines total |
| 8 | `resources/darwin/code.icns` | Replaced with the Token Effort app icon — purple/pink recolored art as of 2026-08-01 (824px rounded-rect on 1024 transparent canvas; regenerate: ImageMagick roundrectangle mask + `-compose DstIn`, reset `-compose Over` before `-extent`, then iconutil) | Binary; on conflict always keep ours |
| 9 | `build/gulpfile.vscode.ts` | Added `contrib/agentGraph/electron-browser/media/**` to `vscodeResourceIncludes` in a `// FORK:agentGraph` block — without it packaged builds ship no graph webview assets (graphView.js/css, cytoscape vendor files) and the Agent Graph canvas is empty | Re-add the marked glob next to the Webview entry |
| 10 | `build/next/index.ts` | Same media glob added to `desktopResourcePatterns` in a `// FORK:agentGraph` block — the new esbuild pipeline (`useEsbuildTranspile=true` since ~1.127) has its own resource list and ignores `vscodeResourceIncludes`, so packaged builds again shipped no graph assets | Re-add the marked pattern at the end of `desktopResourcePatterns` |
| 11 | `build/lib/builtInExtensions.ts` | In `getExtensionDownloadStream`, prefer `fromGithub` whenever the extension declares a `repo` (in a `// FORK:agentGraph` block). Adding the Open VSX `extensionsGallery` to product.json made the build fetch Microsoft's built-ins (js-debug et al.) from Open VSX, which does not host them, so packaging died with `TypeError: fetch failed` | Re-add the marked `else if (extension.repo)` branch ahead of the marketplace branch |
| 12 | `src/vs/workbench/workbench.common.main.ts` | One side-effect import (`contrib/launchDarkly`) in a `// FORK:agentGraph` block. Was previously unmarked and unledgered — found 2026-08-02 | Re-add the marked import next to the other contrib imports |
| 13 | `build/lib/extensions.ts` | In `fromLocalEsbuild`, copilot uses `PackageManager.Npm` instead of `None` for `vsce.listFiles` (in a `// FORK:agentGraph` block) — `None` skips dependency collection, so local packaged builds shipped no `@github/copilot` SDK and `prepareBuiltInCopilotRipgrepShim` hard-failed. CI never hits this (it downloads the copilot VSIX) | Re-apply the two-line packageManager selection around the `listFiles` call |

## Merge procedure (monthly)

1. `git fetch upstream`
2. `git checkout -b merge/1.<xx+1> fork/main && git merge upstream/release/1.<xx+1>`
3. Resolve conflicts per the table above.
4. `npm install` → `npm run typecheck-client` → `./scripts/code.sh` (macOS) / `scripts\code.bat` (Windows)
5. Smoke test: open a Kanban board; one Claude Code turn visible via `agentGraph.dumpRecent`; one built-in chat tool call visible in the graph.
6. Fast-forward `fork/main`.
