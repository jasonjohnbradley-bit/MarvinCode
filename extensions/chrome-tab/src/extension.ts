/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerAgentCommands } from './agentCommands';
import { ChromeHost } from './chromeHost';
import { CHROME_TAB_VIEW_TYPE } from './chromeTab';
import { hostMatchesAny } from './networkFilter';
import { ChromeTabs } from './tabs';

let host: ChromeHost | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Chrome Tab', { log: true });
	host = new ChromeHost(vscode.Uri.joinPath(context.globalStorageUri, 'chrome').fsPath, log);
	const tabs = new ChromeTabs(host, context.extensionUri, log);
	context.subscriptions.push(log, host, tabs);

	registerAgentCommands(context, tabs);

	context.subscriptions.push(
		vscode.commands.registerCommand('marvincode.chrome.openUrl', async (url?: string) => {
			if (typeof url !== 'string' || !url) {
				const clip = (await vscode.env.clipboard.readText()).trim();
				url = await vscode.window.showInputBox({
					title: vscode.l10n.t('Open URL in Chrome Tab'),
					prompt: vscode.l10n.t('Opens in real Google Chrome, signed in with this Mac\'s Caseware device identity'),
					value: /^https?:\/\/\S+$/.test(clip) ? clip : 'https://',
				});
			}
			if (url) {
				tabs.open({ url: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` });
			}
		}),

		vscode.commands.registerCommand('marvincode.chrome.openActiveBrowserPage', async () => {
			const result = await vscode.commands.executeCommand<{ pages: { url: string; title: string }[] } | undefined>('marvincode.browser.listPages')
				.then(r => r, () => undefined);
			const pages = (result?.pages ?? []).filter(p => /^https?:/.test(p.url));
			if (pages.length === 0) {
				void vscode.window.showInformationMessage(vscode.l10n.t('No Integrated Browser page with a web address is open.'));
				return;
			}
			const picked = pages.length === 1 ? pages[0] : (await vscode.window.showQuickPick(
				pages.map(p => ({ label: p.title || p.url, description: p.url, page: p })),
				{ title: vscode.l10n.t('Move which page to a Chrome Tab?') }))?.page;
			if (picked) {
				tabs.open({ url: picked.url });
			}
		}),

		vscode.commands.registerCommand('marvincode.chrome.restart', async () => {
			if (tabs.list().length > 0) {
				const restart = vscode.l10n.t('Restart');
				const picked = await vscode.window.showWarningMessage(
					vscode.l10n.t('Restarting Chrome closes all Chrome Tabs.'), { modal: true }, restart);
				if (picked !== restart) {
					return;
				}
			}
			tabs.closeAll();
			await host?.close();
			void vscode.window.showInformationMessage(vscode.l10n.t('Chrome will start again with the next Chrome Tab.'));
		}),

		vscode.commands.registerCommand('marvincode.chrome.showLogs', () => log.show()),

		// Without this, a window reload or extension host restart leaves dead Chrome
		// Tab panels behind. Restored tabs reopen their last URL (the profile keeps
		// the device sign-in) and come back unshared: agents must ask again.
		vscode.window.registerWebviewPanelSerializer(CHROME_TAB_VIEW_TYPE, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
				const url = (state as { url?: unknown } | undefined)?.url;
				if (typeof url === 'string' && /^https?:/.test(url)) {
					tabs.open({ url, panel });
				} else {
					panel.dispose();
				}
			},
		}),

		vscode.window.registerExternalUriOpener('marvincode.chromeTab', {
			canOpenExternalUri(uri: vscode.Uri) {
				const hosts = vscode.workspace.getConfiguration('marvincode.chrome').get<string[]>('hosts', []);
				return hosts.length > 0 && hostMatchesAny(uri.toString(true), hosts)
					? vscode.ExternalUriOpenerPriority.Preferred
					: vscode.ExternalUriOpenerPriority.None;
			},
			openExternalUri(resolvedUri: vscode.Uri) {
				tabs.open({ url: resolvedUri.toString(true) });
			},
		}, {
			schemes: ['http', 'https'],
			label: vscode.l10n.t('Open in Chrome Tab'),
		}),
	);
}

export function deactivate(): Promise<void> | undefined {
	return host?.close();
}
