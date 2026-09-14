/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FORK:agentGraph — command surface for the claude-bridge built-in extension.
// Exposes the Integrated Browser to external agents (Claude Code sessions in
// the terminal, via the vscode-bridge MCP server) through `marvincode.browser.*`
// commands. The same consent model as the in-editor browser tools applies:
// pages opened by the agent are implicitly shared (the terminal-side MCP
// permission prompt is the consent), while acting on an existing page requires
// it to be shared — `marvincode.browser.share` runs the workbench's
// "Share with Agent?" dialog. URLs are checked against the agent network filter.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { IAgentNetworkFilterService } from '../../../../platform/networkFilter/common/networkFilterService.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
// eslint-disable-next-line local/code-import-patterns
import type { Page } from 'playwright-core';

/** Playwright session key for all bridge-driven interactions. */
const BRIDGE_SESSION_ID = 'marvincode-claude-bridge';

interface IBridgePageInfo {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly shared: boolean;
}

// A command's ServicesAccessor is only valid synchronously during the handler
// call, so every handler resolves ALL services before its first await and the
// helpers below take the resolved services, never the accessor.

function checkUrlAllowed(filter: IAgentNetworkFilterService, url: string): string {
	const parsed = URL.parse(url);
	if (!parsed) {
		throw new Error(`Not a valid absolute URL: ${url}`);
	}
	const uri = URI.parse(parsed.href);
	if (!filter.isUriAllowed(uri)) {
		throw new Error(filter.formatError(uri));
	}
	return parsed.href;
}

async function resolveModel(browserViewService: IBrowserViewWorkbenchService, pageId: string): Promise<IBrowserViewModel> {
	const editor = browserViewService.getKnownBrowserViews().get(pageId);
	if (!editor) {
		throw new Error(`No browser page with id '${pageId}'. Use marvincode.browser.listPages to see the open pages.`);
	}
	return editor.resolve();
}

async function requireSharedModel(browserViewService: IBrowserViewWorkbenchService, pageId: string): Promise<IBrowserViewModel> {
	const model = await resolveModel(browserViewService, pageId);
	if (model.sharingState !== BrowserViewSharingState.Shared) {
		throw new Error(`Page '${pageId}' is not shared with agents. Ask the user to share it (Share with Agent in the browser toolbar) or call marvincode.browser.share first.`);
	}
	return model;
}

function serializeFn(fn: (page: Page, ...args: unknown[]) => unknown): string {
	return fn.toString();
}

CommandsRegistry.registerCommand('marvincode.browser.listPages', (accessor): { pages: IBridgePageInfo[] } => {
	const browserViewService = accessor.get(IBrowserViewWorkbenchService);
	const pages: IBridgePageInfo[] = [];
	for (const editor of browserViewService.getContextualBrowserViews().values()) {
		if (editor instanceof BrowserEditorInput) {
			pages.push({
				id: editor.id,
				url: editor.url || 'about:blank',
				title: editor.title || editor.getName(),
				shared: editor.model?.sharingState === BrowserViewSharingState.Shared
			});
		}
	}
	return { pages };
});

CommandsRegistry.registerCommand('marvincode.browser.open', async (accessor, args: { url: string; forceNew?: boolean }): Promise<{ pageId: string; summary: string; reused: boolean }> => {
	const playwrightService = accessor.get(IPlaywrightService);
	const browserViewService = accessor.get(IBrowserViewWorkbenchService);
	const url = checkUrlAllowed(accessor.get(IAgentNetworkFilterService), args.url);

	if (!args.forceNew) {
		// Reuse an already-shared page on the same host rather than duplicating it
		const parsedHost = URL.parse(url)?.host;
		for (const editor of browserViewService.getContextualBrowserViews().values()) {
			if (editor instanceof BrowserEditorInput
				&& editor.model?.sharingState === BrowserViewSharingState.Shared
				&& parsedHost && URL.parse(editor.url || '')?.host === parsedHost) {
				const summary = await playwrightService.getSummary(BRIDGE_SESSION_ID, editor.id);
				return { pageId: editor.id, summary, reused: true };
			}
		}
	}

	const { pageId, summary } = await playwrightService.openPage(BRIDGE_SESSION_ID, url);
	return { pageId, summary, reused: false };
});

CommandsRegistry.registerCommand('marvincode.browser.share', async (accessor, args: { pageId: string }): Promise<{ shared: boolean }> => {
	const model = await resolveModel(accessor.get(IBrowserViewWorkbenchService), args.pageId);
	if (model.sharingState === BrowserViewSharingState.Shared) {
		return { shared: true };
	}
	// Shows the workbench's "Share with Agent?" consent dialog
	return { shared: await model.setSharedWithAgent(true) };
});

CommandsRegistry.registerCommand('marvincode.browser.read', async (accessor, args: { pageId: string }): Promise<{ summary: string }> => {
	const playwrightService = accessor.get(IPlaywrightService);
	const browserViewService = accessor.get(IBrowserViewWorkbenchService);
	await requireSharedModel(browserViewService, args.pageId);
	const summary = await playwrightService.getSummary(BRIDGE_SESSION_ID, args.pageId);
	return { summary };
});

CommandsRegistry.registerCommand('marvincode.browser.screenshot', async (accessor, args: { pageId: string; ref?: string; selector?: string }): Promise<{ path: string }> => {
	const playwrightService = accessor.get(IPlaywrightService);
	const fileService = accessor.get(IFileService);
	const environmentService = accessor.get(INativeWorkbenchEnvironmentService);
	const model = await requireSharedModel(accessor.get(IBrowserViewWorkbenchService), args.pageId);

	const selector = args.ref ? `aria-ref=${args.ref}` : args.selector;
	const bounds = selector
		? (await playwrightService.invokeFunctionRaw(BRIDGE_SESSION_ID, args.pageId, serializeFn(async (page: Page, sel: unknown) => {
			const locator = page.locator(sel as string);
			await locator.scrollIntoViewIfNeeded();
			return locator.boundingBox();
		}), selector)) as { x: number; y: number; width: number; height: number } | null
		: undefined;

	const screenshot = await model.captureScreenshot({ pageRect: bounds ?? undefined });
	const data = screenshot instanceof VSBuffer ? screenshot : VSBuffer.wrap(screenshot);
	const target = joinPath(environmentService.tmpDir, `marvincode-browser-${generateUuid().slice(0, 8)}.jpg`);
	await fileService.writeFile(target, data);
	return { path: target.fsPath };
});

CommandsRegistry.registerCommand('marvincode.browser.navigate', async (accessor, args: { pageId: string; url?: string; action?: 'back' | 'forward' | 'reload' }): Promise<{ summary: string }> => {
	const playwrightService = accessor.get(IPlaywrightService);
	const networkFilterService = accessor.get(IAgentNetworkFilterService);
	await requireSharedModel(accessor.get(IBrowserViewWorkbenchService), args.pageId);

	if (args.action === 'reload') {
		await playwrightService.invokeFunction(BRIDGE_SESSION_ID, args.pageId, serializeFn((page: Page) => page.reload({ waitUntil: 'domcontentloaded' })), []);
	} else if (args.action === 'back') {
		await playwrightService.invokeFunction(BRIDGE_SESSION_ID, args.pageId, serializeFn((page: Page) => page.goBack({ waitUntil: 'domcontentloaded' })), []);
	} else if (args.action === 'forward') {
		await playwrightService.invokeFunction(BRIDGE_SESSION_ID, args.pageId, serializeFn((page: Page) => page.goForward({ waitUntil: 'domcontentloaded' })), []);
	} else if (args.url) {
		const url = checkUrlAllowed(networkFilterService, args.url);
		await playwrightService.invokeFunction(BRIDGE_SESSION_ID, args.pageId, serializeFn((page: Page, target: unknown) => page.goto(target as string, { waitUntil: 'domcontentloaded' })), [url]);
	} else {
		throw new Error('Either "url" or "action" (back | forward | reload) is required.');
	}
	const summary = await playwrightService.getSummary(BRIDGE_SESSION_ID, args.pageId);
	return { summary };
});

CommandsRegistry.registerCommand('marvincode.browser.click', async (accessor, args: { pageId: string; ref?: string; selector?: string; dblClick?: boolean; button?: 'left' | 'right' | 'middle' }): Promise<{ result?: unknown; error?: string; summary: string }> => {
	const playwrightService = accessor.get(IPlaywrightService);
	const browserViewService = accessor.get(IBrowserViewWorkbenchService);
	await requireSharedModel(browserViewService, args.pageId);
	const selector = args.ref ? `aria-ref=${args.ref}` : args.selector;
	if (!selector) {
		throw new Error('Either a "ref" (from read/open snapshots) or "selector" is required.');
	}
	const fn = args.dblClick
		? serializeFn((page: Page, sel: unknown, btn: unknown) => page.locator(sel as string).dblclick({ button: btn as 'left' | 'right' | 'middle' }))
		: serializeFn((page: Page, sel: unknown, btn: unknown) => page.locator(sel as string).click({ button: btn as 'left' | 'right' | 'middle' }));
	const result = await playwrightService.invokeFunction(BRIDGE_SESSION_ID, args.pageId, fn, [selector, args.button ?? 'left']);
	return { result: result.result, error: result.error, summary: result.summary };
});

CommandsRegistry.registerCommand('marvincode.browser.type', async (accessor, args: { pageId: string; ref?: string; selector?: string; text?: string; key?: string; submit?: boolean }): Promise<{ result?: unknown; error?: string; summary: string }> => {
	const playwrightService = accessor.get(IPlaywrightService);
	const browserViewService = accessor.get(IBrowserViewWorkbenchService);
	await requireSharedModel(browserViewService, args.pageId);
	if (!args.text && !args.key) {
		throw new Error('Either a "text" or "key" parameter is required.');
	}
	const selector = args.ref ? `aria-ref=${args.ref}` : args.selector;

	let fn: string;
	let fnArgs: unknown[];
	if (args.key) {
		fn = selector
			? serializeFn((page: Page, sel: unknown, key: unknown) => page.locator(sel as string).press(key as string))
			: serializeFn((page: Page, key: unknown) => page.keyboard.press(key as string));
		fnArgs = selector ? [selector, args.key] : [args.key];
	} else if (selector) {
		fn = serializeFn(async (page: Page, sel: unknown, text: unknown, submit: unknown) => {
			const locator = page.locator(sel as string);
			await locator.fill(text as string);
			if (submit) {
				await locator.press('Enter');
			}
		});
		fnArgs = [selector, args.text, args.submit ?? false];
	} else {
		fn = serializeFn(async (page: Page, text: unknown, submit: unknown) => {
			await page.keyboard.type(text as string);
			if (submit) {
				await page.keyboard.press('Enter');
			}
		});
		fnArgs = [args.text, args.submit ?? false];
	}
	const result = await playwrightService.invokeFunction(BRIDGE_SESSION_ID, args.pageId, fn, fnArgs);
	return { result: result.result, error: result.error, summary: result.summary };
});
