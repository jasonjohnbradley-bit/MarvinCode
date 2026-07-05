/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Card, createCard, doneColumnId, handoffsSection, loadCards, moveCardInBoard, parseBoardFile, setCardColumn, updateCardMeta, writeBoardFile } from '../boardModel';
import { JiraClient, mapJiraPriority } from './client';
import { clientForBoard, JiraBoardConfig } from './config';

export interface SyncRow {
	readonly kind: 'pull-create' | 'pull-update' | 'push-transition' | 'push-update' | 'push-create' | 'push-comment' | 'report';
	readonly label: string;
	readonly detail: string;
	readonly conflict: boolean;
	readonly preselected: boolean;
	readonly apply?: () => Promise<void>;
}

export interface SyncSummary {
	applied: number;
	skipped: number;
	conflicts: number;
	reports: string[];
	errors: string[];
}

function newestHandoffTs(body: string): string | undefined {
	const timestamps = [...handoffsSection(body).matchAll(/^###\s+(\S+)/gm)].map(match => match[1]);
	return timestamps.length ? timestamps.sort().pop() : undefined;
}

/** First Jira status name that maps to the given column (reverse of statusMap). */
function statusForColumn(config: JiraBoardConfig, columnId: string): string | undefined {
	for (const [statusName, mapped] of Object.entries(config.statusMap)) {
		if (mapped === columnId) {
			return statusName;
		}
	}
	return undefined;
}

/**
 * Computes the two-way change set between a board and its Jira project.
 * Direction per card is decided by timestamps against the `jiraUpdated`
 * baseline: Jira newer → pull; card newer → push; both → conflict (the
 * pull row is preselected, a mirrored push row is offered deselected).
 */
export async function computeChangeSet(client: JiraClient, config: JiraBoardConfig, boardUri: vscode.Uri): Promise<{ rows: SyncRow[]; issueCount: number }> {
	const boardText = new TextDecoder().decode(await vscode.workspace.fs.readFile(boardUri));
	const board = parseBoardFile(boardText);
	const cards = await loadCards(boardUri);
	const jql = config.jql ?? `project = "${config.projectKey}" ORDER BY updated DESC`;
	const issues = await client.searchIssues(jql);
	const issuesByKey = new Map(issues.map(issue => [issue.key, issue]));
	const cardsByKey = new Map(cards.filter(card => card.jira).map(card => [card.jira!, card]));
	const rows: SyncRow[] = [];
	const firstColumn = board.columns[0]?.id ?? 'todo';

	const moveCard = async (card: Card, toColumn: string) => {
		const freshText = new TextDecoder().decode(await vscode.workspace.fs.readFile(boardUri));
		await writeBoardFile(boardUri, moveCardInBoard(parseBoardFile(freshText), card.id, toColumn, Number.MAX_SAFE_INTEGER));
		await setCardColumn(card.uri, toColumn);
	};

	const stampFromJira = async (card: Card, key: string) => {
		const fresh = await client.getIssue(key);
		await updateCardMeta(card.uri, { jiraUpdated: fresh?.updated ?? new Date().toISOString() });
	};

	// ---- Pull side: issues driving cards
	for (const issue of issues) {
		const card = cardsByKey.get(issue.key);
		const mappedColumn = config.statusMap[issue.statusName] ?? firstColumn;
		if (!card) {
			rows.push({
				kind: 'pull-create',
				label: `[pull] Create card from ${issue.key}`,
				detail: `${issue.summary} → ${mappedColumn}`,
				conflict: false,
				preselected: true,
				apply: async () => {
					const body = [issue.description, '', `Jira: ${client.issueUrl(issue.key)}`].join('\n').trim() + '\n';
					const id = await createCard(boardUri, mappedColumn, issue.summary, { priority: mapJiraPriority(issue.priorityName), body });
					const created = (await loadCards(boardUri)).find(c => c.id === id);
					if (created) {
						await updateCardMeta(created.uri, { jira: issue.key, jiraUpdated: issue.updated });
					}
					const freshText = new TextDecoder().decode(await vscode.workspace.fs.readFile(boardUri));
					const freshBoard = parseBoardFile(freshText);
					await writeBoardFile(boardUri, { ...freshBoard, order: { ...freshBoard.order, [mappedColumn]: [...(freshBoard.order[mappedColumn] ?? []), id] } });
				}
			});
			continue;
		}

		const jiraChanged = !card.jiraUpdated || issue.updated > card.jiraUpdated;
		const localChanged = !!card.updated && !!card.jiraUpdated && card.updated > card.jiraUpdated;
		const titleDiffers = card.title !== issue.summary;
		const columnDiffers = card.column !== mappedColumn;
		if (!titleDiffers && !columnDiffers) {
			if (jiraChanged) {
				// Only invisible fields moved (e.g. priority/description) — quietly refresh the baseline and priority
				rows.push({
					kind: 'pull-update',
					label: `[pull] Refresh ${issue.key} baseline`,
					detail: card.title,
					conflict: false,
					preselected: true,
					apply: async () => {
						await updateCardMeta(card.uri, { priority: mapJiraPriority(issue.priorityName) ?? '', jiraUpdated: issue.updated });
					}
				});
			}
			continue;
		}

		if (card.agentStatus === 'running') {
			rows.push({ kind: 'report', label: `[skipped] ${issue.key}`, detail: vscode.l10n.t('An agent is working on "{0}" — excluded from sync.', card.title), conflict: false, preselected: false });
			continue;
		}

		const conflict = jiraChanged && localChanged;
		if (jiraChanged) {
			rows.push({
				kind: 'pull-update',
				label: `${conflict ? 'CONFLICT: apply Jira to' : '[pull] Update card from'} ${issue.key}`,
				detail: [titleDiffers ? `title → "${issue.summary}"` : undefined, columnDiffers ? `column → ${mappedColumn}` : undefined].filter(Boolean).join(', '),
				conflict,
				preselected: true,
				apply: async () => {
					await updateCardMeta(card.uri, {
						title: titleDiffers ? issue.summary : undefined,
						priority: mapJiraPriority(issue.priorityName) ?? '',
						jiraUpdated: issue.updated
					});
					if (columnDiffers) {
						await moveCard(card, mappedColumn);
						await updateCardMeta(card.uri, { jiraUpdated: issue.updated });
					}
				}
			});
		}
		if (localChanged) {
			// Mirrored push rows (deselected when conflicting — selecting them pushes local state outward)
			if (columnDiffers) {
				const targetStatus = statusForColumn(config, card.column);
				rows.push({
					kind: 'push-transition',
					label: `[push] Transition ${issue.key} to ${targetStatus ?? '?'}`,
					detail: vscode.l10n.t('Card "{0}" is in {1}', card.title, card.column),
					conflict,
					preselected: !conflict,
					apply: async () => {
						if (!targetStatus) {
							throw new Error(`No Jira status is mapped to column "${card.column}" — extend the statusMap in jira.json.`);
						}
						const transitions = await client.getTransitions(issue.key);
						const match = transitions.find(t => t.toStatusName === targetStatus);
						if (!match) {
							throw new Error(`${issue.key}: no workflow transition to "${targetStatus}" from "${issue.statusName}".`);
						}
						await client.transitionIssue(issue.key, match.id);
						await stampFromJira(card, issue.key);
					}
				});
			}
			if (titleDiffers) {
				rows.push({
					kind: 'push-update',
					label: `[push] Retitle ${issue.key}`,
					detail: `"${issue.summary}" → "${card.title}"`,
					conflict,
					preselected: !conflict,
					apply: async () => {
						await client.updateIssue(issue.key, { summary: card.title });
						await stampFromJira(card, issue.key);
					}
				});
			}
		}
	}

	// ---- Deleted-in-Jira detection (report only, never auto-delete)
	for (const [key, card] of cardsByKey) {
		if (!issuesByKey.has(key)) {
			const exists = await client.getIssue(key);
			if (!exists) {
				rows.push({ kind: 'report', label: `[deleted] ${key} deleted in Jira`, detail: vscode.l10n.t('Card "{0}" kept locally.', card.title), conflict: false, preselected: false });
			}
		}
	}

	// ---- Local-only cards → optional issue creation (deselected by default)
	const done = doneColumnId(board);
	for (const card of cards) {
		if (!card.jira && card.column !== done) {
			rows.push({
				kind: 'push-create',
				label: `[push] Create Jira issue for "${card.title}"`,
				detail: vscode.l10n.t('New {0} in {1}', config.issueType, config.projectKey),
				conflict: false,
				preselected: false,
				apply: async () => {
					const created = await client.createIssue(config.projectKey, config.issueType, card.title, card.body.trim());
					await updateCardMeta(card.uri, { jira: created.key });
					await stampFromJira(card, created.key);
				}
			});
		}
	}

	// ---- Handoff comments (per-board opt-in)
	if (config.pushHandoffs) {
		for (const card of cards) {
			if (!card.jira) {
				continue;
			}
			const newest = newestHandoffTs(card.body);
			if (newest && (!card.jiraUpdated || newest > card.jiraUpdated)) {
				const section = handoffsSection(card.body).trim();
				const lastEntry = section.split(/^###\s/m).filter(entry => entry.trim()).pop();
				if (lastEntry) {
					const key = card.jira;
					rows.push({
						kind: 'push-comment',
						label: `[push] Comment on ${key}`,
						detail: vscode.l10n.t('Latest handoff from "{0}"', card.title),
						conflict: false,
						preselected: true,
						apply: async () => {
							await client.addComment(key, `Handoff from MarvinCode board:\n\n${lastEntry.trim()}`);
							await stampFromJira(card, key);
						}
					});
				}
			}
		}
	}

	return { rows, issueCount: issues.length };
}

export async function applyRows(rows: readonly SyncRow[], selected: ReadonlySet<SyncRow>): Promise<SyncSummary> {
	const summary: SyncSummary = { applied: 0, skipped: 0, conflicts: 0, reports: [], errors: [] };
	for (const row of rows) {
		if (row.kind === 'report') {
			summary.reports.push(`${row.label}: ${row.detail}`);
			continue;
		}
		if (row.conflict) {
			summary.conflicts++;
		}
		if (!selected.has(row) || !row.apply) {
			summary.skipped++;
			continue;
		}
		try {
			await row.apply();
			summary.applied++;
		} catch (error) {
			summary.errors.push(`${row.label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return summary;
}

function summaryMessage(summary: SyncSummary, issueCount: number): string {
	const parts = [
		vscode.l10n.t('{0} change(s) applied', summary.applied),
		summary.skipped ? vscode.l10n.t('{0} skipped', summary.skipped) : undefined,
		summary.errors.length ? vscode.l10n.t('{0} error(s)', summary.errors.length) : undefined,
		vscode.l10n.t('{0} issues scanned', issueCount)
	].filter(Boolean);
	return `Jira sync: ${parts.join(', ')}.`;
}

/** Interactive sync: preview-then-commit with per-row selection. */
export async function syncBoardInteractive(secrets: vscode.SecretStorage, boardUri: vscode.Uri, output: vscode.OutputChannel): Promise<void> {
	const { client, config } = await clientForBoard(secrets, boardUri);
	const { rows, issueCount } = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Computing Jira change set…') },
		() => computeChangeSet(client, config, boardUri));

	if (!rows.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Board and Jira are in sync ({0} issues scanned).', issueCount));
		return;
	}
	type RowItem = vscode.QuickPickItem & { row: SyncRow };
	const items: RowItem[] = rows.filter(row => row.kind !== 'report').map(row => ({
		label: row.label,
		description: row.conflict ? vscode.l10n.t('conflict') : undefined,
		detail: row.detail,
		picked: row.preselected,
		row
	}));
	const reports = rows.filter(row => row.kind === 'report');
	const picked = items.length ? await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: vscode.l10n.t('Jira sync preview — deselect anything you do not want applied ({0} report-only items below)', String(reports.length)),
		ignoreFocusOut: true
	}) : [];
	if (!picked) {
		return;
	}
	const summary = await applyRows(rows, new Set(picked.map(item => item.row)));
	output.appendLine(`\n=== Jira sync ${new Date().toISOString()} ===`);
	for (const line of [...summary.reports, ...summary.errors]) {
		output.appendLine(line);
	}
	const message = summaryMessage(summary, issueCount);
	if (summary.errors.length) {
		const show = vscode.l10n.t('Show Log');
		void vscode.window.showWarningMessage(message, show).then(answer => answer === show ? output.show() : undefined);
	} else {
		void vscode.window.showInformationMessage(message);
	}
}

/** Headless sync (LM tool / polling): applies non-conflict rows only. */
export async function syncBoardHeadless(secrets: vscode.SecretStorage, boardUri: vscode.Uri): Promise<SyncSummary & { issueCount: number }> {
	const { client, config } = await clientForBoard(secrets, boardUri);
	const { rows, issueCount } = await computeChangeSet(client, config, boardUri);
	const selected = new Set(rows.filter(row => row.preselected && !row.conflict && row.kind !== 'push-create'));
	const summary = await applyRows(rows, selected);
	for (const row of rows.filter(r => r.conflict)) {
		summary.reports.push(`CONFLICT skipped: ${row.label} — ${row.detail}`);
	}
	return { ...summary, issueCount };
}
