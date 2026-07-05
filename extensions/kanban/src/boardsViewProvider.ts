/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { discoverBoards, globalBoardsRoot, loadCards, parseBoardFile, readyCards } from './boardModel';
import { readJiraConfig } from './jira/config';

interface BoardItem {
	readonly label: string;
	readonly description: string;
	readonly tooltip: vscode.MarkdownString;
	readonly uri: vscode.Uri;
}

/**
 * Lists global boards (from the configured boards folder, available in
 * every window) and any boards found in the open workspace, with card and
 * readiness counts. The view badge totals ready cards across boards.
 */
export class BoardsViewProvider implements vscode.TreeDataProvider<BoardItem> {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private setBadge: (ready: number) => void = () => undefined;

	public static register(): vscode.Disposable {
		const provider = new BoardsViewProvider();
		const treeView = vscode.window.createTreeView('kanban.boards', { treeDataProvider: provider });
		provider.setBadge = ready => {
			treeView.badge = ready > 0 ? { value: ready, tooltip: vscode.l10n.t('{0} ready card(s)', ready) } : undefined;
		};
		const refresh = () => provider._onDidChangeTreeData.fire();
		const globalWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(globalBoardsRoot(), '*/.kanban/board.json'));
		const cardsWatcher = vscode.workspace.createFileSystemWatcher('**/.kanban/**');
		let debounce: ReturnType<typeof setTimeout> | undefined;
		const debouncedRefresh = () => {
			if (debounce) {
				clearTimeout(debounce);
			}
			debounce = setTimeout(refresh, 500);
		};
		const disposables = [
			treeView,
			vscode.commands.registerCommand('kanban.refreshBoards', refresh),
			vscode.workspace.onDidCreateFiles(debouncedRefresh),
			vscode.workspace.onDidDeleteFiles(debouncedRefresh),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('kanban.globalBoardsFolder')) {
					refresh();
				}
			}),
			globalWatcher,
			globalWatcher.onDidCreate(debouncedRefresh),
			globalWatcher.onDidDelete(debouncedRefresh),
			cardsWatcher,
			cardsWatcher.onDidChange(debouncedRefresh),
			cardsWatcher.onDidCreate(debouncedRefresh),
			cardsWatcher.onDidDelete(debouncedRefresh),
			provider._onDidChangeTreeData
		];
		return vscode.Disposable.from(...disposables);
	}

	getTreeItem(element: BoardItem): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label);
		item.description = element.description;
		item.tooltip = element.tooltip;
		item.iconPath = new vscode.ThemeIcon('layout');
		item.command = {
			command: 'vscode.openWith',
			title: vscode.l10n.t('Open Board'),
			arguments: [element.uri, 'kanban.board']
		};
		return item;
	}

	async getChildren(element?: BoardItem): Promise<BoardItem[]> {
		if (element) {
			return [];
		}
		const items: BoardItem[] = [];
		let readyTotal = 0;
		for (const boardRef of await discoverBoards()) {
			let description = boardRef.scope === 'global' ? vscode.l10n.t('global') : '';
			const tooltip = new vscode.MarkdownString(undefined, true);
			tooltip.appendMarkdown(`**${boardRef.name}**\n\n`);
			try {
				const board = parseBoardFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(boardRef.uri)));
				const cards = await loadCards(boardRef.uri);
				const ready = readyCards(board, cards).length;
				readyTotal += ready;
				description = vscode.l10n.t('{0} cards · {1} ready', cards.length, ready);
				for (const column of board.columns) {
					tooltip.appendMarkdown(`$(circle-small) ${column.title}: ${cards.filter(card => card.column === column.id).length}\n\n`);
				}
				const jira = await readJiraConfig(boardRef.uri);
				tooltip.appendMarkdown(jira
					? `$(link) Jira: **${jira.projectKey}**`
					: `$(circle-slash) Not linked to Jira`);
			} catch {
				// Counting is best-effort — an unreadable board still lists
			}
			items.push({ label: boardRef.name, description, tooltip, uri: boardRef.uri });
		}
		this.setBadge(readyTotal);
		return items;
	}
}
