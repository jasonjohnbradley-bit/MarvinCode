/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Opens a URL, preferring MarvinCode's Integrated Browser, then the built-in
 * Simple Browser, and finally the system browser.
 */
export async function openUrl(url: string): Promise<void> {
	try {
		await vscode.commands.executeCommand('marvincode.browser.open', { url });
		return;
	} catch {
		// Integrated Browser not available in this build.
	}
	try {
		await vscode.commands.executeCommand('simpleBrowser.show', url);
		return;
	} catch {
		// Simple Browser extension not available.
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}
