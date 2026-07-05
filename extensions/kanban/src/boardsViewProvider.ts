/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { discoverBoards, globalBoardsRoot } from './boardModel';

interface BoardItem {
	readonly label: string;
	readonly description: string;
	readonly uri: vscode.Uri;
}

/**
 * Lists global boards (from the configured boards folder, available in
 * every window) and any boards found in the open workspace.
 */
export class BoardsViewProvider implements vscode.TreeDataProvider<BoardItem> {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	public static register(): vscode.Disposable {
		const provider = new BoardsViewProvider();
		const refresh = () => provider._onDidChangeTreeData.fire();
		const globalWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(globalBoardsRoot(), '*/.kanban/board.json'));
		const disposables = [
			vscode.window.registerTreeDataProvider('kanban.boards', provider),
			vscode.commands.registerCommand('kanban.refreshBoards', refresh),
			vscode.workspace.onDidCreateFiles(refresh),
			vscode.workspace.onDidDeleteFiles(refresh),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('kanban.globalBoardsFolder')) {
					refresh();
				}
			}),
			globalWatcher,
			globalWatcher.onDidCreate(refresh),
			globalWatcher.onDidDelete(refresh),
			provider._onDidChangeTreeData
		];
		return vscode.Disposable.from(...disposables);
	}

	getTreeItem(element: BoardItem): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label);
		item.description = element.description;
		item.iconPath = new vscode.ThemeIcon('project');
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
		return (await discoverBoards()).map(board => ({
			label: board.name,
			description: board.scope === 'global'
				? vscode.l10n.t('global')
				: vscode.workspace.asRelativePath(vscode.Uri.joinPath(board.uri, '..', '..')),
			uri: board.uri
		}));
	}
}
