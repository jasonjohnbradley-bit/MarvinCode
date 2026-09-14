/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BridgeServer } from './bridgeServer';
import { SimpleBrowserTracker } from './simpleBrowser';

let server: BridgeServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel(vscode.l10n.t('Claude Bridge'));
	context.subscriptions.push(output);

	const tracker = new SimpleBrowserTracker();
	context.subscriptions.push(tracker);

	server = new BridgeServer({ output, tracker });
	context.subscriptions.push(server);

	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.text = '$(plug) Claude Bridge: starting';
	statusItem.tooltip = vscode.l10n.t('Claude VS Code Bridge');
	statusItem.command = 'claudeVscodeBridge.status';
	statusItem.show();
	context.subscriptions.push(statusItem);

	try {
		const info = await server.start();
		statusItem.text = '$(check) Claude Bridge';
		statusItem.tooltip = vscode.l10n.t('Socket: {0}\nWorkspace: {1}', info.socketPath, info.workspaceRoot ?? vscode.l10n.t('(no workspace)'));
		output.appendLine(`[bridge] listening at ${info.socketPath}`);
	} catch (err) {
		statusItem.text = '$(error) Claude Bridge';
		statusItem.tooltip = vscode.l10n.t('Failed: {0}', (err as Error).message);
		output.appendLine(`[bridge] failed to start: ${(err as Error).stack ?? String(err)}`);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeVscodeBridge.status', () => {
			const s = server?.status();
			void vscode.window.showInformationMessage(
				s
					? vscode.l10n.t('Claude Bridge listening at {0} (workspace: {1})', s.socketPath, s.workspaceRoot ?? vscode.l10n.t('none'))
					: vscode.l10n.t('Claude Bridge not running')
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeVscodeBridge.restart', async () => {
			if (!server) {
				return;
			}
			output.appendLine('[bridge] restart requested');
			await server.stop();
			const info = await server.start();
			output.appendLine(`[bridge] restarted at ${info.socketPath}`);
			statusItem.text = '$(check) Claude Bridge';
			statusItem.tooltip = vscode.l10n.t('Socket: {0}', info.socketPath);
		})
	);
}

export async function deactivate(): Promise<void> {
	await server?.stop();
}
