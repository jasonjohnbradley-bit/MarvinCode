/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Card, discoverBoards, loadCards, parseBoardFile } from '../boardModel';
import { AgentRun, AgentRunner } from './agentRunner';
import { startCampaign } from './campaign';
import { buildCoordinatorPrompt } from './coordinatorPrompt';

interface PickedCard {
	readonly boardUri: vscode.Uri;
	readonly board: ReturnType<typeof parseBoardFile>;
	readonly cards: Card[];
	readonly card: Card;
}

async function pickBoardCard(placeholder: string): Promise<PickedCard | undefined> {
	const boards = await discoverBoards();
	if (!boards.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t('No Kanban boards found.'));
		return undefined;
	}
	let boardRef = boards[0];
	if (boards.length > 1) {
		const picked = await vscode.window.showQuickPick(
			boards.map(board => ({ label: board.name, description: board.scope, board })),
			{ placeHolder: vscode.l10n.t('Which board?') });
		if (!picked) {
			return undefined;
		}
		boardRef = picked.board;
	}
	const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(boardRef.uri));
	const board = parseBoardFile(text);
	const cards = await loadCards(boardRef.uri);
	if (!cards.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Board "{0}" has no cards.', boardRef.name));
		return undefined;
	}
	const pickedCard = await vscode.window.showQuickPick(
		cards.map(card => ({ label: card.title, description: `${card.column}${card.priority ? ` · ${card.priority}` : ''}`, detail: card.id, card })),
		{ placeHolder: placeholder });
	if (!pickedCard) {
		return undefined;
	}
	return { boardUri: boardRef.uri, board, cards, card: pickedCard.card };
}

/** Registers the campaign-tier commands. */
export function registerCampaignCommands(runner: AgentRunner): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand('kanban.runAgentOnCard', async () => {
			const picked = await pickBoardCard(vscode.l10n.t('Run an agent on which card?'));
			if (!picked) {
				return;
			}
			void runner.runOnCard(picked.boardUri, picked.board, picked.cards, picked.card).then(run => {
				if (run.state === 'failed') {
					void vscode.window.showWarningMessage(vscode.l10n.t('Agent on "{0}" failed (exit {1}) — see the card\'s handoff note.', run.card.title, String(run.exitCode)));
				}
			});
			void vscode.window.showInformationMessage(vscode.l10n.t('Agent queued for "{0}" — watch the Agents view.', picked.card.title));
		}),

		vscode.commands.registerCommand('kanban.decomposeCard', async () => {
			const picked = await pickBoardCard(vscode.l10n.t('Decompose which card into a campaign?'));
			if (!picked) {
				return;
			}
			const instructions = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Optional extra instructions for the coordinator (Enter to skip)')
			});
			if (instructions === undefined) {
				return;
			}
			const prompt = buildCoordinatorPrompt(picked.boardUri, picked.board, picked.cards, picked.card, 'file-ops', instructions || undefined);
			void vscode.window.showInformationMessage(vscode.l10n.t('Coordinator (DM) queued for "{0}" — watch the Agents view.', picked.card.title));
			void runner.runCoordinator(picked.boardUri, picked.card, prompt).then(async run => {
				if (run.state !== 'done') {
					void vscode.window.showWarningMessage(vscode.l10n.t('Coordinator run on "{0}" did not finish cleanly (exit {1}).', run.card.title, String(run.exitCode)));
					return;
				}
				const start = vscode.l10n.t('Start Campaign');
				const answer = await vscode.window.showInformationMessage(
					vscode.l10n.t('Coordinator finished decomposing "{0}". Start the campaign?', run.card.title), start);
				if (answer === start) {
					startCampaign(runner, picked.boardUri, picked.card);
				}
			});
		}),

		vscode.commands.registerCommand('kanban.runCampaign', async () => {
			const picked = await pickBoardCard(vscode.l10n.t('Run a campaign for which parent card?'));
			if (!picked) {
				return;
			}
			startCampaign(runner, picked.boardUri, picked.card);
		}),

		vscode.commands.registerCommand('kanban.killAgent', (run?: AgentRun) => {
			if (run?.id) {
				runner.kill(run.id);
			}
		})
	);
}
