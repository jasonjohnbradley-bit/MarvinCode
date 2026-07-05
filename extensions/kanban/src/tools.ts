/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addCardLink, appendHandoff, BoardFile, Card, createCard, discoverBoards, doneColumnId, LinkType, LINK_TYPES, loadCards, moveCardInBoard, parseBoardFile, PRIORITIES, Priority, readyCards, setCardColumn, updateCardMeta, wouldCreateCycle, writeBoardFile } from './boardModel';
import { buildCoordinatorPrompt } from './campaign/coordinatorPrompt';
import { buildCardContext } from './cardContext';
import { syncBoardHeadless } from './jira/sync';

export interface ResolvedBoard {
	readonly uri: vscode.Uri;
	readonly board: BoardFile;
	readonly cards: Card[];
}

/**
 * Resolves the `board` tool argument — a board.json path as returned by
 * kanban_list_boards, or a board name when unambiguous.
 */
export async function resolveBoard(boardParam: string): Promise<ResolvedBoard> {
	const boards = await discoverBoards();
	const match = boards.find(board => board.uri.fsPath === boardParam || board.uri.toString() === boardParam)
		?? boards.find(board => board.name === boardParam);
	if (!match) {
		throw new Error(`Board not found: ${boardParam}. Use kanban_list_boards to see available boards.`);
	}
	const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(match.uri));
	return { uri: match.uri, board: parseBoardFile(text), cards: await loadCards(match.uri) };
}

export function requireCard(resolved: ResolvedBoard, cardId: string): Card {
	const card = resolved.cards.find(c => c.id === cardId);
	if (!card) {
		throw new Error(`Card not found: ${cardId}. Use kanban_list_cards to see the board's cards.`);
	}
	return card;
}

function requireColumn(resolved: ResolvedBoard, columnId: string): void {
	if (!resolved.board.columns.some(column => column.id === columnId)) {
		const available = resolved.board.columns.map(column => column.id).join(', ');
		throw new Error(`Column not found: ${columnId}. Available columns: ${available}`);
	}
}

function cardSummary(card: Card, blocked?: boolean): Record<string, unknown> {
	return {
		id: card.id,
		title: card.title,
		column: card.column,
		priority: card.priority,
		labels: card.labels,
		links: card.links.map(link => `${link.type}:${link.target}`),
		handoffs: card.handoffCount,
		...(blocked === undefined ? {} : { blocked })
	};
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value, undefined, 2))]);
}

function textResult(value: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

function tool<T>(name: string, invoke: (input: T) => Promise<vscode.LanguageModelToolResult>, invocationMessage: string): vscode.Disposable {
	// Errors are deliberately not caught: a thrown error marks the tool call
	// as failed (surfaced to the model, and recorded as ok=false in the
	// agent graph), which a swallowed error-string result would not.
	return vscode.lm.registerTool<T>(name, {
		prepareInvocation: async () => ({ invocationMessage }),
		invoke: async (options, _token) => invoke(options.input)
	});
}

/** Registers the kanban_* language-model tools the built-in agent uses to work boards. */
export function registerKanbanTools(secrets: vscode.SecretStorage): vscode.Disposable {
	return vscode.Disposable.from(
		tool<Record<string, never>>('kanban_list_boards', async () => {
			const boards = await discoverBoards();
			return jsonResult(boards.map(board => ({ name: board.name, path: board.uri.fsPath, scope: board.scope })));
		}, vscode.l10n.t('Listing Kanban boards')),

		tool<{ board: string; column?: string }>('kanban_list_cards', async input => {
			const resolved = await resolveBoard(input.board);
			if (input.column) {
				requireColumn(resolved, input.column);
			}
			const doneColumn = doneColumnId(resolved.board);
			const ready = new Set(readyCards(resolved.board, resolved.cards).map(card => card.id));
			const cards = resolved.cards
				.filter(card => !input.column || card.column === input.column)
				.map(card => ({ ...cardSummary(card, card.column !== doneColumn && !ready.has(card.id)), }));
			return jsonResult({
				columns: resolved.board.columns,
				doneColumn,
				cards
			});
		}, vscode.l10n.t('Listing Kanban cards')),

		tool<{ board: string; column: string; title: string; priority?: Priority; labels?: string[]; body?: string }>('kanban_create_card', async input => {
			const resolved = await resolveBoard(input.board);
			requireColumn(resolved, input.column);
			if (input.priority && !(PRIORITIES as readonly string[]).includes(input.priority)) {
				throw new Error(`Invalid priority: ${input.priority}. Use one of: ${PRIORITIES.join(', ')}`);
			}
			const id = await createCard(resolved.uri, input.column, input.title, {
				priority: input.priority,
				labels: input.labels,
				body: input.body
			});
			const target = resolved.board.order[input.column] ?? [];
			await writeBoardFile(resolved.uri, {
				...resolved.board,
				order: { ...resolved.board.order, [input.column]: [...target, id] }
			});
			return jsonResult({ created: id, column: input.column });
		}, vscode.l10n.t('Creating Kanban card')),

		tool<{ board: string; cardId: string; title?: string; column?: string; priority?: Priority | ''; labels?: string[] }>('kanban_update_card', async input => {
			const resolved = await resolveBoard(input.board);
			const card = requireCard(resolved, input.cardId);
			if (input.priority && !(PRIORITIES as readonly string[]).includes(input.priority)) {
				throw new Error(`Invalid priority: ${input.priority}. Use one of: ${PRIORITIES.join(', ')} (or '' to clear)`);
			}
			await updateCardMeta(card.uri, {
				title: input.title,
				priority: input.priority,
				labels: input.labels?.join(', ')
			});
			if (input.column && input.column !== card.column) {
				requireColumn(resolved, input.column);
				const moved = moveCardInBoard(resolved.board, card.id, input.column, Number.MAX_SAFE_INTEGER);
				await writeBoardFile(resolved.uri, moved);
				await setCardColumn(card.uri, input.column);
			}
			return jsonResult({ updated: card.id, column: input.column ?? card.column });
		}, vscode.l10n.t('Updating Kanban card')),

		tool<{ board: string; fromCard: string; toCard: string; type: LinkType }>('kanban_link_cards', async input => {
			const resolved = await resolveBoard(input.board);
			const from = requireCard(resolved, input.fromCard);
			requireCard(resolved, input.toCard);
			if (!(LINK_TYPES as readonly string[]).includes(input.type)) {
				throw new Error(`Invalid link type: ${input.type}. Use one of: ${LINK_TYPES.join(', ')}`);
			}
			if (input.type === 'blocking' && wouldCreateCycle(resolved.cards, input.fromCard, input.toCard)) {
				throw new Error(`Refused: making ${input.fromCard} block ${input.toCard} would create a dependency cycle.`);
			}
			await addCardLink(from.uri, input.type, input.toCard);
			return jsonResult({ linked: `${input.fromCard} ${input.type} ${input.toCard}` });
		}, vscode.l10n.t('Linking Kanban cards')),

		tool<{ board: string }>('kanban_ready_cards', async input => {
			const resolved = await resolveBoard(input.board);
			const ready = readyCards(resolved.board, resolved.cards);
			return jsonResult(ready.map(card => cardSummary(card)));
		}, vscode.l10n.t('Finding ready Kanban cards')),

		tool<{ board: string; cardId: string; author?: string; findings?: string; nextSteps?: string; blockers?: string; note?: string }>('kanban_add_handoff', async input => {
			const resolved = await resolveBoard(input.board);
			const card = requireCard(resolved, input.cardId);
			if (!input.findings && !input.nextSteps && !input.blockers && !input.note) {
				throw new Error('A handoff needs at least one of: findings, nextSteps, blockers, note.');
			}
			await appendHandoff(card.uri, {
				author: input.author ?? 'agent',
				findings: input.findings,
				nextSteps: input.nextSteps,
				blockers: input.blockers,
				note: input.note
			});
			return jsonResult({ handoffAdded: card.id });
		}, vscode.l10n.t('Adding Kanban handoff note')),

		tool<{ board: string; cardId: string }>('kanban_get_card_context', async input => {
			const resolved = await resolveBoard(input.board);
			const card = requireCard(resolved, input.cardId);
			return textResult(buildCardContext(resolved.board, resolved.cards, card));
		}, vscode.l10n.t('Reading Kanban card context')),

		tool<{ board: string; cardId: string; instructions?: string }>('kanban_start_coordinator', async input => {
			const resolved = await resolveBoard(input.board);
			const card = requireCard(resolved, input.cardId);
			return textResult(buildCoordinatorPrompt(resolved.uri, resolved.board, resolved.cards, card, 'chat-tools', input.instructions));
		}, vscode.l10n.t('Starting Kanban coordinator')),

		tool<{ board: string }>('kanban_sync_jira', async input => {
			const resolved = await resolveBoard(input.board);
			const summary = await syncBoardHeadless(secrets, resolved.uri);
			return jsonResult(summary);
		}, vscode.l10n.t('Syncing Kanban board with Jira'))
	);
}
