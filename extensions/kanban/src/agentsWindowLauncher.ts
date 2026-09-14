/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Activity-bar launcher views. Each view stays empty — its welcome content
 * (package.json `viewsWelcome`) renders the fallback button — and revealing
 * the view by clicking the activity-bar icon runs the command directly, so
 * the icon behaves like a launcher button.
 */
const LAUNCHERS: readonly { viewId: string; command: string }[] = [
	{ viewId: 'kanban.agentsWindowLauncher', command: 'workbench.action.openAgentsWindow' },
	{ viewId: 'kanban.browserLauncher', command: 'workbench.action.browser.open' }
];

function registerLauncher(viewId: string, command: string): vscode.Disposable {
	const emptyProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
		getTreeItem: item => item,
		getChildren: () => []
	};
	const treeView = vscode.window.createTreeView(viewId, { treeDataProvider: emptyProvider });

	// If the window restores with this view already showing, do not run the
	// command on startup — only launch on a later hidden→visible transition,
	// which is what a click on the activity-bar icon produces.
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

export class LauncherViews {
	public static register(): vscode.Disposable {
		return vscode.Disposable.from(...LAUNCHERS.map(launcher => registerLauncher(launcher.viewId, launcher.command)));
	}
}
