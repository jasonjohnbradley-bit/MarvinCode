/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentRun, AgentRunner, STALL_THRESHOLD_MS } from './agentRunner';

interface AgentsGroup {
	readonly group: string;
}

type AgentsElement = AgentRun | AgentsGroup;

function isGroup(element: AgentsElement): element is AgentsGroup {
	return typeof (element as { group?: unknown }).group === 'string';
}

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

/**
 * The live agent-status ("Horde") panel: campaign runs grouped under their
 * campaign, standalone runs at the root. The view badge counts active runs.
 */
export class AgentsViewProvider implements vscode.TreeDataProvider<AgentsElement> {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	public static register(runner: AgentRunner): vscode.Disposable {
		const provider = new AgentsViewProvider(runner);
		const treeView = vscode.window.createTreeView('kanban.agents', { treeDataProvider: provider });
		const updateBadge = () => {
			const active = [...runner.runs.values()].filter(run => run.state === 'working' || run.state === 'queued').length;
			treeView.badge = active > 0 ? { value: active, tooltip: vscode.l10n.t('{0} active agent(s)', active) } : undefined;
		};
		const ticker = setInterval(() => provider._onDidChangeTreeData.fire(), 5_000);
		return vscode.Disposable.from(
			treeView,
			runner.onDidChange(() => {
				provider._onDidChangeTreeData.fire();
				updateBadge();
			}),
			new vscode.Disposable(() => clearInterval(ticker)),
			provider._onDidChangeTreeData
		);
	}

	constructor(private readonly runner: AgentRunner) { }

	private recentRuns(): AgentRun[] {
		return [...this.runner.runs.values()].sort((a, b) => b.queuedAt - a.queuedAt).slice(0, 100);
	}

	getTreeItem(element: AgentsElement): vscode.TreeItem {
		if (isGroup(element)) {
			const runs = this.recentRuns().filter(run => run.groupLabel === element.group);
			const active = runs.filter(run => run.state === 'working' || run.state === 'queued').length;
			const item = new vscode.TreeItem(element.group, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = active ? new vscode.ThemeIcon('rocket', new vscode.ThemeColor('charts.orange')) : new vscode.ThemeIcon('rocket');
			item.description = active ? vscode.l10n.t('{0} active', active) : vscode.l10n.t('finished');
			item.id = `group:${element.group}`;
			return item;
		}
		const run = element;
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

	getChildren(element?: AgentsElement): AgentsElement[] {
		const runs = this.recentRuns();
		if (element) {
			return isGroup(element) ? runs.filter(run => run.groupLabel === element.group) : [];
		}
		const groups = [...new Set(runs.filter(run => run.groupLabel).map(run => run.groupLabel!))];
		return [
			...groups.map(group => ({ group })),
			...runs.filter(run => !run.groupLabel)
		];
	}
}
