# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Shared browser & editor bridge (`vscode-bridge` MCP)

MarvinCode exposes the user's live editor, debug, and Integrated Browser state to external agents through the **`vscode-bridge`** MCP server (built-in `claude-bridge` extension). Any CLI configured with this MCP server can use it.

When the user refers to a browser window "shared with you", "in MarvinCode", or the "Integrated Browser", use the **`vscode-bridge`** tools — NOT a `playwright` / `browser_*` MCP server (that is a separate browser you drive yourself and cannot see the user's screen):

- `listBrowserPages` — list open Integrated Browser pages (id, url, title, shared).
- `readBrowserPage` / `screenshotBrowserPage` — view a page where `shared: true`.
- `shareBrowserPage` — request access to a page where `shared: false` (prompts the user).
- `navigateBrowserPage` / `clickBrowserElement` / `typeInBrowserPage` — act on a shared page.
- `getEditorState` / `listDirtyBuffers` / `getDirtyBuffer` / `getDebugState` — read editor & debug state.

To see what the user is sharing: call `listBrowserPages`, then `readBrowserPage` on a `shared: true` page. Requires MarvinCode running with the workspace open.
