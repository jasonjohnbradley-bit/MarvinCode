# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It also serves as the Copilot instructions — `.claude/CLAUDE.md` is a symlink to `.github/copilot-instructions.md`, so edits here reach both agents.

## Project Overview

This repository is **MarvinCode**, a fork of Visual Studio Code (Code - OSS). Upstream VS Code architecture and guidelines apply everywhere; fork-specific rules are in the "MarvinCode Fork" sections below and in `PATCHES.md`.

Visual Studio Code is built with a layered architecture using TypeScript, web APIs and Electron, combining web technologies with native app capabilities. The codebase is organized into key architectural layers:

### Root Folders
- `src/`: Main TypeScript source code with unit tests in `src/vs/*/test/` folders
- `build/`: Build scripts and CI/CD tools
- `extensions/`: Built-in extensions that ship with VS Code
- `test/`: Integration tests and test infrastructure
- `scripts/`: Development and build scripts
- `resources/`: Static resources (icons, themes, etc.)
- `out/`: Compiled JavaScript output (generated during build)

### Core Architecture (`src/` folder)
- `src/vs/base/` - Foundation utilities and cross-platform abstractions
- `src/vs/platform/` - Platform services and dependency injection infrastructure
- `src/vs/editor/` - Text editor implementation with language services, syntax highlighting, and editing features
- `src/vs/workbench/` - Main application workbench for web and desktop
  - `workbench/browser/` - Core workbench UI components (parts, layout, actions)
  - `workbench/services/` - Service implementations
  - `workbench/contrib/` - Feature contributions (git, debug, search, terminal, etc.)
  - `workbench/api/` - Extension host and VS Code API implementation
- `src/vs/code/` - Electron main process specific implementation
- `src/vs/server/` - Server specific implementation
- `src/vs/sessions/` - Agent sessions window, a dedicated workbench layer for agentic workflows (sits alongside `vs/workbench`, may import from it but not vice versa)

The core architecture follows these principles:
- **Layered architecture** - from `base`, `platform`, `editor`, to `workbench`
- **Dependency injection** - Services are injected through constructor parameters
    - If non-service parameters are needed, they need to come before the service parameters
- **Contribution model** - Features contribute to registries and extension points
- **Cross-platform compatibility** - Abstractions separate platform-specific code

### Built-in Extensions (`extensions/` folder)
The `extensions/` directory contains first-party extensions that ship with VS Code:
- **Language support** - `typescript-language-features/`, `html-language-features/`, `css-language-features/`, etc.
- **Core features** - `git/`, `debug-auto-launch/`, `emmet/`, `markdown-language-features/`
- **Themes** - `theme-*` folders for default color themes
- **Development tools** - `extension-editing/`, `vscode-api-tests/`

Each extension follows the standard VS Code extension structure with `package.json`, TypeScript sources, and contribution points to extend the workbench through the Extension API.

### Finding Related Code
1. **Semantic search first**: Use file search for general concepts
2. **Grep for exact strings**: Use grep for error messages or specific function names
3. **Follow imports**: Check what files import the problematic module
4. **Check test files**: Often reveal usage patterns and expected behavior

## Build & Run

```bash
npm install                      # Install dependencies (requires the Node version in .nvmrc)
npm run watch                    # Incremental build: Core (src/) + Ext (extensions/) watch tasks
./scripts/code.sh                # Launch MarvinCode from sources (macOS/Linux; scripts\code.bat on Windows)
npm run typecheck-client         # Type-check src/ only (no emit)
npm run gulp compile-extensions  # Compile built-in extensions (reports extension TS errors)
npm run valid-layers-check       # Check architectural layering rules
./scripts/test.sh --grep <pat>   # Unit tests, filtered to a pattern (single test/suite)
./scripts/test-integration.sh    # Integration tests (*.integrationTest.ts and extension tests)
```

The `/launch` skill (when available) launches the workbench into an isolated throwaway profile with debug ports for UI automation and debugger attachment — prefer it over `./scripts/code.sh` when you need to drive or inspect the running app.

## MarvinCode Fork: Structure & Discipline

MarvinCode tracks upstream `microsoft/vscode` via monthly `release/1.xx` merges. To keep merges cheap, **all new functionality lives in fork-owned directories** that never conflict, and every unavoidable edit to an upstream file is:

1. Wrapped in `// FORK:agentGraph begin/end` markers (JSON files excepted), and
2. Recorded in `PATCHES.md` (the authoritative ledger, with re-apply notes per file).

Hard rules: **max 9 modified upstream files**; never modify extHost/mainThread RPC protocol files or `vscode.proposed.*.d.ts`. If a change would touch a new upstream file, update `PATCHES.md` in the same commit. See `PATCHES.md` for the current table and the merge procedure.

### Fork-owned components

**Agent Graph** — visualizes agent/tool activity as a live graph:
- `src/vs/platform/agentGraph/` — `common/` service interface, `node/` event normalizer + graph store + kanban card linker, `electron-main/` main-process service (registered in `app.ts` with an IPC channel, one of the patched upstream files).
- `src/vs/workbench/contrib/agentGraph/electron-browser/` — editor + view pane hosting a Cytoscape webview (`media/graphView.js`); `chatAgentGraphListener.ts` feeds built-in chat tool calls into the graph via the fork-added `onDidFinishTool` event on `languageModelToolsService`.
- Packaged-build gotcha: webview media must be listed in `vscodeResourceIncludes` in `build/gulpfile.vscode.ts`, or packaged apps ship without the assets and the canvas renders empty.

**Workbench contribs**: `src/vs/workbench/contrib/marvinBridge/` (bridge contribution) and `src/vs/workbench/contrib/launchDarkly/` (feature flags). Fork contribs are imported from `workbench.desktop.main.ts` inside a `// FORK:agentGraph` block.

**Built-in extensions** (each registered in the `compilations` array in `build/gulpfile.extensions.ts`):
- `extensions/kanban/` — file-based Kanban boards in the workspace, plus Jira sync, campaign orchestration, reMarkable meeting-notes ingestion, and the Agents-window launcher.
- `extensions/agent-runner/` — hosts custom agents whose actions stream into the Agent Graph.
- `extensions/claude-bridge/` — the `vscode-bridge` MCP server (next section).
- `extensions/langfuse/` — Langfuse LLM trace/span/score browser sidebar.
- `extensions/theme-token-effort/` — the MarvinCode theme.

## MarvinCode: Shared Browser & Editor Bridge (`vscode-bridge` MCP)

MarvinCode (this fork) ships a built-in `claude-bridge` extension that exposes the user's live editor, debug, and **Integrated Browser** state to any external agent over the **`vscode-bridge`** MCP server (stdio). It is CLI-agnostic — Devin, Claude Code, GitHub Copilot CLI, or any MCP-capable client can use it once the server is registered (`node extensions/claude-bridge/out/mcp/server.js`).

**Important tool-selection rule:** when the user talks about a browser window that is "shared with you", "in MarvinCode", or the "Integrated Browser", use the `vscode-bridge` tools below — do NOT use a `playwright` / `browser_*` MCP server. A `playwright` server drives a *separate* browser you control and cannot see the user's screen; `vscode-bridge` is the user's actual on-screen MarvinCode browser.

Tools exposed by `vscode-bridge`:
- Integrated Browser (real Chromium, user-visible, shareable): `listBrowserPages`, `openBrowserPage`, `shareBrowserPage`, `readBrowserPage`, `screenshotBrowserPage`, `navigateBrowserPage`, `clickBrowserElement`, `typeInBrowserPage`
- Legacy Simple Browser: `openSimpleBrowser`, `listSimpleBrowserTabs`, `closeSimpleBrowser`
- Editor & debug (read-only): `getEditorState`, `listDirtyBuffers`, `getDirtyBuffer`, `getDebugState`

To see what the user is sharing: call `listBrowserPages`, then `readBrowserPage` (accessibility snapshot) or `screenshotBrowserPage` on a page with `shared: true`. If a page is `shared: false`, call `shareBrowserPage` first (this prompts the user to consent). Only shared pages can be read or controlled. Requires MarvinCode running with the workspace open; launch the CLI from the workspace folder so the bridge targets the correct window.

## Validating TypeScript changes

MANDATORY: Always check for compilation errors before running any tests or validation scripts, or declaring work complete, then fix all compilation errors before moving forward.

- NEVER run tests if there are compilation errors
- NEVER use `npm run compile` to compile TypeScript files

### TypeScript compilation steps
- If the `#runTasks/getTaskOutput` tool is available, check the `VS Code - Build` watch task output for compilation errors. This task runs `Core - Build` and `Ext - Build` to incrementally compile VS Code TypeScript sources and built-in extensions. Start the task if it's not already running in the background.
- If the tool is not available (e.g. in CLI environments) and you only changed code under `src/`, run `npm run typecheck-client` after making changes to type-check the main VS Code sources (it validates `./src/tsconfig.json`).
- If you changed built-in extensions under `extensions/` and the tool is not available, run the corresponding gulp task `npm run gulp compile-extensions` instead so that TypeScript errors in extensions are also reported.
- For TypeScript changes in the `build` folder, you can simply run `npm run typecheck` in the `build` folder.

### TypeScript validation steps
- Use the run test tool if you need to run tests. If that tool is not available, then you can use `scripts/test.sh` (or `scripts\test.bat` on Windows) for unit tests (add `--grep <pattern>` to filter tests) or `scripts/test-integration.sh` (or `scripts\test-integration.bat` on Windows) for integration tests (integration tests end with .integrationTest.ts or are in /extensions/).
- Use `npm run valid-layers-check` to check for layering issues

## Coding Guidelines

### Indentation

We use tabs, not spaces.

### Naming Conventions

- Use PascalCase for `type` names
- Use PascalCase for `enum` values
- Use camelCase for `function` and `method` names
- Use camelCase for `property` names and `local variables`
- Use whole words in names when possible

### Types

- Do not export `types` or `functions` unless you need to share it across multiple components
- Do not introduce new `types` or `values` to the global namespace

### Comments

- Use JSDoc style comments for `functions`, `interfaces`, `enums`, and `classes`

### Strings

- Use "double quotes" for strings shown to the user that need to be externalized (localized)
- Use 'single quotes' otherwise
- All strings visible to the user need to be externalized using the `vs/nls` module
- Externalized strings must not use string concatenation. Use placeholders instead (`{0}`).

### UI labels
- Use title-style capitalization for command labels, buttons and menu items (each word is capitalized).
- Don't capitalize prepositions of four or fewer letters unless it's the first or last word (e.g. "in", "with", "for").

### Style

- Use arrow functions `=>` over anonymous function expressions
- Only surround arrow function parameters when necessary. For example, `(x) => x + x` is wrong but the following are correct:

```typescript
x => x + x
(x, y) => x + y
<T>(x: T, y: T) => x === y
```

- Always surround loop and conditional bodies with curly braces
- Open curly braces always go on the same line as whatever necessitates them
- Parenthesized constructs should have no surrounding whitespace. A single space follows commas, colons, and semicolons in those constructs. For example:

```typescript
for (let i = 0, n = str.length; i < 10; i++) {
    if (x < 10) {
        foo();
    }
}
function f(x: number, y: string): void { }
```

- Whenever possible, in top-level scopes, use `export function x(…) {…}` instead of `export const x = (…) => {…}`. One advantage of using the `function` keyword is that the stack trace shows a good name when debugging.

### Code Quality

- All files must include Microsoft copyright header
- Prefer `async` and `await` over `Promise` and `then` calls
- All user facing messages must be localized using the applicable localization framework (for example `nls.localize()` method)
- Don't add tests to the wrong test suite (e.g., adding to end of file instead of inside relevant suite)
- Look for existing test patterns before creating new structures
- Use `describe` and `test` consistently with existing patterns
- Prefer regex capture groups with names over numbered capture groups.
- If you create any temporary new files, scripts, or helper files for iteration, clean up these files by removing them at the end of the task
- Never duplicate imports. Always reuse existing imports if they are present.
- When removing an import, do not leave behind blank lines where the import was. Ensure the surrounding code remains compact.
- Do not use `any` or `unknown` as the type for variables, parameters, or return values unless absolutely necessary. If they need type annotations, they should have proper types or interfaces defined.
- When adding file watching, prefer correlated file watchers (via fileService.createWatcher) to shared ones.
- When adding tooltips to UI elements, prefer the use of IHoverService service.
- Do not duplicate code. Always look for existing utility functions, helpers, or patterns in the codebase before implementing new functionality. Reuse and extend existing code whenever possible.
- You MUST deal with disposables by registering them immediately after creation for later disposal. Use helpers such as `DisposableStore`, `MutableDisposable` or `DisposableMap`. Do NOT register a disposable to the containing class if the object is created within a method that is called repeatedly to avoid leaks. Instead, return an `IDisposable` from such method and let the caller register it.
- You MUST NOT use storage keys of another component only to make changes to that component. You MUST come up with proper API to change another component.
- Use `IEditorService` to open editors instead of `IEditorGroupsService.activeGroup.openEditor` to ensure that the editor opening logic is properly followed and to avoid bypassing important features such as `revealIfOpened` or `preserveFocus`.
- Avoid using `bind()`, `call()` and `apply()` solely to control `this` or partially apply arguments; prefer arrow functions or closures to capture the necessary context, and use these methods only when required by an API or interoperability.
- Avoid using events to drive control flow between components. Instead, prefer direct method calls or service interactions to ensure clearer dependencies and easier traceability of logic. Events should be reserved for broadcasting state changes or notifications rather than orchestrating behavior across components.
- Service dependencies MUST be declared in constructors and MUST NOT be accessed through the `IInstantiationService` at any other point in time.

## Learnings
- Minimize the amount of assertions in tests. Prefer one snapshot-style `assert.deepStrictEqual` over multiple precise assertions, as they are much more difficult to understand and to update.
- Do not stub a global object (e.g. `(mainWindow as any).ResizeObserver = ...`) or use `any` casts to install fakes in tests. Instead, make the dependency injectable: add an optional constructor parameter on the production class that defaults to the real implementation (e.g. `targetWindow.ResizeObserver`), and have the test pass a fake that implements the real interface.
