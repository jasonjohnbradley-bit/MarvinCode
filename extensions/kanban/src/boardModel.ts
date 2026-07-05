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

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type Priority = typeof PRIORITIES[number];

export const LINK_TYPES = ['blocking', 'related', 'parent'] as const;
export type LinkType = typeof LINK_TYPES[number];

/** A typed edge to another card. `blocking:x` on this card means "this card blocks x". */
export interface CardLink {
	readonly type: LinkType;
	readonly target: string;
}

export const AGENT_STATUSES = ['running', 'failed'] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

export interface Card {
	readonly id: string;
	readonly title: string;
	readonly column: string;
	readonly priority: Priority | undefined;
	readonly labels: readonly string[];
	readonly links: readonly CardLink[];
	readonly sessions: readonly string[];
	readonly handoffCount: number;
	readonly agentStatus: AgentStatus | undefined;
	readonly jira: string | undefined;
	readonly jiraUpdated: string | undefined;
	readonly updated: string | undefined;
	readonly body: string;
	readonly fileName: string;
	readonly uri: vscode.Uri;
}

/** A card as rendered on the board, with cross-card state resolved. */
export interface BoardCard extends Card {
	readonly blocked: boolean;
}

export interface BoardState {
	readonly name: string;
	readonly columns: readonly { id: string; title: string; cards: BoardCard[] }[];
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

export function parseLinks(value: string | undefined): CardLink[] {
	if (!value) {
		return [];
	}
	const links: CardLink[] = [];
	for (const part of value.split(',')) {
		const sep = part.indexOf(':');
		if (sep > 0) {
			const type = part.slice(0, sep).trim();
			const target = part.slice(sep + 1).trim();
			if ((LINK_TYPES as readonly string[]).includes(type) && target.length > 0) {
				links.push({ type: type as LinkType, target });
			}
		}
	}
	return links;
}

export function serializeLinks(links: readonly CardLink[]): string {
	return links.map(link => `${link.type}:${link.target}`).join(', ');
}

const HANDOFFS_HEADING = /^##\s+Handoffs\s*$/m;

/** The body text of the `## Handoffs` section, or '' when the card has none. */
export function handoffsSection(body: string): string {
	const match = HANDOFFS_HEADING.exec(body);
	if (!match) {
		return '';
	}
	const rest = body.slice(match.index + match[0].length);
	const next = rest.search(/^##\s/m);
	return next === -1 ? rest : rest.slice(0, next);
}

export function countHandoffs(body: string): number {
	return (handoffsSection(body).match(/^###\s/gm) ?? []).length;
}

/**
 * True when making `fromId` block `toId` would create a cycle in the
 * blocking graph, i.e. `fromId` is already reachable from `toId`.
 */
export function wouldCreateCycle(cards: readonly Card[], fromId: string, toId: string): boolean {
	if (fromId === toId) {
		return true;
	}
	const byId = new Map(cards.map(card => [card.id, card]));
	const queue = [toId];
	const seen = new Set<string>();
	while (queue.length) {
		const id = queue.pop()!;
		if (id === fromId) {
			return true;
		}
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		for (const link of byId.get(id)?.links ?? []) {
			if (link.type === 'blocking') {
				queue.push(link.target);
			}
		}
	}
	return false;
}

/** Ids of cards blocked by a `blocking` link from a card that is not yet done. */
export function blockedCardIds(doneColumn: string | undefined, cards: readonly Card[]): Set<string> {
	const blocked = new Set<string>();
	for (const card of cards) {
		if (doneColumn !== undefined && card.column === doneColumn) {
			continue;
		}
		for (const link of card.links) {
			if (link.type === 'blocking') {
				blocked.add(link.target);
			}
		}
	}
	return blocked;
}

/** The board's done column: by convention, the last column. */
export function doneColumnId(board: BoardFile): string | undefined {
	return board.columns.length ? board.columns[board.columns.length - 1].id : undefined;
}

/**
 * Cards that are actionable now: not in the done column and not blocked
 * by any not-yet-done card. This is the readiness primitive agent
 * orchestration builds on.
 */
export function readyCards(board: BoardFile, cards: readonly Card[]): Card[] {
	const doneColumn = doneColumnId(board);
	const blocked = blockedCardIds(doneColumn, cards);
	return cards.filter(card => card.column !== doneColumn && !blocked.has(card.id));
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
				priority: (PRIORITIES as readonly string[]).includes(meta['priority']) ? meta['priority'] as Priority : undefined,
				labels: meta['labels'] ? meta['labels'].split(',').map(label => label.trim()).filter(label => label.length > 0) : [],
				links: parseLinks(meta['links']),
				sessions: meta['sessions'] ? meta['sessions'].split(',').map(id => id.trim()).filter(id => id.length > 0) : [],
				handoffCount: countHandoffs(body),
				agentStatus: (AGENT_STATUSES as readonly string[]).includes(meta['agentStatus']) ? meta['agentStatus'] as AgentStatus : undefined,
				jira: meta['jira'] || undefined,
				jiraUpdated: meta['jiraUpdated'] || undefined,
				updated: meta['updated'] || undefined,
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
	const blocked = blockedCardIds(doneColumnId(board), cards);
	const columns = board.columns.map(column => {
		const orderList = board.order[column.id] ?? [];
		const columnCards = cards
			.filter(card => card.column === column.id)
			.map((card): BoardCard => ({ ...card, blocked: blocked.has(card.id) }))
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

export async function writeBoardFile(boardUri: vscode.Uri, board: BoardFile): Promise<void> {
	await vscode.workspace.fs.writeFile(boardUri, new TextEncoder().encode(serializeBoardFile(board)));
}

/** Appends a session id to a card's `sessions:` front-matter (deduplicated). */
export async function appendCardSession(cardUri: vscode.Uri, sessionId: string): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(cardUri);
	const { meta, body } = parseFrontMatter(new TextDecoder().decode(bytes));
	const sessions = meta['sessions'] ? meta['sessions'].split(',').map(id => id.trim()).filter(id => id.length > 0) : [];
	if (sessions.includes(sessionId)) {
		return;
	}
	sessions.push(sessionId);
	meta['sessions'] = sessions.join(', ');
	await vscode.workspace.fs.writeFile(cardUri, new TextEncoder().encode(serializeFrontMatter(meta, body)));
}

/** Rewrites a card file's front-matter to place it in the given column. */
export async function setCardColumn(cardUri: vscode.Uri, column: string): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(cardUri);
	const { meta, body } = parseFrontMatter(new TextDecoder().decode(bytes));
	meta['column'] = column;
	meta['updated'] = new Date().toISOString();
	await vscode.workspace.fs.writeFile(cardUri, new TextEncoder().encode(serializeFrontMatter(meta, body)));
}

export interface CreateCardOptions {
	readonly priority?: Priority;
	readonly labels?: readonly string[];
	readonly body?: string;
}

/** Creates a new card file and returns its id. */
export async function createCard(boardUri: vscode.Uri, column: string, title: string, options?: CreateCardOptions): Promise<string> {
	const id = newCardId();
	const meta: Record<string, string> = {
		id,
		title,
		column,
		labels: options?.labels?.join(', ') ?? '',
		created: new Date().toISOString()
	};
	if (options?.priority) {
		meta['priority'] = options.priority;
	}
	const body = options?.body ? '\n' + options.body.replace(/\s*$/, '\n') : '\n';
	const content = serializeFrontMatter(meta, body);
	await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(boardUri, '..', 'cards', `${id}.md`), new TextEncoder().encode(content));
	return id;
}

/**
 * Applies a partial front-matter update to a card file. Undefined values
 * are left unchanged; empty strings delete the key.
 */
export async function updateCardMeta(cardUri: vscode.Uri, patch: Record<string, string | undefined>): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(cardUri);
	const { meta, body } = parseFrontMatter(new TextDecoder().decode(bytes));
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) {
			continue;
		}
		if (value === '') {
			delete meta[key];
		} else {
			meta[key] = value;
		}
	}
	meta['updated'] = new Date().toISOString();
	await vscode.workspace.fs.writeFile(cardUri, new TextEncoder().encode(serializeFrontMatter(meta, body)));
}

/** Adds a typed link to a card's front-matter (deduplicated). */
export async function addCardLink(cardUri: vscode.Uri, type: LinkType, target: string): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(cardUri);
	const { meta, body } = parseFrontMatter(new TextDecoder().decode(bytes));
	const links = parseLinks(meta['links']);
	if (!links.some(link => link.type === type && link.target === target)) {
		links.push({ type, target });
	}
	meta['links'] = serializeLinks(links);
	meta['updated'] = new Date().toISOString();
	await vscode.workspace.fs.writeFile(cardUri, new TextEncoder().encode(serializeFrontMatter(meta, body)));
}

export interface HandoffEntry {
	readonly author: string;
	readonly findings?: string;
	readonly nextSteps?: string;
	readonly blockers?: string;
	readonly note?: string;
}

/**
 * Appends an entry to the card's `## Handoffs` section, creating the
 * section on first use. Entries land at the end of the section so a card
 * whose Handoffs section is followed by other sections stays intact.
 */
export async function appendHandoff(cardUri: vscode.Uri, entry: HandoffEntry): Promise<void> {
	const bytes = await vscode.workspace.fs.readFile(cardUri);
	const { meta, body } = parseFrontMatter(new TextDecoder().decode(bytes));
	const lines = [`### ${new Date().toISOString()} — ${entry.author}`];
	if (entry.findings) {
		lines.push(`- Findings: ${entry.findings}`);
	}
	if (entry.nextSteps) {
		lines.push(`- Next steps: ${entry.nextSteps}`);
	}
	if (entry.blockers) {
		lines.push(`- Blockers: ${entry.blockers}`);
	}
	if (entry.note) {
		lines.push('', entry.note.trim());
	}
	const block = lines.join('\n') + '\n';

	const match = HANDOFFS_HEADING.exec(body);
	let newBody: string;
	if (!match) {
		newBody = body.replace(/\s*$/, '\n') + '\n## Handoffs\n\n' + block;
	} else {
		const sectionStart = match.index + match[0].length;
		const rest = body.slice(sectionStart);
		const nextRel = rest.search(/^##\s/m);
		const insertAt = nextRel === -1 ? body.length : sectionStart + nextRel;
		const before = body.slice(0, insertAt).replace(/\s*$/, '\n\n');
		const after = body.slice(insertAt);
		newBody = before + block + (after ? '\n' + after : '');
	}
	meta['updated'] = new Date().toISOString();
	await vscode.workspace.fs.writeFile(cardUri, new TextEncoder().encode(serializeFrontMatter(meta, newBody)));
}

/** Resolves the configured global boards folder, expanding a leading `~`. */
export function globalBoardsRoot(): vscode.Uri {
	const configured = vscode.workspace.getConfiguration('kanban').get<string>('globalBoardsFolder', '~/kanban');
	const expanded = configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
	return vscode.Uri.file(expanded);
}

export interface BoardRef {
	readonly name: string;
	readonly uri: vscode.Uri;
	readonly scope: 'global' | 'workspace';
}

async function readBoardName(uri: vscode.Uri, fallback: string): Promise<string> {
	try {
		const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
		if (typeof raw.name === 'string' && raw.name.length > 0) {
			return raw.name;
		}
	} catch {
		// Fall through to the fallback label
	}
	return fallback;
}

/**
 * Lists global boards (from the configured boards folder, available in
 * every window) and any boards found in the open workspace.
 */
export async function discoverBoards(): Promise<BoardRef[]> {
	const boards: BoardRef[] = [];

	// Global boards: <root>/<board>/.kanban/board.json (and <root>/.kanban itself)
	const root = globalBoardsRoot();
	const candidates: vscode.Uri[] = [vscode.Uri.joinPath(root, '.kanban', 'board.json')];
	try {
		for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
			if (type === vscode.FileType.Directory && name !== '.kanban') {
				candidates.push(vscode.Uri.joinPath(root, name, '.kanban', 'board.json'));
			}
		}
	} catch {
		// Global boards folder does not exist yet — that is fine
	}
	for (const uri of candidates) {
		try {
			await vscode.workspace.fs.stat(uri);
			boards.push({
				name: await readBoardName(uri, path.basename(path.dirname(path.dirname(uri.fsPath)))),
				uri,
				scope: 'global'
			});
		} catch {
			// Not a board
		}
	}

	// Workspace boards (skipped automatically when no folder is open)
	const workspaceBoards = await vscode.workspace.findFiles('**/.kanban/board.json', '**/node_modules/**');
	for (const uri of workspaceBoards.sort((a, b) => a.path.localeCompare(b.path))) {
		if (boards.some(board => board.uri.toString() === uri.toString())) {
			continue;
		}
		boards.push({
			name: await readBoardName(uri, vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..', '..'))),
			uri,
			scope: 'workspace'
		});
	}
	return boards;
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
