/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as vscode from 'vscode';
import * as browser from './integratedBrowser';
import {
	TOOL_INPUT_SCHEMAS,
	type ClickBrowserElementInputT,
	type CloseSimpleBrowserInputT,
	type GetDebugStateOutputT,
	type GetDirtyBufferInputT,
	type GetDirtyBufferOutputT,
	type GetEditorStateOutputT,
	type ListDirtyBuffersOutputT,
	type NavigateBrowserPageInputT,
	type OpenBrowserPageInputT,
	type OpenSimpleBrowserInputT,
	type ReadBrowserPageInputT,
	type ScreenshotBrowserPageInputT,
	type ShareBrowserPageInputT,
	type ToolNameT,
	type TypeInBrowserPageInputT,
} from './shared/schema';
import { bridgeRuntimeDir, defaultSocketPath, lockPathFor, socketPathFor } from './shared/socketPath';
import { frame, parseFrames, Request } from './shared/wire';
import { SimpleBrowserTracker } from './simpleBrowser';

const MAX_BUFFER_BYTES = 1_000_000;

interface BridgeServerOpts {
	output: vscode.OutputChannel;
	tracker: SimpleBrowserTracker;
}

interface ServerInfo {
	socketPath: string;
	workspaceRoot: string | null;
}

export class BridgeServer implements vscode.Disposable {
	private server: net.Server | undefined;
	private info: ServerInfo | undefined;
	private readonly connections = new Set<net.Socket>();

	constructor(private readonly opts: BridgeServerOpts) { }

	async start(): Promise<ServerInfo> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const workspaceRoot = folder ? folder.uri.fsPath : null;
		const sockPath = workspaceRoot ? socketPathFor(workspaceRoot) : defaultSocketPath();

		bridgeRuntimeDir();
		if (fs.existsSync(sockPath)) {
			try {
				fs.unlinkSync(sockPath);
			} catch {
				// ignore
			}
		}

		const server = net.createServer(socket => this.handleConnection(socket));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(sockPath, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});

		try {
			fs.chmodSync(sockPath, 0o600);
		} catch {
			// best effort
		}

		if (workspaceRoot) {
			const defaultPath = defaultSocketPath();
			try {
				if (fs.lstatSync(defaultPath, { throwIfNoEntry: false })) {
					fs.unlinkSync(defaultPath);
				}
			} catch {
				// ignore
			}
			try {
				fs.symlinkSync(sockPath, defaultPath);
			} catch (err) {
				this.opts.output.appendLine(`[bridge] could not create default.sock symlink: ${(err as Error).message}`);
			}

			const lockBody = JSON.stringify(
				{
					pid: process.pid,
					socketPath: sockPath,
					workspaceRoot,
					vscodeVersion: vscode.version,
					startedAt: new Date().toISOString(),
				},
				null,
				2
			);
			fs.writeFileSync(lockPathFor(workspaceRoot), lockBody, { mode: 0o600 });
		}

		this.server = server;
		this.info = { socketPath: sockPath, workspaceRoot };
		return this.info;
	}

	status(): ServerInfo | undefined {
		return this.info;
	}

	async stop(): Promise<void> {
		for (const sock of this.connections) {
			sock.destroy();
		}
		this.connections.clear();

		if (this.server) {
			await new Promise<void>(resolve => this.server!.close(() => resolve()));
			this.server = undefined;
		}

		if (this.info) {
			try {
				fs.unlinkSync(this.info.socketPath);
			} catch {
				// ignore
			}
			if (this.info.workspaceRoot) {
				try {
					fs.unlinkSync(lockPathFor(this.info.workspaceRoot));
				} catch {
					// ignore
				}
				try {
					const defaultPath = defaultSocketPath();
					if (fs.readlinkSync(defaultPath) === this.info.socketPath) {
						fs.unlinkSync(defaultPath);
					}
				} catch {
					// ignore
				}
			}
			this.info = undefined;
		}
	}

	dispose(): void {
		void this.stop();
	}

	private handleConnection(socket: net.Socket): void {
		this.connections.add(socket);
		let buffer = '';

		socket.setEncoding('utf8');
		socket.on('data', async chunk => {
			buffer += chunk;
			const { messages, remainder } = parseFrames(buffer);
			buffer = remainder;
			for (const msg of messages) {
				const parsed = Request.safeParse(msg);
				if (!parsed.success) {
					socket.write(
						frame({
							id: (msg as { id?: string } | undefined)?.id ?? '?',
							ok: false,
							error: { code: 'BAD_REQUEST', message: parsed.error.message },
						})
					);
					continue;
				}
				const { id, tool, args } = parsed.data;
				try {
					const result = await this.dispatch(tool as ToolNameT, args);
					socket.write(frame({ id, ok: true, result }));
				} catch (err) {
					const code = (err as { code?: string }).code ?? 'INTERNAL';
					const message = (err as Error).message ?? String(err);
					socket.write(frame({ id, ok: false, error: { code, message } }));
				}
			}
		});

		socket.on('close', () => this.connections.delete(socket));
		socket.on('error', () => this.connections.delete(socket));
	}

	private async dispatch(tool: ToolNameT, rawArgs: unknown): Promise<unknown> {
		const schema = TOOL_INPUT_SCHEMAS[tool];
		if (!schema) {
			const err = new Error(`unknown tool: ${tool}`);
			(err as { code?: string }).code = 'UNKNOWN_TOOL';
			throw err;
		}
		const parsed = schema.safeParse(rawArgs ?? {});
		if (!parsed.success) {
			const err = new Error(`invalid args for ${tool}: ${parsed.error.message}`);
			(err as { code?: string }).code = 'BAD_ARGS';
			throw err;
		}
		const args = parsed.data;

		switch (tool) {
			case 'getEditorState':
				return this.getEditorState();
			case 'getDirtyBuffer':
				return this.getDirtyBuffer(args as GetDirtyBufferInputT);
			case 'listDirtyBuffers':
				return this.listDirtyBuffers();
			case 'getDebugState':
				return this.getDebugState();
			case 'openSimpleBrowser': {
				const a = args as OpenSimpleBrowserInputT;
				return this.opts.tracker.open(a.url, a.reuse);
			}
			case 'listSimpleBrowserTabs':
				return { tabs: this.opts.tracker.list() };
			case 'closeSimpleBrowser':
				return this.opts.tracker.close((args as CloseSimpleBrowserInputT).all);
			case 'listBrowserPages':
				return browser.listBrowserPages();
			case 'openBrowserPage':
				return browser.openBrowserPage(args as OpenBrowserPageInputT);
			case 'shareBrowserPage':
				return browser.shareBrowserPage(args as ShareBrowserPageInputT);
			case 'readBrowserPage':
				return browser.readBrowserPage(args as ReadBrowserPageInputT);
			case 'screenshotBrowserPage':
				return browser.screenshotBrowserPage(args as ScreenshotBrowserPageInputT);
			case 'navigateBrowserPage':
				return browser.navigateBrowserPage(args as NavigateBrowserPageInputT);
			case 'clickBrowserElement':
				return browser.clickBrowserElement(args as ClickBrowserElementInputT);
			case 'typeInBrowserPage':
				return browser.typeInBrowserPage(args as TypeInBrowserPageInputT);
		}
	}

	private getEditorState(): GetEditorStateOutputT {
		const editor = vscode.window.activeTextEditor;
		const activeFile: GetEditorStateOutputT['activeFile'] = editor
			? {
				uri: editor.document.uri.toString(),
				languageId: editor.document.languageId,
				isDirty: editor.document.isDirty,
				isUntitled: editor.document.isUntitled,
				lineCount: editor.document.lineCount,
				cursor: editor.selection
					? { line: editor.selection.active.line, character: editor.selection.active.character }
					: null,
				selection: editor.selection && !editor.selection.isEmpty
					? {
						range: posRange(editor.selection),
						text: editor.document.getText(editor.selection),
					}
					: null,
				visibleRanges: editor.visibleRanges.map(posRange),
			}
			: null;

		const openTabs: GetEditorStateOutputT['openTabs'] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				openTabs.push({
					uri: tabUri(tab),
					label: tab.label,
					isActive: tab.isActive,
					isDirty: tab.isDirty,
					isPinned: tab.isPinned,
					viewColumn: group.viewColumn ?? null,
					kind: tabKind(tab),
				});
			}
		}

		return { activeFile, openTabs };
	}

	private getDirtyBuffer(args: GetDirtyBufferInputT): GetDirtyBufferOutputT {
		const target = vscode.workspace.textDocuments.find(d => d.uri.toString() === args.uri);
		if (!target) {
			const err = new Error(`document not loaded: ${args.uri}`);
			(err as { code?: string }).code = 'NOT_FOUND';
			throw err;
		}
		if (target.uri.scheme !== 'file' && target.uri.scheme !== 'untitled') {
			const err = new Error(`scheme not allowed: ${target.uri.scheme}`);
			(err as { code?: string }).code = 'FORBIDDEN_SCHEME';
			throw err;
		}
		const cap = Math.min(args.maxBytes ?? MAX_BUFFER_BYTES, MAX_BUFFER_BYTES);
		const full = target.getText();
		const bytes = Buffer.byteLength(full, 'utf8');
		const truncated = bytes > cap;
		const content = truncated ? full.slice(0, cap) : full;
		return {
			uri: target.uri.toString(),
			scheme: target.uri.scheme,
			isUntitled: target.isUntitled,
			isDirty: target.isDirty,
			languageId: target.languageId,
			content,
			truncated,
			sizeBytes: bytes,
		};
	}

	private listDirtyBuffers(): ListDirtyBuffersOutputT {
		const buffers: ListDirtyBuffersOutputT['buffers'] = [];
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
				continue;
			}
			if (!doc.isDirty && !doc.isUntitled) {
				continue;
			}
			buffers.push({
				uri: doc.uri.toString(),
				scheme: doc.uri.scheme,
				isUntitled: doc.isUntitled,
				languageId: doc.languageId,
				sizeBytes: Buffer.byteLength(doc.getText(), 'utf8'),
			});
		}
		return { buffers };
	}

	private getDebugState(): GetDebugStateOutputT {
		const session = vscode.debug.activeDebugSession;
		return {
			activeSession: session
				? { id: session.id, name: session.name, type: session.type }
				: null,
			breakpoints: vscode.debug.breakpoints.map(bp => {
				if (bp instanceof vscode.SourceBreakpoint) {
					return {
						uri: bp.location.uri.toString(),
						line: bp.location.range.start.line,
						condition: bp.condition ?? null,
						enabled: bp.enabled,
					};
				}
				return { uri: null, line: null, condition: null, enabled: bp.enabled };
			}),
		};
	}
}

function posRange(r: vscode.Range): { start: { line: number; character: number }; end: { line: number; character: number } } {
	return {
		start: { line: r.start.line, character: r.start.character },
		end: { line: r.end.line, character: r.end.character },
	};
}

function tabUri(tab: vscode.Tab): string {
	const input = tab.input;
	if (input instanceof vscode.TabInputText) {
		return input.uri.toString();
	}
	if (input instanceof vscode.TabInputNotebook) {
		return input.uri.toString();
	}
	if (input instanceof vscode.TabInputCustom) {
		return input.uri.toString();
	}
	if (input instanceof vscode.TabInputTextDiff) {
		return input.modified.toString();
	}
	if (input instanceof vscode.TabInputWebview) {
		return `webview://${input.viewType}`;
	}
	if (input instanceof vscode.TabInputTerminal) {
		return 'terminal:///';
	}
	return '';
}

function tabKind(tab: vscode.Tab): 'text' | 'notebook' | 'webview' | 'terminal' | 'diff' | 'custom' | 'other' {
	const input = tab.input;
	if (input instanceof vscode.TabInputText) {
		return 'text';
	}
	if (input instanceof vscode.TabInputNotebook) {
		return 'notebook';
	}
	if (input instanceof vscode.TabInputWebview) {
		return 'webview';
	}
	if (input instanceof vscode.TabInputTerminal) {
		return 'terminal';
	}
	if (input instanceof vscode.TabInputTextDiff) {
		return 'diff';
	}
	if (input instanceof vscode.TabInputCustom) {
		return 'custom';
	}
	return 'other';
}
