/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardFile, Card, createCard, discoverBoards, loadCards, parseBoardFile, parseFrontMatter, updateCardMeta, writeBoardFile } from '../boardModel';
import { AgentRunner } from '../campaign/agentRunner';
import { fileOpsSection } from '../campaign/coordinatorPrompt';
import * as os from 'os';
import { downloadPdf, ensureRemarkable, formatRmDate, listDocuments, RemarkableDoc } from './client';
import { renderNotebookPages } from './render';

interface PickedBoard {
	readonly uri: vscode.Uri;
	readonly board: BoardFile;
	readonly cards: Card[];
}

async function pickBoard(): Promise<PickedBoard | undefined> {
	const boards = await discoverBoards();
	if (!boards.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t('No Kanban boards found — create one first.'));
		return undefined;
	}
	let ref = boards[0];
	if (boards.length > 1) {
		const picked = await vscode.window.showQuickPick(
			boards.map(board => ({ label: board.name, description: board.scope, board })),
			{ placeHolder: vscode.l10n.t('Create meeting tickets on which board?') });
		if (!picked) {
			return undefined;
		}
		ref = picked.board;
	}
	const board = parseBoardFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(ref.uri)));
	return { uri: ref.uri, board, cards: await loadCards(ref.uri) };
}

/** Finds a card already stamped with this document version (dedup). */
async function findIngestedStamp(boardUri: vscode.Uri, docId: string): Promise<{ stamp: string; title: string } | undefined> {
	const cardsDir = vscode.Uri.joinPath(boardUri, '..', 'cards');
	try {
		for (const [fileName, type] of await vscode.workspace.fs.readDirectory(cardsDir)) {
			if (type !== vscode.FileType.File || !fileName.endsWith('.md')) {
				continue;
			}
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(cardsDir, fileName)));
			const { meta } = parseFrontMatter(text);
			if (meta['remarkable']?.startsWith(docId)) {
				return { stamp: meta['remarkable'], title: meta['title'] ?? fileName };
			}
		}
	} catch {
		// No cards dir yet
	}
	return undefined;
}

function buildIngestPrompt(picked: PickedBoard, parentCard: Card, sources: string[], sourceName: string): string {
	const firstColumn = picked.board.columns[0]?.id ?? 'todo';
	const recentTitles = picked.cards.slice(0, 20).map(card => `- ${card.title}`).join('\n');
	const sourceLines = sources.length === 1
		? `Read the PDF at: ${sources[0]}`
		: `Read these page images in order (handwritten notebook pages):\n${sources.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
	return [
		`# Meeting Notes Ingestion

You turn meeting notes into actionable kanban cards. The notes may be handwritten — read carefully and transcribe before extracting.`,
		fileOpsSection(vscode.Uri.joinPath(picked.uri), firstColumn),
		`## Source

${sourceLines}
They contain the notes "${sourceName}". A parent card for this meeting already exists: ${parentCard.id} ("${parentCard.title}").`,
		`## Extraction rules (follow strictly)

- Extract only CONCRETE action items — things someone must do. Skip vague notes, observations and discussion summaries.
- Each card title starts with an action verb (Fix, Implement, Review, Draft, Schedule, Email, ...) and is at most 100 characters.
- Card body: 1-5 sentences of context from the notes (max 500 characters), then a line \`Source: reMarkable: ${sourceName}\` and the page number if identifiable.
- Priority: set urgent or high ONLY when the notes explicitly say so (asap, urgent, by tomorrow, blocker); otherwise medium, or omit.
- Label every card \`meeting-note\` and link it \`parent:${parentCard.id}\`.
- Do NOT duplicate work that is already on the board. Recent card titles:
${recentTitles || '- (board is empty)'}`,
		`## Finish

After creating the cards, append a handoff entry to the parent card file (${parentCard.uri.fsPath}) in its \`## Handoffs\` section:
- Findings: one-paragraph summary of the meeting notes
- Next steps: the list of created card ids with their titles
If the notes contain NO actionable items, create no cards and say so in the handoff instead.`
	].join('\n\n');
}

/** The whole flow: pick board → pick source → parent card → agent run. */
export async function importMeetingNotes(secrets: vscode.SecretStorage, runner: AgentRunner): Promise<void> {
	const picked = await pickBoard();
	if (!picked) {
		return;
	}

	type SourcePick = vscode.QuickPickItem & { mode: 'cloud' | 'local' };
	const source = await vscode.window.showQuickPick<SourcePick>([
		{ label: vscode.l10n.t('From reMarkable'), description: vscode.l10n.t('browse your tablet documents'), mode: 'cloud' },
		{ label: vscode.l10n.t('From a local PDF'), description: vscode.l10n.t('e.g. an exported note or meeting transcript'), mode: 'local' }
	], { placeHolder: vscode.l10n.t('Where are the meeting notes?') });
	if (!source) {
		return;
	}

	let sources: string[];
	let sourceName: string;
	let stamp: string | undefined;

	if (source.mode === 'cloud') {
		const api = await ensureRemarkable(secrets);
		if (!api) {
			return;
		}
		const documents = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Listing reMarkable documents…') },
			() => listDocuments(api));
		if (!documents.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No documents found on your reMarkable.'));
			return;
		}
		const pickedDoc = await vscode.window.showQuickPick(
			documents.map(doc => ({
				label: `${doc.pinned ? '$(pinned) ' : ''}${doc.name}`,
				description: doc.folder || undefined,
				detail: `${doc.fileType} · ${formatRmDate(doc.lastModified)}`,
				doc
			})),
			{ placeHolder: vscode.l10n.t('Which document holds the meeting notes?'), matchOnDescription: true });
		if (!pickedDoc) {
			return;
		}
		const doc: RemarkableDoc = pickedDoc.doc;
		stamp = `${doc.id}@${doc.hash.slice(0, 12)}`;

		const existing = await findIngestedStamp(picked.uri, doc.id);
		if (existing) {
			const again = vscode.l10n.t('Import Again');
			const sameVersion = existing.stamp === stamp;
			const answer = await vscode.window.showWarningMessage(
				sameVersion
					? vscode.l10n.t('"{0}" was already imported (card "{1}") and has not changed since.', doc.name, existing.title)
					: vscode.l10n.t('"{0}" was imported before (card "{1}") but has changed since.', doc.name, existing.title),
				again);
			if (answer !== again) {
				return;
			}
		}
		sources = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Fetching "{0}"…', doc.name) },
			async () => {
				try {
					return [await downloadPdf(api, doc)];
				} catch {
					// Pure notebook — render the handwriting to page images
					return renderNotebookPages(api, doc, os.tmpdir());
				}
			});
		sourceName = doc.name;
	} else {
		const files = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { 'PDF': ['pdf'] },
			title: vscode.l10n.t('Pick the meeting notes PDF')
		});
		if (!files?.length) {
			return;
		}
		sources = [files[0].fsPath];
		sourceName = files[0].path.split('/').pop() ?? 'notes.pdf';
	}

	// Deterministic parent card; the agent creates the children
	const firstColumn = picked.board.columns[0]?.id ?? 'todo';
	const title = vscode.l10n.t('Meeting: {0}', sourceName.replace(/\.pdf$/i, ''));
	const parentId = await createCard(picked.uri, firstColumn, title, {
		labels: ['meeting'],
		body: `Imported from ${source.mode === 'cloud' ? 'reMarkable' : 'PDF'}: ${sourceName}\n`
	});
	const freshBoard = parseBoardFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(picked.uri)));
	await writeBoardFile(picked.uri, { ...freshBoard, order: { ...freshBoard.order, [firstColumn]: [...(freshBoard.order[firstColumn] ?? []), parentId] } });
	const parentCard = (await loadCards(picked.uri)).find(card => card.id === parentId);
	if (!parentCard) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Failed to create the meeting parent card.'));
		return;
	}
	if (stamp) {
		await updateCardMeta(parentCard.uri, { remarkable: stamp });
	}

	const prompt = buildIngestPrompt(picked, parentCard, sources, sourceName);
	void vscode.window.showInformationMessage(vscode.l10n.t('Reading "{0}" — watch the Agents view. Cards will appear on the board as they are extracted.', sourceName));
	void runner.runCoordinator(picked.uri, parentCard, prompt).then(async run => {
		if (run.state !== 'done') {
			void vscode.window.showWarningMessage(vscode.l10n.t('Meeting ingestion did not finish cleanly (exit {0}) — see the Kanban Agents output.', String(run.exitCode)));
			return;
		}
		const children = (await loadCards(picked.uri)).filter(card => card.links.some(link => link.type === 'parent' && link.target === parentId));
		void vscode.window.showInformationMessage(children.length
			? vscode.l10n.t('Meeting ingested: {0} ticket(s) created from "{1}".', children.length, sourceName)
			: vscode.l10n.t('Meeting read — no actionable items found in "{0}" (see the parent card\'s handoff).', sourceName));
	});
}
