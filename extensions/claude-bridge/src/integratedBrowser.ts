/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Thin adapter over the fork's `marvincode.browser.*` workbench commands
// (src/vs/workbench/contrib/marvinBridge), which expose the Integrated
// Browser with the same consent model as the in-editor browser tools.

import * as vscode from 'vscode';
import type {
	ClickBrowserElementInputT,
	InteractionOutputT,
	ListBrowserPagesOutputT,
	NavigateBrowserPageInputT,
	NavigateBrowserPageOutputT,
	OpenBrowserPageInputT,
	OpenBrowserPageOutputT,
	ReadBrowserPageInputT,
	ReadBrowserPageOutputT,
	ScreenshotBrowserPageInputT,
	ScreenshotBrowserPageOutputT,
	ShareBrowserPageInputT,
	ShareBrowserPageOutputT,
	TypeInBrowserPageInputT,
} from './shared/schema';

async function run<T>(command: string, args?: unknown): Promise<T> {
	const result = await vscode.commands.executeCommand<T>(command, args);
	if (result === undefined) {
		throw new Error(`${command} is unavailable — this build of MarvinCode may not include the Integrated Browser bridge.`);
	}
	return result;
}

export function listBrowserPages(): Promise<ListBrowserPagesOutputT> {
	return run('marvincode.browser.listPages');
}

export function openBrowserPage(args: OpenBrowserPageInputT): Promise<OpenBrowserPageOutputT> {
	return run('marvincode.browser.open', args);
}

export function shareBrowserPage(args: ShareBrowserPageInputT): Promise<ShareBrowserPageOutputT> {
	return run('marvincode.browser.share', args);
}

export function readBrowserPage(args: ReadBrowserPageInputT): Promise<ReadBrowserPageOutputT> {
	return run('marvincode.browser.read', args);
}

export function screenshotBrowserPage(args: ScreenshotBrowserPageInputT): Promise<ScreenshotBrowserPageOutputT> {
	return run('marvincode.browser.screenshot', args);
}

export function navigateBrowserPage(args: NavigateBrowserPageInputT): Promise<NavigateBrowserPageOutputT> {
	return run('marvincode.browser.navigate', args);
}

export function clickBrowserElement(args: ClickBrowserElementInputT): Promise<InteractionOutputT> {
	return run('marvincode.browser.click', args);
}

export function typeInBrowserPage(args: TypeInBrowserPageInputT): Promise<InteractionOutputT> {
	return run('marvincode.browser.type', args);
}
