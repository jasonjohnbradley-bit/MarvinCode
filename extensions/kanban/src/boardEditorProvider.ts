/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addColumnToBoard, createCard, loadBoardState, loadCards, moveCardInBoard, parseBoardFile, serializeBoardFile, setCardColumn, updateCardMeta } from './boardModel';
import { readJiraConfig } from './jira/config';

/**
 * Renders `.kanban/board.json` as an interactive board. Backing the editor
 * with the text document keeps undo/redo and dirty tracking working; card
 * files are read separately and refreshed via a file watcher.
 */
export class BoardEditorProvider implements vscode.CustomTextEditorProvider {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			'kanban.board',
			new BoardEditorProvider(context),
			{ webviewOptions: { retainContextWhenHidden: true } }
		);
	}

	constructor(private readonly context: vscode.ExtensionContext) { }

	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
		const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [mediaRoot]
		};
		webviewPanel.webview.html = this.getHtml(webviewPanel.webview, mediaRoot);

		let updateTimer: ReturnType<typeof setTimeout> | undefined;
		const update = () => {
			if (updateTimer) {
				clearTimeout(updateTimer);
			}
			updateTimer = setTimeout(async () => {
				try {
					const state = await loadBoardState(document.uri, document.getText());
					// Bodies are only needed for the drawer — cap them so a
					// big Jira-linked board does not ship megabytes per update
					const slim = {
						...state,
						columns: state.columns.map(column => ({
							...column,
							cards: column.cards.map(card => ({ ...card, body: card.body.length > 8192 ? card.body.slice(0, 8192) + '\n\n(truncated — open the card file for the rest)' : card.body }))
						}))
					};
					webviewPanel.webview.postMessage({ type: 'board', state: slim });
				} catch (error) {
					webviewPanel.webview.postMessage({ type: 'error', message: String(error) });
				}
			}, 100);
		};

		const subscriptions: vscode.Disposable[] = [];
		subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				update();
			}
		}));

		const boardDir = vscode.Uri.joinPath(document.uri, '..');
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(boardDir, 'cards/*.md'));
		subscriptions.push(watcher);
		subscriptions.push(watcher.onDidCreate(update));
		subscriptions.push(watcher.onDidChange(update));
		subscriptions.push(watcher.onDidDelete(update));

		subscriptions.push(webviewPanel.webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'ready':
						update();
						break;
					case 'openCard':
						if (typeof message.fileName === 'string' && /^[\w.-]+\.md$/.test(message.fileName)) {
							await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(boardDir, 'cards', message.fileName));
						}
						break;
					case 'openJira':
						if (typeof message.key === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(message.key)) {
							const config = await readJiraConfig(document.uri);
							if (config) {
								await vscode.env.openExternal(vscode.Uri.parse(`${config.host}/browse/${message.key}`));
							}
						}
						break;
					case 'openExternal':
						if (typeof message.url === 'string' && /^https?:\/\//.test(message.url)) {
							await vscode.env.openExternal(vscode.Uri.parse(message.url));
						}
						break;
					case 'copyText':
						if (typeof message.text === 'string') {
							await vscode.env.clipboard.writeText(message.text);
						}
						break;
					case 'updateCard': {
						if (typeof message.cardId !== 'string') {
							break;
						}
						const card = (await loadCards(document.uri)).find(c => c.id === message.cardId);
						if (card) {
							await updateCardMeta(card.uri, {
								title: typeof message.title === 'string' && message.title.trim() ? message.title.trim() : undefined,
								priority: typeof message.priority === 'string' ? message.priority : undefined,
								labels: Array.isArray(message.labels) ? message.labels.join(', ') : undefined
							});
						}
						break;
					}
					case 'runAgent':
						if (typeof message.cardId === 'string') {
							await vscode.commands.executeCommand('kanban.runAgentOnCard', document.uri, message.cardId);
						}
						break;
					case 'decompose':
						if (typeof message.cardId === 'string') {
							await vscode.commands.executeCommand('kanban.decomposeCard', document.uri, message.cardId);
						}
						break;
					case 'pushJira':
						if (typeof message.cardId === 'string') {
							await vscode.commands.executeCommand('kanban.jira.pushCard', document.uri, message.cardId);
						}
						break;
					case 'moveCard':
						await this.moveCard(document, message.cardId, message.toColumn, message.toIndex);
						break;
					case 'createCard':
						if (typeof message.title === 'string' && message.title.trim().length > 0) {
							await this.createCard(document, message.column, message.title.trim());
						}
						break;
					case 'addColumn':
						if (typeof message.title === 'string' && message.title.trim().length > 0) {
							await this.replaceBoard(document, addColumnToBoard(parseBoardFile(document.getText()), message.title.trim()));
						}
						break;
				}
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t('Kanban action failed: {0}', String(error)));
			}
		}));

		webviewPanel.onDidDispose(() => {
			if (updateTimer) {
				clearTimeout(updateTimer);
			}
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
		});

		update();
	}

	/**
	 * Moves a card: the board.json ordering changes through a WorkspaceEdit
	 * on the open document (kept undoable), the card's front-matter is
	 * rewritten on disk, and the document is saved so the two stay in sync.
	 */
	private async moveCard(document: vscode.TextDocument, cardId: string, toColumn: string, toIndex: number): Promise<void> {
		if (typeof cardId !== 'string' || typeof toColumn !== 'string' || typeof toIndex !== 'number') {
			return;
		}
		const board = parseBoardFile(document.getText());
		if (!board.columns.some(column => column.id === toColumn)) {
			return;
		}
		await this.replaceBoard(document, moveCardInBoard(board, cardId, toColumn, toIndex));
		const card = (await loadCards(document.uri)).find(c => c.id === cardId);
		if (card && card.column !== toColumn) {
			await setCardColumn(card.uri, toColumn);
		}
	}

	private async createCard(document: vscode.TextDocument, column: string, title: string): Promise<void> {
		const board = parseBoardFile(document.getText());
		if (!board.columns.some(c => c.id === column)) {
			return;
		}
		const id = await createCard(document.uri, column, title);
		const target = board.order[column] ?? [];
		await this.replaceBoard(document, {
			...board,
			order: { ...board.order, [column]: [...target, id] }
		});
	}

	private async replaceBoard(document: vscode.TextDocument, board: ReturnType<typeof parseBoardFile>): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
		edit.replace(document.uri, fullRange, serializeBoardFile(board));
		await vscode.workspace.applyEdit(edit);
		await document.save();
	}

	private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'board.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'board.css'));
		const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicon.css'));
		const nonce = crypto.randomUUID().replace(/-/g, '');
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codiconsUri}" rel="stylesheet">
	<link href="${styleUri}" rel="stylesheet">
	<title>Kanban Board</title>
</head>
<body>
	<div id="board" aria-live="polite"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
