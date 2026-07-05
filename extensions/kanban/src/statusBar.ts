/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { discoverBoards, loadCards, parseBoardFile, readyCards } from './boardModel';
import { AgentRunner } from './campaign/agentRunner';

/**
 * Status bar summary: ready-card count across boards plus a spinner while
 * agents are working. Clicking focuses the Kanban sidebar.
 */
export function registerStatusBar(runner: AgentRunner): vscode.Disposable {
	const item = vscode.window.createStatusBarItem('kanban.status', vscode.StatusBarAlignment.Left, 90);
	item.name = vscode.l10n.t('Kanban');
	item.command = 'workbench.view.extension.kanban';

	let debounce: ReturnType<typeof setTimeout> | undefined;
	let lastReady = 0;

	const renderText = () => {
		const active = [...runner.runs.values()].filter(run => run.state === 'working' || run.state === 'queued').length;
		const parts = [`$(layout) ${lastReady} ready`];
		if (active) {
			parts.push(`$(sync~spin) ${active} agent${active === 1 ? '' : 's'}`);
		}
		item.text = parts.join('  ');
		item.tooltip = vscode.l10n.t('Kanban: {0} ready card(s), {1} active agent(s)', lastReady, active);
		item.show();
	};

	const recount = async () => {
		let ready = 0;
		try {
			for (const boardRef of await discoverBoards()) {
				const board = parseBoardFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(boardRef.uri)));
				ready += readyCards(board, await loadCards(boardRef.uri)).length;
			}
		} catch {
			// Best-effort counting
		}
		lastReady = ready;
		renderText();
	};

	const scheduleRecount = () => {
		if (debounce) {
			clearTimeout(debounce);
		}
		debounce = setTimeout(() => void recount(), 1_000);
	};

	const watcher = vscode.workspace.createFileSystemWatcher('**/.kanban/**');
	void recount();

	return vscode.Disposable.from(
		item,
		watcher,
		watcher.onDidChange(scheduleRecount),
		watcher.onDidCreate(scheduleRecount),
		watcher.onDidDelete(scheduleRecount),
		runner.onDidChange(renderText),
		new vscode.Disposable(() => debounce && clearTimeout(debounce))
	);
}
