/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { setLangfuseLogger } from './api';
import { openUrl } from './browser';
import { disconnect, getClient, setKeys } from './config';
import { TraceDetailPanel } from './traceDetail';
import { TraceElement, TracesViewProvider } from './tracesView';

export function activate(context: vscode.ExtensionContext): void {
	const secrets = context.secrets;

	const log = vscode.window.createOutputChannel('Langfuse', { log: true });
	context.subscriptions.push(log, { dispose: () => setLangfuseLogger(undefined) });
	setLangfuseLogger({ trace: message => log.trace(message), error: message => log.error(message) });
	const provider = new TracesViewProvider(secrets);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('langfuse.traces', provider));

	// Seed the connected context key so the welcome view shows the right prompt.
	void getClient(secrets).then(client => vscode.commands.executeCommand('setContext', 'langfuse.connected', !!client));
	provider.startAutoRefreshIfConfigured();

	const requireClient = async () => {
		const client = await getClient(secrets);
		if (!client) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Not connected to Langfuse — run "Langfuse: Set API Keys".'));
		}
		return client;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('langfuse.setKeys', async () => {
			if (await setKeys(secrets)) {
				await vscode.commands.executeCommand('setContext', 'langfuse.connected', true);
				provider.refresh();
			}
		}),
		vscode.commands.registerCommand('langfuse.disconnect', async () => {
			await disconnect(secrets);
			await vscode.commands.executeCommand('setContext', 'langfuse.connected', false);
			provider.refresh();
		}),
		vscode.commands.registerCommand('langfuse.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('langfuse.setFilter', () => provider.setFilter()),
		vscode.commands.registerCommand('langfuse.clearFilter', () => provider.clearFilter()),
		vscode.commands.registerCommand('langfuse.toggleAutoRefresh', () => provider.toggleAutoRefresh()),
		vscode.commands.registerCommand('langfuse.openTrace', async (element?: TraceElement) => {
			if (element?.kind !== 'trace') {
				return;
			}
			const client = await requireClient();
			if (client) {
				TraceDetailPanel.show(client, element.trace);
			}
		}),
		vscode.commands.registerCommand('langfuse.openInLangfuse', async (element?: TraceElement) => {
			if (element?.kind !== 'trace') {
				return;
			}
			const client = await getClient(secrets);
			if (client) {
				await openUrl(client.traceUrl(element.trace));
			}
		}),
		vscode.commands.registerCommand('langfuse.copyTraceId', async (element?: TraceElement) => {
			if (element?.kind === 'trace') {
				await vscode.env.clipboard.writeText(element.trace.id);
				void vscode.window.showInformationMessage(vscode.l10n.t('Trace ID copied.'));
			}
		}),
	);
}
