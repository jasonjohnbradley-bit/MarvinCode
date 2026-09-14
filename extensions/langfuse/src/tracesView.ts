/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LangfuseTrace } from './api';
import { getClient } from './config';

export type TraceElement =
	| { readonly kind: 'trace'; readonly trace: LangfuseTrace }
	| { readonly kind: 'message'; readonly icon: string; readonly message: string };

interface TraceFilter {
	name?: string;
	userId?: string;
	tags?: string[];
	lookbackHours?: number;
}

const DEFAULT_AUTO_REFRESH_SECONDS = 15;

function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return iso;
	}
	const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (seconds < 60) { return `${seconds}s ago`; }
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) { return `${minutes}m ago`; }
	const hours = Math.round(minutes / 60);
	if (hours < 24) { return `${hours}h ago`; }
	return new Date(then).toLocaleDateString();
}

function formatDuration(seconds: number | null | undefined): string | undefined {
	if (typeof seconds !== 'number' || !isFinite(seconds)) {
		return undefined;
	}
	return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
}

function formatCost(cost: number | null | undefined): string | undefined {
	if (typeof cost !== 'number' || !isFinite(cost) || cost === 0) {
		return undefined;
	}
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
}

/** The "Traces" sidebar: recent Langfuse traces with filtering and auto-refresh. */
export class TracesViewProvider implements vscode.TreeDataProvider<TraceElement>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly filter: TraceFilter = {};
	private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly secrets: vscode.SecretStorage) { }

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TraceElement): vscode.TreeItem {
		if (element.kind === 'message') {
			const item = new vscode.TreeItem(element.message);
			item.iconPath = new vscode.ThemeIcon(element.icon);
			return item;
		}
		const trace = element.trace;
		const item = new vscode.TreeItem(trace.name?.trim() || trace.id);
		item.description = [relativeTime(trace.timestamp), formatDuration(trace.latency), formatCost(trace.totalCost)]
			.filter(Boolean).join(' · ');
		item.iconPath = new vscode.ThemeIcon('pulse');
		item.contextValue = 'langfuseTrace';
		item.tooltip = this.tooltip(trace);
		item.command = { command: 'langfuse.openTrace', title: vscode.l10n.t('Open Trace'), arguments: [element] };
		return item;
	}

	private tooltip(trace: LangfuseTrace): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${trace.name?.trim() || vscode.l10n.t('(unnamed trace)')}**\n\n`);
		const rows: [string, string | undefined | null][] = [
			[vscode.l10n.t('ID'), trace.id],
			[vscode.l10n.t('Time'), new Date(trace.timestamp).toLocaleString()],
			[vscode.l10n.t('User'), trace.userId],
			[vscode.l10n.t('Session'), trace.sessionId],
			[vscode.l10n.t('Environment'), trace.environment],
			[vscode.l10n.t('Release'), trace.release],
			[vscode.l10n.t('Version'), trace.version],
			[vscode.l10n.t('Tags'), trace.tags?.length ? trace.tags.join(', ') : undefined],
		];
		for (const [label, value] of rows) {
			if (value) {
				md.appendMarkdown(`${label}: \`${value}\`\n\n`);
			}
		}
		return md;
	}

	async getChildren(element?: TraceElement): Promise<TraceElement[]> {
		if (element) {
			return [];
		}
		const client = await getClient(this.secrets);
		await vscode.commands.executeCommand('setContext', 'langfuse.connected', !!client);
		if (!client) {
			return [];
		}
		try {
			const cfg = vscode.workspace.getConfiguration('langfuse');
			const result = await client.listTraces({
				limit: cfg.get<number>('traceLimit', 50),
				name: this.filter.name,
				userId: this.filter.userId,
				tags: this.filter.tags,
				fromTimestamp: this.filter.lookbackHours
					? new Date(Date.now() - this.filter.lookbackHours * 3600_000).toISOString()
					: undefined,
			});
			return result.data.map(trace => ({ kind: 'trace', trace }));
		} catch (err) {
			return [{ kind: 'message', icon: 'error', message: err instanceof Error ? err.message : String(err) }];
		}
	}

	/** Edit one filter field via a quick pick, then refresh. */
	async setFilter(): Promise<void> {
		const pick = await vscode.window.showQuickPick(
			[
				{ label: vscode.l10n.t('Name'), key: 'name', value: this.filter.name },
				{ label: vscode.l10n.t('User ID'), key: 'userId', value: this.filter.userId },
				{ label: vscode.l10n.t('Tags (comma-separated)'), key: 'tags', value: this.filter.tags?.join(', ') },
				{ label: vscode.l10n.t('Lookback (hours)'), key: 'lookbackHours', value: this.filter.lookbackHours?.toString() },
			].map(item => ({ ...item, description: item.value || vscode.l10n.t('(any)') })),
			{ placeHolder: vscode.l10n.t('Which field to filter by?') });
		if (!pick) {
			return;
		}
		const input = (await vscode.window.showInputBox({
			title: pick.label,
			value: pick.value ?? '',
			prompt: vscode.l10n.t('Leave empty to clear this filter'),
			ignoreFocusOut: true,
		}))?.trim();
		if (input === undefined) {
			return;
		}
		switch (pick.key) {
			case 'name': this.filter.name = input || undefined; break;
			case 'userId': this.filter.userId = input || undefined; break;
			case 'tags': this.filter.tags = input ? input.split(',').map(t => t.trim()).filter(Boolean) : undefined; break;
			case 'lookbackHours': {
				const hours = Number(input);
				this.filter.lookbackHours = input && isFinite(hours) && hours > 0 ? hours : undefined;
				break;
			}
		}
		this.refresh();
	}

	clearFilter(): void {
		this.filter.name = undefined;
		this.filter.userId = undefined;
		this.filter.tags = undefined;
		this.filter.lookbackHours = undefined;
		this.refresh();
	}

	toggleAutoRefresh(): void {
		if (this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = undefined;
			void vscode.window.showInformationMessage(vscode.l10n.t('Langfuse auto-refresh off.'));
			return;
		}
		const configured = vscode.workspace.getConfiguration('langfuse').get<number>('autoRefreshSeconds', 0);
		const seconds = configured && configured > 0 ? configured : DEFAULT_AUTO_REFRESH_SECONDS;
		this.autoRefreshTimer = setInterval(() => this.refresh(), seconds * 1000);
		void vscode.window.showInformationMessage(vscode.l10n.t('Langfuse auto-refresh on (every {0}s).', seconds));
	}

	/** Starts auto-refresh on activation when the user configured a positive interval. */
	startAutoRefreshIfConfigured(): void {
		const configured = vscode.workspace.getConfiguration('langfuse').get<number>('autoRefreshSeconds', 0);
		if (configured && configured > 0 && !this.autoRefreshTimer) {
			this.autoRefreshTimer = setInterval(() => this.refresh(), configured * 1000);
		}
	}

	dispose(): void {
		if (this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
		}
		this._onDidChangeTreeData.dispose();
	}
}
