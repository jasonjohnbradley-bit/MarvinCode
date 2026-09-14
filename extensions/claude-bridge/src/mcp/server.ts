/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Standalone MCP stdio server spawned by Claude Code (NOT by the extension
// host). Configure it in ~/.claude.json as:
//   node <repo>/extensions/claude-bridge/out/mcp/server.js

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOL_INPUT_SCHEMAS, type ToolNameT } from '../shared/schema';
import { callBridge, type CallError } from './bridgeClient';

const TOOL_DESCRIPTIONS: Record<ToolNameT, string> = {
	getEditorState:
		'Returns the active VS Code editor: active file (uri, languageId, dirty state, cursor, selection, visible ranges) and all open tabs (uri, label, dirty, pinned, view column, kind). Read-only.',
	getDirtyBuffer:
		"Returns the in-memory text of an unsaved (or any loaded) VS Code document by URI. Falls under file: or untitled: schemes only. Capped at 1 MB; use 'maxBytes' to lower, set 'truncated' in the response.",
	listDirtyBuffers:
		'Lists all VS Code documents that are currently dirty or untitled, with size and language. Use to discover candidates for getDirtyBuffer.',
	getDebugState:
		'Returns the active VS Code debug session (if any) and all breakpoints with file/line/condition. Read-only.',
	openSimpleBrowser:
		"Opens a URL in VS Code's legacy Simple Browser pane (iframe; many sites refuse to load). Prefer openBrowserPage, which uses the real Chromium Integrated Browser and supports reading and interaction.",
	listSimpleBrowserTabs:
		'Lists Simple Browser tabs currently open in VS Code. URLs are tracked only for tabs opened via openSimpleBrowser — tabs the user opened or navigated manually report url:null with tracked:false.',
	closeSimpleBrowser:
		'Closes the active Simple Browser tab, or all of them with all=true.',
	listBrowserPages:
		'Lists the Integrated Browser (real Chromium) pages open in MarvinCode with their page id, url, title, and whether each is shared with agents. Only shared pages can be read or controlled — use shareBrowserPage to request access to an unshared one.',
	openBrowserPage:
		'Opens a URL in the MarvinCode Integrated Browser (real Chromium, visible to the user) and returns a pageId plus an accessibility snapshot with element refs. Reuses an already-shared page on the same host unless forceNew=true. The page is shared with you automatically.',
	shareBrowserPage:
		'Asks the user (via a MarvinCode dialog) to share an existing Integrated Browser page with agents. Returns shared=false if the user declines. Required before reading or controlling a page the user opened themselves.',
	readBrowserPage:
		'Returns an accessibility snapshot (aria tree with element refs, title, url) of a shared Integrated Browser page. Better than a screenshot for understanding page structure; refs feed clickBrowserElement/typeInBrowserPage.',
	screenshotBrowserPage:
		'Captures a screenshot of a shared Integrated Browser page (optionally of one element via ref or selector) and returns the PNG/JPEG file path — read the file to view it.',
	navigateBrowserPage:
		"Navigates a shared Integrated Browser page: pass 'url' to go somewhere, or action back | forward | reload. Returns a fresh accessibility snapshot.",
	clickBrowserElement:
		"Clicks an element on a shared Integrated Browser page, addressed by 'ref' (from a snapshot) or a CSS/Playwright 'selector'. Supports dblClick and mouse button choice. Returns a fresh snapshot summary.",
	typeInBrowserPage:
		"Types 'text' into an element (ref or selector) or the focused element, or presses 'key' (e.g. Enter, Tab). submit=true presses Enter after typing. Operates on a shared Integrated Browser page.",
};

async function main(): Promise<void> {
	const server = new Server(
		{ name: 'vscode-bridge', version: '0.2.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: (Object.keys(TOOL_INPUT_SCHEMAS) as ToolNameT[]).map(name => ({
			name,
			description: TOOL_DESCRIPTIONS[name],
			inputSchema: zodToJsonSchema(TOOL_INPUT_SCHEMAS[name], { target: 'openApi3' }) as Record<string, unknown>,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async req => {
		const name = req.params.name as ToolNameT;
		const inputSchema = TOOL_INPUT_SCHEMAS[name];
		if (!inputSchema) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `unknown tool: ${name}` }],
			};
		}
		const parsed = inputSchema.safeParse(req.params.arguments ?? {});
		if (!parsed.success) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `invalid arguments: ${parsed.error.message}` }],
			};
		}

		try {
			const result = await callBridge(name, parsed.data, { cwd: process.cwd() });
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			};
		} catch (err) {
			const e = err as CallError;
			const code = e.code ?? 'INTERNAL';
			const hint = code === 'NO_SOCKET'
				? ' Is MarvinCode running with a workspace open?'
				: '';
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `[${code}] ${e.message ?? String(err)}${hint}` }],
			};
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch(err => {
	process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
	process.exit(1);
});
