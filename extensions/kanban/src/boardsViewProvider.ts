/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { globalBoardsRoot } from './boardModel';

interface BoardItem {
	readonly label: string;
	readonly description: string;
	readonly uri: vscode.Uri;
}

async function boardName(uri: vscode.Uri, fallback: string): Promise<string> {
	try {
		const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
		if (typeof raw.name === 'string' && raw.name.length > 0) {
			return raw.name;
		}
	} catch {
		// Fall through to the fallback label
	}
	return fallback;
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
		const items: BoardItem[] = [];

		// Global boards: <root>/<board>/.kanban/board.json (and <root>/.kanban itself)
		const root = globalBoardsRoot();
		const candidates: vscode.Uri[] = [vscode.Uri.joinPath(root, '.kanban', 'board.json')];
		try {
			for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
				if (type === vscode.FileType.Directory && name !== '.kanban') {
					candidates.push(vscode.Uri.joinPath(root, name, '.kanban', 'board.json'));
				}
			}
		} catch {
			// Global boards folder does not exist yet — that is fine
		}
		for (const uri of candidates) {
			try {
				await vscode.workspace.fs.stat(uri);
				items.push({
					label: await boardName(uri, path.basename(path.dirname(path.dirname(uri.fsPath)))),
					description: vscode.l10n.t('global'),
					uri
				});
			} catch {
				// Not a board
			}
		}

		// Workspace boards (skipped automatically when no folder is open)
		const workspaceBoards = await vscode.workspace.findFiles('**/.kanban/board.json', '**/node_modules/**');
		for (const uri of workspaceBoards.sort((a, b) => a.path.localeCompare(b.path))) {
			if (items.some(item => item.uri.toString() === uri.toString())) {
				continue;
			}
			items.push({
				label: await boardName(uri, vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..', '..'))),
				description: vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..', '..')),
				uri
			});
		}
		return items;
	}
}
