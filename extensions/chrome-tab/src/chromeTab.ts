/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One editor tab showing one headless Chrome page. Chrome renders; the webview
// shows a CDP screencast of it (Page.startScreencast) and sends mouse, wheel and
// key input back (Input.dispatch*). Frames are damage-driven, so an idle page
// costs nothing, and casting stops while the tab is hidden.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CDPSession, Dialog, Download, FileChooser, Page } from 'playwright-core';
import type { ChromeHost } from './chromeHost';

export interface ChromeTabOptions {
	readonly url?: string;
	/** An existing page (a popup Chrome opened) instead of a new one. */
	readonly page?: Page;
	readonly shared?: boolean;
	readonly viewColumn?: vscode.ViewColumn;
	readonly preserveFocus?: boolean;
	/** A panel VS Code restored after a window reload (see the serializer in extension.ts). */
	readonly panel?: vscode.WebviewPanel;
}

export const CHROME_TAB_VIEW_TYPE = 'marvincode.chromeTab';

interface ViewerSize {
	readonly width: number;
	readonly height: number;
	readonly dpr: number;
}

type ViewerMessage =
	| { type: 'ready'; width: number; height: number; dpr: number }
	| { type: 'resize'; width: number; height: number }
	| { type: 'drawn' }
	| { type: 'mouse'; event: Record<string, unknown> }
	| { type: 'key'; event: Record<string, unknown> }
	| { type: 'insertText'; text: string }
	| { type: 'clipboard'; action: 'copy' | 'cut' | 'paste' }
	| { type: 'cursorProbe'; x: number; y: number }
	| { type: 'navigate'; url: string }
	| { type: 'history'; action: 'back' | 'forward' | 'reload' }
	| { type: 'openExternal' }
	| { type: 'stopSharing' };

// Evaluated in the page as strings: the extension compiles without the DOM lib.
const SELECTION_TEXT = `(() => {
	const a = document.activeElement;
	if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && typeof a.selectionStart === 'number' && a.selectionEnd !== a.selectionStart) {
		return a.value.slice(a.selectionStart, a.selectionEnd);
	}
	const s = document.getSelection();
	return s ? s.toString() : '';
})()`;

const CURSOR_AT = `((x, y) => {
	let el = document.elementFromPoint(x, y);
	for (let i = 0; el && el.shadowRoot && i < 5; i++) {
		const inner = el.shadowRoot.elementFromPoint(x, y);
		if (!inner || inner === el) { break; }
		el = inner;
	}
	if (!el) { return 'default'; }
	const c = getComputedStyle(el).cursor;
	if (c && c !== 'auto') { return c; }
	const t = el.tagName;
	if (el.isContentEditable || t === 'TEXTAREA' || (t === 'INPUT' && !/^(button|submit|checkbox|radio|range|color|file|image|reset)$/i.test(el.type))) { return 'text'; }
	return 'default';
})`;

const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
const KEY_TYPES = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char']);

function hostLabel(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

function toNavigableUrl(input: string): string {
	const value = input.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
		return value;
	}
	if (/^[^\s]+\.[^\s]+$/.test(value) || /^localhost(:\d+)?(\/|$)/.test(value)) {
		return `https://${value}`;
	}
	return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function nonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function uniqueDownloadPath(dir: string, suggested: string): string {
	const safe = suggested.replace(/[\/\\:*?"<>|]/g, '_') || 'download';
	const ext = path.extname(safe);
	const stem = safe.slice(0, safe.length - ext.length);
	let candidate = path.join(dir, safe);
	for (let i = 1; fs.existsSync(candidate); i++) {
		candidate = path.join(dir, `${stem} (${i})${ext}`);
	}
	return candidate;
}

export class ChromeTab implements vscode.Disposable {
	readonly panel: vscode.WebviewPanel;
	private _shared: boolean;
	private _page: Page | undefined;
	private _cdp: CDPSession | undefined;
	private readonly _ready: Promise<Page>;
	private _resolveViewer!: (size: ViewerSize) => void;
	private _viewport = { width: 1280, height: 800 };
	private _casting = false;
	private _frameSentAt = 0;
	private _pendingFrame: string | undefined;
	private _title = '';
	private _url = '';
	private _dialogLine: string | undefined;
	private _disposed = false;
	private _stateTimer: ReturnType<typeof setInterval> | undefined;
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	constructor(
		readonly id: string,
		private readonly _host: ChromeHost,
		private readonly _extensionUri: vscode.Uri,
		private readonly _log: vscode.LogOutputChannel,
		options: ChromeTabOptions,
	) {
		this._shared = options.shared ?? false;
		this._url = options.url ?? options.page?.url() ?? '';
		const media = vscode.Uri.joinPath(_extensionUri, 'media');
		if (options.panel) {
			this.panel = options.panel;
			this.panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
		} else {
			this.panel = vscode.window.createWebviewPanel(
				CHROME_TAB_VIEW_TYPE,
				hostLabel(this._url) || 'Chrome',
				{ viewColumn: options.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: options.preserveFocus ?? false },
				{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
			);
		}
		this.panel.iconPath = vscode.Uri.joinPath(media, 'chrome-tab.svg');
		const viewerReady = new Promise<ViewerSize>(resolve => this._resolveViewer = resolve);
		this._disposables.push(
			this.panel.webview.onDidReceiveMessage((m: ViewerMessage) => this._onMessage(m)),
			this.panel.onDidChangeViewState(() => this._onViewState()),
			this.panel.onDidDispose(() => this.dispose()),
		);
		this.panel.webview.html = this._html();
		this._ready = this._init(viewerReady, options);
		this._ready.catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			if (!this._disposed) {
				this._log.error(`Chrome Tab ${this.id}: ${message}`);
				this._postStatus(vscode.l10n.t('Chrome could not start: {0}', message));
				void vscode.window.showErrorMessage(vscode.l10n.t('Chrome Tab: {0}', message));
			}
		});
	}

	get shared(): boolean {
		return this._shared;
	}

	set shared(value: boolean) {
		this._shared = value;
		void this._postState();
	}

	get url(): string {
		return this._page && !this._page.isClosed() ? this._page.url() : this._url;
	}

	get title(): string {
		return this._title || hostLabel(this.url);
	}

	get dialogLine(): string | undefined {
		return this._dialogLine;
	}

	/** The page once Chrome is up and the first navigation has committed. */
	page(): Promise<Page> {
		return this._ready;
	}

	isFor(page: Page): boolean {
		return this._page === page;
	}

	reveal(): void {
		this.panel.reveal(undefined, true);
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		if (this._stateTimer) {
			clearInterval(this._stateTimer);
		}
		for (const d of this._disposables) {
			d.dispose();
		}
		const page = this._page;
		if (page && !page.isClosed()) {
			void page.close().catch(() => undefined);
		}
		try {
			this.panel.dispose();
		} catch {
			// Already disposed.
		}
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
	}

	// --- Setup ---

	private async _init(viewerReady: Promise<ViewerSize>, options: ChromeTabOptions): Promise<Page> {
		const size = await Promise.race([viewerReady, new Promise<undefined>(r => setTimeout(() => r(undefined), 4000))]);
		if (size) {
			this._viewport = { width: size.width, height: size.height };
		}
		const page = options.page ?? await this._host.newPage(size?.dpr);
		if (this._disposed) {
			if (!options.page) {
				await page.close().catch(() => undefined);
			}
			throw new Error('Tab closed');
		}
		this._page = page;
		this._wirePage(page);
		this._cdp = await page.context().newCDPSession(page);
		this._cdp.on('Page.screencastFrame', frame => this._onFrame(frame));
		await this._applyViewport();
		if (options.url && !options.page) {
			this._postStatus(vscode.l10n.t('Loading {0}…', hostLabel(options.url) || options.url));
			await page.goto(options.url, { waitUntil: 'commit', timeout: 30000 }).catch(error => this._log.warn(`goto ${options.url}: ${error}`));
		}
		this._stateTimer = setInterval(() => {
			if (this.panel.visible) {
				void this._postState();
			}
		}, 1500);
		this._onViewState();
		await this._postState();
		return page;
	}

	private _wirePage(page: Page): void {
		page.on('close', () => this.dispose());
		page.on('framenavigated', frame => {
			if (frame === page.mainFrame()) {
				void this._postState();
			}
		});
		page.on('load', () => void this._postState());
		page.on('dialog', dialog => void this._onDialog(dialog));
		page.on('filechooser', chooser => void this._onFileChooser(chooser));
		page.on('download', download => void this._onDownload(download));
	}

	private async _applyViewport(): Promise<void> {
		if (!this._cdp) {
			return;
		}
		// deviceScaleFactor 0 keeps Chrome's --force-device-scale-factor.
		await this._cdp.send('Emulation.setDeviceMetricsOverride', { ...this._viewport, deviceScaleFactor: 0, mobile: false }).catch(() => undefined);
		if (this._casting) {
			await this._stopCast();
			await this._startCast();
		}
	}

	// --- Screencast ---

	private _onViewState(): void {
		if (!this._page) {
			return;
		}
		if (this.panel.visible) {
			void this._startCast();
			if (this.panel.active) {
				void this._page.bringToFront().catch(() => undefined);
			}
		} else {
			void this._stopCast();
		}
	}

	private async _startCast(): Promise<void> {
		if (this._casting || !this._cdp) {
			return;
		}
		this._casting = true;
		const scale = this._host.scale ?? 2;
		const quality = vscode.workspace.getConfiguration('marvincode.chrome').get<number>('frameQuality', 80);
		await this._cdp.send('Page.startScreencast', {
			format: 'jpeg',
			quality,
			maxWidth: Math.round(this._viewport.width * scale),
			maxHeight: Math.round(this._viewport.height * scale),
			everyNthFrame: 1,
		}).catch(error => {
			this._casting = false;
			this._log.warn(`startScreencast: ${error}`);
		});
	}

	private async _stopCast(): Promise<void> {
		if (!this._casting || !this._cdp) {
			return;
		}
		this._casting = false;
		await this._cdp.send('Page.stopScreencast').catch(() => undefined);
	}

	private _onFrame(frame: { data: string; sessionId: number }): void {
		void this._cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
		// Keep only the newest frame while the webview is still drawing the last one.
		if (this._frameSentAt && Date.now() - this._frameSentAt < 1000) {
			this._pendingFrame = frame.data;
			return;
		}
		this._sendFrame(frame.data);
	}

	private _sendFrame(data: string): void {
		this._frameSentAt = Date.now();
		void this.panel.webview.postMessage({ type: 'frame', data });
	}

	// --- Viewer messages ---

	private async _onMessage(message: ViewerMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					this._resolveViewer({ width: message.width, height: message.height, dpr: message.dpr });
					return;
				case 'resize':
					this._viewport = { width: Math.max(100, Math.round(message.width)), height: Math.max(100, Math.round(message.height)) };
					await this._applyViewport();
					return;
				case 'drawn': {
					this._frameSentAt = 0;
					const pending = this._pendingFrame;
					if (pending) {
						this._pendingFrame = undefined;
						this._sendFrame(pending);
					}
					return;
				}
			}
			const page = this._page;
			const cdp = this._cdp;
			if (!page || !cdp) {
				return;
			}
			switch (message.type) {
				case 'mouse':
					if (MOUSE_TYPES.has(String(message.event.type))) {
						await cdp.send('Input.dispatchMouseEvent', message.event as never);
					}
					return;
				case 'key':
					if (KEY_TYPES.has(String(message.event.type))) {
						await cdp.send('Input.dispatchKeyEvent', message.event as never);
					}
					return;
				case 'insertText':
					await cdp.send('Input.insertText', { text: message.text });
					return;
				case 'clipboard':
					await this._clipboard(message.action);
					return;
				case 'cursorProbe': {
					const cursor = await page.evaluate(`${CURSOR_AT}(${Number(message.x)}, ${Number(message.y)})`).catch(() => 'default');
					void this.panel.webview.postMessage({ type: 'cursor', value: String(cursor) });
					return;
				}
				case 'navigate':
					await page.goto(toNavigableUrl(message.url), { waitUntil: 'commit' });
					return;
				case 'history':
					if (message.action === 'back') {
						await page.goBack({ waitUntil: 'commit' });
					} else if (message.action === 'forward') {
						await page.goForward({ waitUntil: 'commit' });
					} else {
						await page.reload({ waitUntil: 'commit' });
					}
					return;
				case 'openExternal':
					this._openInSystemChrome(page.url());
					return;
				case 'stopSharing':
					this.shared = false;
					return;
			}
		} catch (error) {
			this._log.warn(`Chrome Tab ${this.id} ${message.type}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _clipboard(action: 'copy' | 'cut' | 'paste'): Promise<void> {
		const page = this._page;
		const cdp = this._cdp;
		if (!page || !cdp) {
			return;
		}
		if (action === 'paste') {
			const text = await vscode.env.clipboard.readText();
			if (text) {
				await cdp.send('Input.insertText', { text });
			}
			return;
		}
		let text = '';
		for (const frame of page.frames()) {
			text = String(await frame.evaluate(SELECTION_TEXT).catch(() => ''));
			if (text) {
				break;
			}
		}
		if (!text) {
			return;
		}
		await vscode.env.clipboard.writeText(text);
		if (action === 'cut') {
			const key = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
			await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['deleteBackward'] });
			await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
		}
	}

	private _openInSystemChrome(url: string): void {
		if (process.platform === 'darwin') {
			execFile('open', ['-a', 'Google Chrome', url], error => {
				if (error) {
					void vscode.env.openExternal(vscode.Uri.parse(url));
				}
			});
		} else {
			void vscode.env.openExternal(vscode.Uri.parse(url));
		}
	}

	private async _postState(): Promise<void> {
		const page = this._page;
		if (!page || page.isClosed() || this._disposed) {
			return;
		}
		this._url = page.url();
		this._title = await page.title().catch(() => this._title);
		let canGoBack = false;
		let canGoForward = false;
		try {
			const history = await this._cdp?.send('Page.getNavigationHistory');
			if (history) {
				canGoBack = history.currentIndex > 0;
				canGoForward = history.currentIndex < history.entries.length - 1;
			}
		} catch {
			// Page navigating or closed.
		}
		if (this._disposed) {
			return;
		}
		const panelTitle = this._title || hostLabel(this._url) || 'Chrome';
		if (this.panel.title !== panelTitle) {
			this.panel.title = panelTitle;
		}
		void this.panel.webview.postMessage({ type: 'state', url: this._url, title: this._title, canGoBack, canGoForward, shared: this._shared });
	}

	private _postStatus(text: string): void {
		void this.panel.webview.postMessage({ type: 'status', text });
	}

	// --- Native UI Chrome cannot show headless ---

	private async _onDialog(dialog: Dialog): Promise<void> {
		const type = dialog.type();
		const message = dialog.message();
		const origin = hostLabel(this.url);
		this._dialogLine = `Active ${type} dialog: "${message}"`;
		try {
			if (type === 'alert') {
				await vscode.window.showInformationMessage(message, { modal: true, detail: origin });
				await dialog.accept();
			} else if (type === 'prompt') {
				const value = await vscode.window.showInputBox({ title: origin, prompt: message, value: dialog.defaultValue() });
				await (value === undefined ? dialog.dismiss() : dialog.accept(value));
			} else {
				const ok = vscode.l10n.t('OK');
				const text = type === 'beforeunload' ? vscode.l10n.t('Leave this page? Changes you made may not be saved.') : message;
				const picked = await vscode.window.showWarningMessage(text, { modal: true, detail: origin }, ok);
				await (picked === ok ? dialog.accept() : dialog.dismiss());
			}
		} catch (error) {
			this._log.warn(`dialog: ${error}`);
		} finally {
			this._dialogLine = undefined;
		}
	}

	private async _onFileChooser(chooser: FileChooser): Promise<void> {
		try {
			const uris = await vscode.window.showOpenDialog({ canSelectMany: chooser.isMultiple(), openLabel: vscode.l10n.t('Upload') });
			await chooser.setFiles(uris ? uris.map(u => u.fsPath) : []);
		} catch (error) {
			this._log.warn(`file chooser: ${error}`);
		}
	}

	private async _onDownload(download: Download): Promise<void> {
		try {
			const target = uniqueDownloadPath(path.join(os.homedir(), 'Downloads'), download.suggestedFilename());
			await download.saveAs(target);
			const reveal = vscode.l10n.t('Reveal in Finder');
			const picked = await vscode.window.showInformationMessage(vscode.l10n.t('Downloaded {0}', path.basename(target)), reveal);
			if (picked === reveal) {
				await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
			}
		} catch (error) {
			this._log.warn(`download: ${error}`);
			void vscode.window.showWarningMessage(vscode.l10n.t('Download failed: {0}', error instanceof Error ? error.message : String(error)));
		}
	}

	// --- Webview ---

	private _html(): string {
		const webview = this.panel.webview;
		const media = vscode.Uri.joinPath(this._extensionUri, 'media');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css'));
		const n = nonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
</head>
<body>
	<div id="toolbar">
		<button id="back" title="${vscode.l10n.t('Back')}" disabled>&#x2039;</button>
		<button id="forward" title="${vscode.l10n.t('Forward')}" disabled>&#x203A;</button>
		<button id="reload" title="${vscode.l10n.t('Reload')}">&#x21BB;</button>
		<form id="nav"><input id="url" type="text" spellcheck="false" autocomplete="off" placeholder="${vscode.l10n.t('Enter a URL')}"></form>
		<span id="shared" hidden title="${vscode.l10n.t('Agents can read and control this page, signed in as you')}">${vscode.l10n.t('Shared with agents')} <button id="unshare">${vscode.l10n.t('Stop')}</button></span>
		<button id="external" title="${vscode.l10n.t('Open in Google Chrome')}">&#x2197;</button>
	</div>
	<div id="stage">
		<canvas id="screen"></canvas>
		<textarea id="sink" aria-label="${vscode.l10n.t('Chrome page input')}" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
		<div id="status">${vscode.l10n.t('Starting Chrome…')}</div>
	</div>
	<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
	}
}
