/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const LAUNCHER_VIEW_ID = 'marvincode.chrome.launcher';

/**
 * The Chrome activity-bar icon, as a launcher like the kanban extension's Agents
 * Window and Browser icons: its view stays empty (package.json `viewsWelcome`
 * draws the buttons), and the hidden-to-visible change a click on the icon causes
 * runs `command`.
 */
export function registerLauncher(command: string): vscode.Disposable {
	const treeView = vscode.window.createTreeView(LAUNCHER_VIEW_ID, {
		treeDataProvider: { getTreeItem: (item: vscode.TreeItem) => item, getChildren: () => [] },
	});
	// A window that restores with the view already showing must not open a tab on
	// startup; only a later hidden-to-visible change counts as a click.
	let armed = !treeView.visible;
	const listener = treeView.onDidChangeVisibility(e => {
		if (e.visible && armed) {
			void vscode.commands.executeCommand(command);
		} else if (!e.visible) {
			armed = true;
		}
	});
	return vscode.Disposable.from(treeView, listener);
}
