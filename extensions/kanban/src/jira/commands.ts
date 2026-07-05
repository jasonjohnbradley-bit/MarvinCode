/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { discoverBoards, loadCards, parseBoardFile, updateCardMeta } from '../boardModel';
import { clientForBoard, connectToJira, linkBoardToJira, readJiraConfig } from './config';
import { syncBoardHeadless, syncBoardInteractive } from './sync';

async function pickBoard(placeholder: string, linkedOnly: boolean): Promise<vscode.Uri | undefined> {
	const boards = await discoverBoards();
	const candidates = [];
	for (const board of boards) {
		const linked = await readJiraConfig(board.uri) !== undefined;
		if (!linkedOnly || linked) {
			candidates.push({ label: board.name, description: linked ? vscode.l10n.t('linked') : board.scope, uri: board.uri });
		}
	}
	if (!candidates.length) {
		void vscode.window.showWarningMessage(linkedOnly
			? vscode.l10n.t('No Jira-linked boards found — run "Kanban: Link Board to Jira" first.')
			: vscode.l10n.t('No Kanban boards found.'));
		return undefined;
	}
	if (candidates.length === 1) {
		return candidates[0].uri;
	}
	const picked = await vscode.window.showQuickPick(candidates, { placeHolder: placeholder });
	return picked?.uri;
}

/** Registers the Jira commands and the optional background polling loop. */
export function registerJiraCommands(context: vscode.ExtensionContext): vscode.Disposable {
	const secrets = context.secrets;
	const output = vscode.window.createOutputChannel(vscode.l10n.t('Kanban Jira'));
	const disposables: vscode.Disposable[] = [output];

	disposables.push(vscode.commands.registerCommand('kanban.jira.connect', () => connectToJira(secrets)));

	disposables.push(vscode.commands.registerCommand('kanban.jira.linkBoard', async () => {
		const boardUri = await pickBoard(vscode.l10n.t('Link which board to Jira?'), false);
		if (!boardUri) {
			return;
		}
		const board = parseBoardFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(boardUri)));
		try {
			await linkBoardToJira(secrets, boardUri, board);
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Linking failed: {0}', error instanceof Error ? error.message : String(error)));
		}
	}));

	const isBoardUri = (value: unknown): value is vscode.Uri => value instanceof vscode.Uri && value.fsPath.endsWith('board.json');

	disposables.push(vscode.commands.registerCommand('kanban.jira.sync', async (boardArg?: vscode.Uri) => {
		const boardUri = isBoardUri(boardArg) && await readJiraConfig(boardArg)
			? boardArg
			: await pickBoard(vscode.l10n.t('Sync which board with Jira?'), true);
		if (!boardUri) {
			return;
		}
		try {
			await syncBoardInteractive(secrets, boardUri, output);
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Jira sync failed: {0}', error instanceof Error ? error.message : String(error)));
		}
	}));

	disposables.push(vscode.commands.registerCommand('kanban.jira.pushCard', async (boardArg?: vscode.Uri, cardId?: string) => {
		const boardUri = isBoardUri(boardArg) ? boardArg : await pickBoard(vscode.l10n.t('Push a card from which board?'), true);
		if (!boardUri) {
			return;
		}
		const cards = (await loadCards(boardUri)).filter(card => !card.jira);
		if (!cards.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Every card on this board is already linked to Jira.'));
			return;
		}
		let card = typeof cardId === 'string' ? cards.find(c => c.id === cardId) : undefined;
		if (!card) {
			const picked = await vscode.window.showQuickPick(
				cards.map(c => ({ label: c.title, description: c.column, card: c })),
				{ placeHolder: vscode.l10n.t('Create a Jira issue for which card?') });
			if (!picked) {
				return;
			}
			card = picked.card;
		}
		try {
			const { client, config } = await clientForBoard(secrets, boardUri);
			const created = await client.createIssue(config.projectKey, config.issueType, card.title, card.body.trim());
			const fresh = await client.getIssue(created.key);
			await updateCardMeta(card.uri, { jira: created.key, jiraUpdated: fresh?.updated ?? new Date().toISOString() });
			void vscode.window.showInformationMessage(vscode.l10n.t('Created {0} for "{1}".', created.key, card.title));
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Push failed: {0}', error instanceof Error ? error.message : String(error)));
		}
	}));

	// Optional polling: headless non-conflict sync for every linked board
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	const reschedulePolling = () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		const minutes = vscode.workspace.getConfiguration('kanban').get<number>('jira.pollMinutes', 0);
		if (minutes > 0) {
			pollTimer = setInterval(async () => {
				for (const board of await discoverBoards()) {
					if (await readJiraConfig(board.uri)) {
						try {
							const summary = await syncBoardHeadless(secrets, board.uri);
							if (summary.applied || summary.errors.length) {
								output.appendLine(`[poll ${new Date().toISOString()}] ${board.name}: ${summary.applied} applied, ${summary.errors.length} errors`);
							}
						} catch (error) {
							output.appendLine(`[poll] ${board.name} failed: ${error}`);
						}
					}
				}
			}, minutes * 60_000);
		}
	};
	reschedulePolling();
	disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('kanban.jira.pollMinutes')) {
			reschedulePolling();
		}
	}));
	disposables.push(new vscode.Disposable(() => pollTimer && clearInterval(pollTimer)));

	return vscode.Disposable.from(...disposables);
}
