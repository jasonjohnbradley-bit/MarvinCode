/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentRun, AgentRunner, STALL_THRESHOLD_MS } from './agentRunner';

function stateOf(run: AgentRun): { label: string; icon: vscode.ThemeIcon } {
	switch (run.state) {
		case 'queued':
			return { label: vscode.l10n.t('queued'), icon: new vscode.ThemeIcon('watch') };
		case 'working':
			return Date.now() - run.lastOutputAt > STALL_THRESHOLD_MS
				? { label: vscode.l10n.t('stalled'), icon: new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')) }
				: { label: vscode.l10n.t('working'), icon: new vscode.ThemeIcon('sync~spin') };
		case 'done':
			return { label: vscode.l10n.t('done'), icon: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')) };
		case 'killed':
			return { label: vscode.l10n.t('killed'), icon: new vscode.ThemeIcon('circle-slash') };
		default:
			return { label: vscode.l10n.t('failed'), icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')) };
	}
}

function elapsed(run: AgentRun): string {
	const from = run.startedAt ?? run.queuedAt;
	const to = run.endedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((to - from) / 1000));
	return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/** The live agent-status ("Horde") panel: one row per agent run. */
export class AgentsViewProvider implements vscode.TreeDataProvider<AgentRun> {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	public static register(runner: AgentRunner): vscode.Disposable {
		const provider = new AgentsViewProvider(runner);
		const ticker = setInterval(() => provider._onDidChangeTreeData.fire(), 5_000);
		return vscode.Disposable.from(
			vscode.window.registerTreeDataProvider('kanban.agents', provider),
			runner.onDidChange(() => provider._onDidChangeTreeData.fire()),
			new vscode.Disposable(() => clearInterval(ticker)),
			provider._onDidChangeTreeData
		);
	}

	constructor(private readonly runner: AgentRunner) { }

	getTreeItem(run: AgentRun): vscode.TreeItem {
		const { label, icon } = stateOf(run);
		const item = new vscode.TreeItem(`${run.kind === 'coordinator' ? 'DM: ' : ''}${run.card.title}`);
		item.description = `${label} · ${elapsed(run)}`;
		item.iconPath = icon;
		item.contextValue = run.state === 'working' || run.state === 'queued' ? 'kanbanAgentRunning' : 'kanbanAgentFinished';
		item.id = run.id;
		const tools = [...run.toolNames];
		item.tooltip = [
			`${run.card.title} [${run.card.id}]`,
			`State: ${label}`,
			run.branch ? `Branch: ${run.branch}` : undefined,
			run.claudeSessionId ? `Session: ${run.claudeSessionId}` : undefined,
			tools.length ? `Tools: ${tools.slice(0, 12).join(', ')}` : undefined,
			run.stderrTail && run.state === 'failed' ? `stderr: ${run.stderrTail.slice(-200)}` : undefined
		].filter(Boolean).join('\n');
		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open Card'),
			arguments: [run.card.uri]
		};
		return item;
	}

	getChildren(element?: AgentRun): AgentRun[] {
		if (element) {
			return [];
		}
		return [...this.runner.runs.values()].sort((a, b) => b.queuedAt - a.queuedAt).slice(0, 50);
	}
}
