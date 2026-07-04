/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface BoardColumn {
	readonly id: string;
	readonly title: string;
}

export interface BoardFile {
	readonly name: string;
	readonly columns: readonly BoardColumn[];
	readonly order: Record<string, readonly string[]>;
}

export interface Card {
	readonly id: string;
	readonly title: string;
	readonly column: string;
	readonly labels: readonly string[];
	readonly sessions: readonly string[];
	readonly body: string;
	readonly fileName: string;
	readonly uri: vscode.Uri;
}

export interface BoardState {
	readonly name: string;
	readonly columns: readonly { id: string; title: string; cards: Card[] }[];
}

/**
 * Parses the YAML-ish front-matter block of a card file. Only flat
 * `key: value` pairs are supported; `labels` is a comma-separated list.
 */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
	const meta: Record<string, string> = {};
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) {
		return { meta, body: text };
	}
	for (const line of match[1].split(/\r?\n/)) {
		const sep = line.indexOf(':');
		if (sep > 0) {
			meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
		}
	}
	return { meta, body: text.slice(match[0].length) };
}

export function serializeFrontMatter(meta: Record<string, string>, body: string): string {
	const lines = Object.entries(meta).map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Generates a sortable, collision-resistant card id. */
export function newCardId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function parseBoardFile(text: string): BoardFile {
	const raw = JSON.parse(text);
	const columns: BoardColumn[] = Array.isArray(raw.columns)
		? raw.columns.filter((c: unknown): c is BoardColumn => !!c && typeof (c as BoardColumn).id === 'string')
		: [];
	return {
		name: typeof raw.name === 'string' ? raw.name : 'Board',
		columns,
		order: raw.order && typeof raw.order === 'object' ? raw.order : {}
	};
}

export async function loadCards(boardUri: vscode.Uri): Promise<Card[]> {
	const cardsDir = vscode.Uri.joinPath(boardUri, '..', 'cards');
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(cardsDir);
	} catch {
		return [];
	}
	const cards: Card[] = [];
	for (const [fileName, type] of entries) {
		if (type !== vscode.FileType.File || !fileName.endsWith('.md')) {
			continue;
		}
		const uri = vscode.Uri.joinPath(cardsDir, fileName);
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const { meta, body } = parseFrontMatter(new TextDecoder().decode(bytes));
			cards.push({
				id: meta['id'] ?? fileName.replace(/\.md$/, ''),
				title: meta['title'] ?? fileName,
				column: meta['column'] ?? '',
				labels: meta['labels'] ? meta['labels'].split(',').map(label => label.trim()).filter(label => label.length > 0) : [],
				sessions: meta['sessions'] ? meta['sessions'].split(',').map(id => id.trim()).filter(id => id.length > 0) : [],
				body,
				fileName,
				uri
			});
		} catch {
			// Unreadable card files are skipped rather than failing the whole board
		}
	}
	return cards;
}

/**
 * Combines board.json content with the card files into the state the
 * webview renders. Cards are grouped by column and sorted by the
 * board's order list; cards not listed there go last, by id.
 */
export async function loadBoardState(boardUri: vscode.Uri, boardText: string): Promise<BoardState> {
	const board = parseBoardFile(boardText);
	const cards = await loadCards(boardUri);
	const columns = board.columns.map(column => {
		const orderList = board.order[column.id] ?? [];
		const columnCards = cards
			.filter(card => card.column === column.id)
			.sort((a, b) => {
				const ai = orderList.indexOf(a.id);
				const bi = orderList.indexOf(b.id);
				if (ai !== -1 && bi !== -1) {
					return ai - bi;
				}
				if (ai !== bi) {
					return ai === -1 ? 1 : -1;
				}
				return a.id < b.id ? -1 : 1;
			});
		return { id: column.id, title: column.title, cards: columnCards };
	});
	return { name: board.name, columns };
}

/**
 * Returns a new board file with the card moved to the given column and
 * position. The card is removed from every order list first, so a card
 * that was never listed still ends up exactly once.
 */
export function moveCardInBoard(board: BoardFile, cardId: string, toColumn: string, toIndex: number): BoardFile {
	const order: Record<string, string[]> = {};
	for (const column of board.columns) {
		order[column.id] = (board.order[column.id] ?? []).filter(id => id !== cardId);
	}
	const target = order[toColumn] ?? (order[toColumn] = []);
	target.splice(Math.max(0, Math.min(toIndex, target.length)), 0, cardId);
	return { name: board.name, columns: board.columns, order };
}

export function addColumnToBoard(board: BoardFile, title: string): BoardFile {
	const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `column${board.columns.length + 1}`;
	if (board.columns.some(column => column.id === id)) {
		return board;
	}
	return {
		name: board.name,
		columns: [...board.columns, { id, title }],
		order: { ...board.order, [id]: [] }
	};
}

export function serializeBoardFile(board: BoardFile): string {
	return JSON.stringify(board, null, '\t') + '\n';
}

/** Rewrites a card file's front-matter to place it in the given column. */
export async function setCardColumn(cardUri: vscode.Uri, column: string): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(cardUri);
	const { meta, body } = parseFrontMatter(new TextDecoder().decode(bytes));
	meta['column'] = column;
	meta['updated'] = new Date().toISOString();
	await vscode.workspace.fs.writeFile(cardUri, new TextEncoder().encode(serializeFrontMatter(meta, body)));
}

/** Creates a new card file and returns its id. */
export async function createCard(boardUri: vscode.Uri, column: string, title: string): Promise<string> {
	const id = newCardId();
	const content = serializeFrontMatter({
		id,
		title,
		column,
		labels: '',
		created: new Date().toISOString()
	}, '\n');
	await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(boardUri, '..', 'cards', `${id}.md`), new TextEncoder().encode(content));
	return id;
}

/** Resolves the configured global boards folder, expanding a leading `~`. */
export function globalBoardsRoot(): vscode.Uri {
	const configured = vscode.workspace.getConfiguration('kanban').get<string>('globalBoardsFolder', '~/kanban');
	const expanded = configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
	return vscode.Uri.file(expanded);
}

async function writeStarterBoard(boardDir: vscode.Uri, name: string): Promise<vscode.Uri> {
	const boardUri = vscode.Uri.joinPath(boardDir, 'board.json');
	try {
		await vscode.workspace.fs.stat(boardUri);
	} catch {
		const cardId = newCardId();
		const board: BoardFile = {
			name,
			columns: [
				{ id: 'todo', title: 'To Do' },
				{ id: 'doing', title: 'Doing' },
				{ id: 'done', title: 'Done' }
			],
			order: { todo: [cardId], doing: [], done: [] }
		};
		const card = serializeFrontMatter({
			id: cardId,
			title: 'Welcome to your board',
			column: 'todo',
			labels: '',
			created: new Date().toISOString()
		}, '\nEdit this card, or add new ones. Every card is a markdown file under `.kanban/cards/`.\n');
		await vscode.workspace.fs.writeFile(boardUri, new TextEncoder().encode(serializeBoardFile(board)));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(boardDir, 'cards', `${cardId}.md`), new TextEncoder().encode(card));
	}
	return boardUri;
}

/**
 * Creates a new board and opens it. Global boards live under the
 * configured boards folder and are reachable from every window; workspace
 * boards live in `.kanban/` at the workspace root.
 */
export async function scaffoldBoard(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const globalLabel = vscode.l10n.t('Global Board');
	type LocationPick = vscode.QuickPickItem & { global: boolean };
	let useGlobal = true;
	if (folder) {
		const picks: LocationPick[] = [
			{ label: globalLabel, description: vscode.l10n.t('Available in every window'), global: true },
			{ label: vscode.l10n.t('Workspace Board'), description: vscode.l10n.t('Stored in {0}', folder.name), global: false }
		];
		const picked = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t('Where should the board live?') });
		if (!picked) {
			return;
		}
		useGlobal = picked.global;
	}

	let boardUri: vscode.Uri;
	if (useGlobal) {
		const name = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Board name'),
			validateInput: value => value.trim().length === 0 ? vscode.l10n.t('Enter a board name') : undefined
		});
		if (!name) {
			return;
		}
		const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
		boardUri = await writeStarterBoard(vscode.Uri.joinPath(globalBoardsRoot(), slug, '.kanban'), name.trim());
	} else {
		boardUri = await writeStarterBoard(vscode.Uri.joinPath(folder!.uri, '.kanban'), folder!.name);
	}
	await vscode.commands.executeCommand('vscode.openWith', boardUri, 'kanban.board');
	await vscode.commands.executeCommand('kanban.refreshBoards');
}
