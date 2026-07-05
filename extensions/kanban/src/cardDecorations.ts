/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { parseFrontMatter, PRIORITIES } from './boardModel';

const CARD_PATH = /[/\\]\.kanban[/\\]cards[/\\][\w.-]+\.md$/;

const PRIORITY_COLORS: Record<string, string> = {
	urgent: 'charts.red',
	high: 'charts.orange',
	medium: 'charts.yellow',
	low: 'charts.green'
};

/**
 * Explorer badges for card files: a running agent shows "A", otherwise the
 * priority initial in its priority color.
 */
export class CardDecorationProvider implements vscode.FileDecorationProvider {

	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	public static register(): vscode.Disposable {
		const provider = new CardDecorationProvider();
		const watcher = vscode.workspace.createFileSystemWatcher('**/.kanban/cards/*.md');
		const refresh = (uri: vscode.Uri) => provider._onDidChangeFileDecorations.fire(uri);
		return vscode.Disposable.from(
			vscode.window.registerFileDecorationProvider(provider),
			watcher,
			watcher.onDidChange(refresh),
			watcher.onDidCreate(refresh),
			watcher.onDidDelete(refresh),
			provider._onDidChangeFileDecorations
		);
	}

	async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
		if (!CARD_PATH.test(uri.fsPath)) {
			return undefined;
		}
		try {
			const { meta } = parseFrontMatter(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
			if (meta['agentStatus'] === 'running') {
				return new vscode.FileDecoration('A', vscode.l10n.t('An agent is working on this card'), new vscode.ThemeColor('charts.orange'));
			}
			if (meta['agentStatus'] === 'failed') {
				return new vscode.FileDecoration('A', vscode.l10n.t('The last agent run on this card failed'), new vscode.ThemeColor('errorForeground'));
			}
			const priority = meta['priority'];
			if (priority && (PRIORITIES as readonly string[]).includes(priority)) {
				return new vscode.FileDecoration(priority[0].toUpperCase(), vscode.l10n.t('Priority: {0}', priority), new vscode.ThemeColor(PRIORITY_COLORS[priority]));
			}
		} catch {
			// Undecorated is fine for unreadable files
		}
		return undefined;
	}
}
