/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { AgentRunner } from '../campaign/agentRunner';
import { downloadPdf, ensureRemarkable, formatRmDate, listDocuments, RemarkableDoc } from './client';
import { importRemarkableDocument } from './ingest';
import { renderNotebookPages } from './render';

interface FolderNode {
	readonly kind: 'folder';
	readonly path: string;
	readonly name: string;
}

interface DocNode {
	readonly kind: 'doc';
	readonly doc: RemarkableDoc;
}

type RemarkableNode = FolderNode | DocNode;

/**
 * The reMarkable sidebar: your tablet's folders and notebooks, with
 * inline actions to open a document or turn it into tickets.
 */
export class NotebooksViewProvider implements vscode.TreeDataProvider<RemarkableNode> {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private documents: RemarkableDoc[] | undefined;
	private loading = false;

	public static register(context: vscode.ExtensionContext, runner: AgentRunner): vscode.Disposable {
		const provider = new NotebooksViewProvider(context.secrets);
		const treeView = vscode.window.createTreeView('kanban.remarkableNotebooks', { treeDataProvider: provider });
		const disposables: vscode.Disposable[] = [treeView, provider._onDidChangeTreeData];

		disposables.push(vscode.commands.registerCommand('kanban.remarkable.refresh', () => {
			provider.documents = undefined;
			provider._onDidChangeTreeData.fire();
		}));
		disposables.push(vscode.commands.registerCommand('kanban.remarkable.generateTickets', async (node?: RemarkableNode) => {
			if (node?.kind === 'doc') {
				await importRemarkableDocument(context.secrets, runner, node.doc);
			}
		}));
		disposables.push(vscode.commands.registerCommand('kanban.remarkable.open', async (node?: RemarkableNode) => {
			if (node?.kind === 'doc') {
				await provider.openDocument(node.doc);
			}
		}));

		// Refresh the listing when the view first becomes visible after pairing
		disposables.push(treeView.onDidChangeVisibility(e => {
			if (e.visible && provider.documents === undefined) {
				provider._onDidChangeTreeData.fire();
			}
		}));
		return vscode.Disposable.from(...disposables);
	}

	constructor(private readonly secrets: vscode.SecretStorage) { }

	private async openDocument(doc: RemarkableDoc): Promise<void> {
		const api = await ensureRemarkable(this.secrets);
		if (!api) {
			return;
		}
		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Opening "{0}"…', doc.name) },
				async () => {
					try {
						const pdf = await downloadPdf(api, doc);
						await vscode.env.openExternal(vscode.Uri.file(pdf));
					} catch {
						// Handwritten notebook — render pages and open the first
						const pages = await renderNotebookPages(api, doc, os.tmpdir());
						await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pages[0]));
						if (pages.length > 1) {
							const openAll = vscode.l10n.t('Open All {0} Pages', pages.length);
							void vscode.window.showInformationMessage(vscode.l10n.t('"{0}" rendered.', doc.name), openAll).then(async answer => {
								if (answer === openAll) {
									for (const page of pages.slice(1)) {
										await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(page), { preview: false });
									}
								}
							});
						}
					}
				});
		} catch (error) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Could not open "{0}": {1}', doc.name, error instanceof Error ? error.message : String(error)));
		}
	}

	getTreeItem(node: RemarkableNode): vscode.TreeItem {
		if (node.kind === 'folder') {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = vscode.ThemeIcon.Folder;
			item.contextValue = 'remarkableFolder';
			item.id = `folder:${node.path}`;
			return item;
		}
		const doc = node.doc;
		const item = new vscode.TreeItem(doc.name);
		item.iconPath = new vscode.ThemeIcon(doc.fileType === 'notebook' ? 'edit' : 'file-pdf');
		item.description = formatRmDate(doc.lastModified);
		item.contextValue = 'remarkableDoc';
		item.id = `doc:${doc.id}`;
		item.tooltip = [
			doc.name,
			doc.folder ? vscode.l10n.t('Folder: {0}', doc.folder) : undefined,
			vscode.l10n.t('Type: {0}', doc.fileType),
			vscode.l10n.t('Modified: {0}', formatRmDate(doc.lastModified)),
			doc.pinned ? vscode.l10n.t('Pinned') : undefined
		].filter(Boolean).join('\n');
		item.command = {
			command: 'kanban.remarkable.open',
			title: vscode.l10n.t('Open'),
			arguments: [node]
		};
		return item;
	}

	async getChildren(node?: RemarkableNode): Promise<RemarkableNode[]> {
		if (node?.kind === 'doc') {
			return [];
		}
		if (this.documents === undefined) {
			if (this.loading) {
				return [];
			}
			this.loading = true;
			try {
				const api = await ensureRemarkable(this.secrets);
				this.documents = api ? await listDocuments(api) : [];
			} catch {
				this.documents = [];
			} finally {
				this.loading = false;
			}
		}
		const prefix = node ? node.path : '';
		const docsHere: DocNode[] = [];
		const folders = new Map<string, FolderNode>();
		for (const doc of this.documents) {
			if (doc.folder === prefix) {
				docsHere.push({ kind: 'doc', doc });
			} else if (doc.folder.startsWith(prefix ? prefix + ' / ' : '')) {
				const rest = prefix ? doc.folder.slice(prefix.length + 3) : doc.folder;
				const next = rest.split(' / ')[0];
				if (next) {
					const path = prefix ? `${prefix} / ${next}` : next;
					folders.set(path, { kind: 'folder', path, name: next });
				}
			}
		}
		return [
			...[...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
			...docsHere
		];
	}
}
