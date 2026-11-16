/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Thin adapter over the chrome-tab extension's `marvincode.chrome.*` commands:
// real headless Google Chrome shown in an editor tab, signed in through the Mac's
// device SSO, for sites the Integrated Browser cannot reach. Same shapes and
// consent model as ./integratedBrowser; page ids start with `chrome:`.

import * as vscode from 'vscode';
import type {
	ClickBrowserElementInputT,
	InteractionOutputT,
	ListBrowserPagesOutputT,
	NavigateBrowserPageInputT,
	NavigateBrowserPageOutputT,
	OpenBrowserPageOutputT,
	ReadBrowserPageInputT,
	ReadBrowserPageOutputT,
	ScreenshotBrowserPageInputT,
	ScreenshotBrowserPageOutputT,
	ShareBrowserPageInputT,
	ShareBrowserPageOutputT,
	TypeInBrowserPageInputT,
} from './shared/schema';

export const CHROME_PAGE_PREFIX = 'chrome:';

export function isChromePageId(pageId: string): boolean {
	return pageId.startsWith(CHROME_PAGE_PREFIX);
}

async function run<T>(command: string, args?: unknown): Promise<T> {
	let result: T | undefined;
	try {
		result = await vscode.commands.executeCommand<T>(command, args);
	} catch (error) {
		if (/command .* not found/i.test(error instanceof Error ? error.message : String(error))) {
			throw new Error(`${command} is unavailable — the Chrome Tab extension is not installed or not enabled in this build of MarvinCode.`);
		}
		throw error;
	}
	if (result === undefined) {
		throw new Error(`${command} returned nothing — the Chrome Tab extension may still be starting.`);
	}
	return result;
}

/** Chrome Tab pages, or none when the extension is absent. */
export async function listBrowserPages(): Promise<ListBrowserPagesOutputT> {
	try {
		return await run<ListBrowserPagesOutputT>('marvincode.chrome.listPages');
	} catch {
		return { pages: [] };
	}
}

export function openBrowserPage(args: { url: string; forceNew: boolean }): Promise<OpenBrowserPageOutputT> {
	return run('marvincode.chrome.open', args);
}

export function shareBrowserPage(args: ShareBrowserPageInputT): Promise<ShareBrowserPageOutputT> {
	return run('marvincode.chrome.share', args);
}

export function readBrowserPage(args: ReadBrowserPageInputT): Promise<ReadBrowserPageOutputT> {
	return run('marvincode.chrome.read', args);
}

export function screenshotBrowserPage(args: ScreenshotBrowserPageInputT): Promise<ScreenshotBrowserPageOutputT> {
	return run('marvincode.chrome.screenshot', args);
}

export function navigateBrowserPage(args: NavigateBrowserPageInputT): Promise<NavigateBrowserPageOutputT> {
	return run('marvincode.chrome.navigate', args);
}

export function clickBrowserElement(args: ClickBrowserElementInputT): Promise<InteractionOutputT> {
	return run('marvincode.chrome.click', args);
}

export function typeInBrowserPage(args: TypeInBrowserPageInputT): Promise<InteractionOutputT> {
	return run('marvincode.chrome.type', args);
}
