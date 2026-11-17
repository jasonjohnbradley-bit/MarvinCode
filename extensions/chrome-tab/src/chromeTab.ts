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
import { Bookmark, BookmarkStore, captureFavicon } from './bookmarks';
import type { ChromeHost } from './chromeHost';
import { colorScheme, onDidChangeColorScheme, toggleDarkMode } from './colorScheme';
import { confirmShare } from './sharing';

export interface ChromeTabOptions {
	readonly url?: string;
	/** An existing page (a popup Chrome opened) instead of a new one. */
	readonly page?: Page;
	readonly shared?: boolean;
	readonly viewColumn?: vscode.ViewColumn;
	readonly preserveFocus?: boolean;
	/** A panel VS Code restored after a window reload (see the serializer in extension.ts). */
	readonly panel?: vscode.WebviewPanel;
	/** Puts the cursor in the address bar once the page is up, as a new Chrome tab does. */
	readonly focusAddressBar?: boolean;
}

export const CHROME_TAB_VIEW_TYPE = 'marvincode.chromeTab';

interface ViewerSize {
	readonly width: number;
	readonly height: number;
	readonly dpr: number;
}

/** The parts of a CDP `Page.screencastFrame` event this tab reads. */
interface ScreencastFrame {
	readonly data: string;
	readonly sessionId: number;
	readonly metadata: { readonly deviceWidth: number; readonly deviceHeight: number };
}

/** A frame for the viewer, with the size in CSS pixels it shows the page at. */
interface FrameMessage {
	readonly data: string;
	readonly width: number;
	readonly height: number;
}

// Re-asserting the viewport after a mismatched frame: the first try waits
// HEAL_DELAY_MS (a viewport change already under way usually fixes it), tries are
// HEAL_INTERVAL_MS apart, and after HEAL_ATTEMPTS tries within HEAL_WINDOW_MS the
// tab gives up and shows frames as they come rather than freeze.
const HEAL_DELAY_MS = 100;
const HEAL_INTERVAL_MS = 250;
const HEAL_WINDOW_MS = 2000;
const HEAL_ATTEMPTS = 4;

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
	| { type: 'toggleShare' }
	| { type: 'toggleDarkMode' }
	| { type: 'toggleBookmark' }
	| { type: 'openBookmark'; id: string; newTab: boolean }
	| { type: 'bookmarkMenu'; id: string }
	| { type: 'bookmarksOverflow' };

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

// The codicon `share-window` glyph the Integrated Browser's Share with Agent button uses.
const SHARE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14 1H6C4.9 1 4 1.9 4 3V5H2C0.9 5 0 5.9 0 7V13C0 14.1 0.9 15 2 15H10C11.1 15 12 14.1 12 13V11H14C15.1 11 16 10.1 16 9V3C16 1.9 15.1 1 14 1ZM11 13C11 13.55 10.55 14 10 14H2C1.45 14 1 13.55 1 13V7C1 6.45 1.45 6 2 6H4V9C4 10.1 4.9 11 6 11H11V13ZM15 9C15 9.55 14.55 10 14 10H12V7C12 5.9 11.1 5 10 5H5V3C5 2.45 5.45 2 6 2H14C14.55 2 15 2.45 15 3V9Z"/></svg>';

const MOON_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 10.5A6 6 0 1 1 5.5 2.5a6.5 6.5 0 0 0 8 8Z"/></svg>';

const STAR_EMPTY_ICON = '<svg class="empty" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.928 15C11.774 15 11.625 14.962 11.484 14.889L8 13.056L4.516 14.888C4.132 15.092 3.623 14.99 3.339 14.656C3.157 14.438 3.084 14.164 3.131 13.883L3.797 10.003L0.978 7.25499C0.713 6.99699 0.623 6.63199 0.736 6.27899C0.852 5.92399 1.139 5.68099 1.506 5.62699L5.402 5.06099L7.144 1.53099C7.472 0.864994 8.527 0.864994 8.855 1.53099L10.597 5.06099L14.493 5.62699C14.861 5.68099 15.148 5.92299 15.263 6.27499C15.377 6.63099 15.286 6.99599 15.022 7.25399L12.203 10.002L12.869 13.882C12.917 14.164 12.844 14.437 12.664 14.653C12.479 14.871 12.204 15 11.928 15ZM7.959 1.97399L6.066 5.97499L1.65 6.61599L4.871 9.65299L4.117 14.05L8 11.925L11.892 13.972L11.129 9.65299L14.324 6.53799L9.934 5.97499L7.959 1.97399Z"/></svg>';
const STAR_FULL_ICON = '<svg class="full" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M15.022 7.25497L12.203 10.003L12.869 13.883C12.917 14.165 12.844 14.438 12.664 14.654C12.479 14.872 12.205 15.001 11.929 15.001C11.775 15.001 11.626 14.963 11.485 14.89L8.00101 13.057L4.51701 14.889C4.13401 15.093 3.62401 14.991 3.34001 14.657C3.15801 14.439 3.08501 14.165 3.13201 13.884L3.79801 10.004L0.979007 7.25597C0.714007 6.99797 0.624007 6.63297 0.737007 6.27997C0.853007 5.92497 1.14001 5.68197 1.50701 5.62797L5.40301 5.06197L7.14501 1.53197C7.47301 0.865971 8.52801 0.865971 8.85601 1.53197L10.598 5.06197L14.494 5.62797C14.862 5.68197 15.149 5.92397 15.264 6.27597C15.378 6.63197 15.286 6.99697 15.022 7.25497Z"/></svg>';

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

/** Pixel size of a base64 JPEG, read from its start-of-frame marker. */
function jpegSize(base64: string): { width: number; height: number } | undefined {
	// Chrome's encoder writes the frame header within the first few hundred bytes.
	const bytes = Buffer.from(base64.slice(0, 4096), 'base64');
	if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
		return undefined;
	}
	for (let i = 2; i + 9 <= bytes.length;) {
		if (bytes[i] !== 0xFF) {
			return undefined;
		}
		const marker = bytes[i + 1];
		// SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
		if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
			return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
		}
		i += 2 + bytes.readUInt16BE(i + 2);
	}
	return undefined;
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
	private _viewportQueue: Promise<void> = Promise.resolve();
	private _casting = false;
	private _frameSentAt = 0;
	private _pendingFrame: FrameMessage | undefined;
	private _mismatchedFrame: ScreencastFrame | undefined;
	private _healTimer: ReturnType<typeof setTimeout> | undefined;
	private _healTimes: number[] = [];
	private _healGaveUp = false;
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
		private readonly _bookmarks: BookmarkStore,
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
			_bookmarks.onDidChange(() => this._postBookmarks()),
			onDidChangeColorScheme(() => void this._applyColorScheme()),
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

	/** Shares the page with agents if the user agrees (see {@link confirmShare}). */
	async requestShare(requestedByAgent: boolean): Promise<boolean> {
		if (!this._shared) {
			if (requestedByAgent) {
				this.reveal();
			}
			this.shared = await confirmShare(this.title, this.url, requestedByAgent);
		}
		return this._shared;
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
		if (this._healTimer) {
			clearTimeout(this._healTimer);
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
		await this._applyColorScheme();
		if (options.url && !options.page) {
			this._postStatus(vscode.l10n.t('Loading {0}…', hostLabel(options.url) || options.url));
			await page.goto(options.url, { waitUntil: 'commit', timeout: 30000 }).catch(error => this._log.warn(`goto ${options.url}: ${error}`));
		}
		this._stateTimer = setInterval(() => {
			if (this.panel.visible) {
				void this._postState();
			} else {
				// Heartbeat: the viewer shows "disconnected" when these stop.
				void this.panel.webview.postMessage({ type: 'ping' });
			}
		}, 1500);
		this._onViewState();
		await this._postState();
		if (options.focusAddressBar) {
			void this.panel.webview.postMessage({ type: 'focusAddressBar' });
		}
		return page;
	}

	private _wirePage(page: Page): void {
		page.on('close', () => this.dispose());
		page.on('framenavigated', frame => {
			if (frame === page.mainFrame()) {
				void this._postState();
			}
		});
		page.on('load', () => {
			void this._postState();
			void this._refreshBookmarkIcon(page);
		});
		page.on('dialog', dialog => void this._onDialog(dialog));
		page.on('filechooser', chooser => void this._onFileChooser(chooser));
		page.on('download', download => void this._onDownload(download));
	}

	/** Sets the page's viewport to the viewer's stage size (CSS pixels). */
	private async _setViewport(width: number, height: number): Promise<void> {
		this._viewport = { width: Math.max(100, Math.round(width)), height: Math.max(100, Math.round(height)) };
		this._healGaveUp = false;
		this._healTimes = [];
		await this._applyViewport();
	}

	/** Queued, so a resize and a re-assert never interleave the cast restart. */
	private _applyViewport(): Promise<void> {
		const run = this._viewportQueue.then(() => this._applyViewportNow());
		this._viewportQueue = run.catch(() => undefined);
		return run;
	}

	private async _applyViewportNow(): Promise<void> {
		if (!this._cdp || this._disposed) {
			return;
		}
		// deviceScaleFactor 0 keeps Chrome's --force-device-scale-factor.
		await this._cdp.send('Emulation.setDeviceMetricsOverride', { ...this._viewport, deviceScaleFactor: 0, mobile: false }).catch(() => undefined);
		if (this._casting) {
			// Restarting makes Chrome send a fresh frame at the new size.
			await this._stopCast();
			await this._startCast();
		}
	}

	/** Applies the dark-mode settings (see colorScheme.ts) to the page and the toolbar. */
	private async _applyColorScheme(): Promise<void> {
		const scheme = colorScheme();
		this._postColorScheme();
		const page = this._page;
		const cdp = this._cdp;
		if (!page || !cdp || page.isClosed()) {
			return;
		}
		// Through Playwright, which otherwise keeps every page at its default (light).
		await page.emulateMedia({ colorScheme: scheme.dark ? 'dark' : 'light' }).catch(error => this._log.warn(`colorScheme: ${error}`));
		// Without `enabled` the override is cleared.
		await cdp.send('Emulation.setAutoDarkModeOverride', scheme.forceDark ? { enabled: true } : {}).catch(error => this._log.warn(`forceDark: ${error}`));
	}

	private _postColorScheme(): void {
		void this.panel.webview.postMessage({ type: 'colorScheme', dark: colorScheme().dark });
	}

	// --- Screencast ---

	private _onViewState(): void {
		const page = this._page;
		if (!page) {
			return;
		}
		if (this.panel.visible) {
			void this._startCast();
			if (this.panel.active) {
				void this._activate(page);
			}
		} else {
			void this._stopCast();
		}
	}

	/**
	 * Gives the page focus. Every Chrome Tab is a tab of one headless Chrome window,
	 * and activating one makes Chrome capture it at that window's size again
	 * (1920x1079) while the page keeps its emulated size, so set the viewport again.
	 */
	private async _activate(page: Page): Promise<void> {
		await page.bringToFront().catch(() => undefined);
		await this._applyViewport();
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

	private _onFrame(frame: ScreencastFrame): void {
		void this._cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
		const mismatch = this._healGaveUp ? undefined : this._frameMismatch(frame);
		if (mismatch) {
			// Chrome captured more or less than the page (see _activate). Drawn into
			// the stage, that frame comes out stretched, clipped and edged in white.
			this._mismatchedFrame = frame;
			this._scheduleHeal(mismatch);
			return;
		}
		this._mismatchedFrame = undefined;
		this._deliverFrame(frame);
	}

	/** How a frame differs from the viewport, or undefined when it matches. */
	private _frameMismatch(frame: ScreencastFrame): string | undefined {
		const { width, height } = this._viewport;
		const { deviceWidth, deviceHeight } = frame.metadata;
		if (Math.abs(deviceWidth - width) > 1 || Math.abs(deviceHeight - height) > 1) {
			return `${Math.round(deviceWidth)}x${Math.round(deviceHeight)}`;
		}
		// The first frame after a viewport change can carry the new size in its
		// metadata and still show the old capture.
		const image = jpegSize(frame.data);
		if (image && Math.abs(image.width / image.height - width / height) > 0.01 * width / height) {
			return `an image of ${image.width}x${image.height}px`;
		}
		return undefined;
	}

	private _scheduleHeal(seen: string): void {
		if (this._healTimer) {
			return;
		}
		const last = this._healTimes[this._healTimes.length - 1] ?? 0;
		const wait = Math.max(HEAL_DELAY_MS, last + HEAL_INTERVAL_MS - Date.now());
		this._healTimer = setTimeout(() => {
			this._healTimer = undefined;
			const frame = this._mismatchedFrame;
			if (!frame || this._disposed) {
				return; // A matching frame arrived meanwhile.
			}
			const now = Date.now();
			this._healTimes = this._healTimes.filter(t => now - t < HEAL_WINDOW_MS);
			const want = `${this._viewport.width}x${this._viewport.height}`;
			if (this._healTimes.length >= HEAL_ATTEMPTS) {
				this._healGaveUp = true;
				this._mismatchedFrame = undefined;
				this._log.warn(`Chrome Tab ${this.id}: frames are still ${seen} after ${HEAL_ATTEMPTS} tries to set ${want}; showing them as they are`);
				this._deliverFrame(frame);
				return;
			}
			this._healTimes.push(now);
			this._log.info(`Chrome Tab ${this.id}: frame was ${seen}, setting the viewport to ${want} again`);
			void this._applyViewport();
		}, wait);
	}

	private _deliverFrame(frame: ScreencastFrame): void {
		const message: FrameMessage = { data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight };
		// Keep only the newest frame while the webview is still drawing the last one.
		if (this._frameSentAt && Date.now() - this._frameSentAt < 1000) {
			this._pendingFrame = message;
			return;
		}
		this._sendFrame(message);
	}

	private _sendFrame(frame: FrameMessage): void {
		this._frameSentAt = Date.now();
		void this.panel.webview.postMessage({ type: 'frame', ...frame });
	}

	// --- Viewer messages ---

	private async _onMessage(message: ViewerMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					this._resolveViewer({ width: message.width, height: message.height, dpr: message.dpr });
					this._postBookmarks();
					this._postColorScheme();
					// A viewer that loads after _init stopped waiting (a tab restored in
					// the background, a reloaded webview) still sets the size.
					await this._setViewport(message.width, message.height);
					return;
				case 'bookmarkMenu': {
					const bookmark = this._bookmarks.get(message.id);
					if (bookmark) {
						await this._editBookmark(bookmark, true);
					}
					return;
				}
				case 'toggleDarkMode':
					// The settings listener then updates every Chrome Tab.
					await toggleDarkMode();
					return;
				case 'resize':
					await this._setViewport(message.width, message.height);
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
				case 'toggleShare':
					if (this._shared) {
						this.shared = false;
					} else {
						await this.requestShare(false);
					}
					return;
				case 'toggleBookmark':
					await this._toggleBookmark(page);
					return;
				case 'openBookmark': {
					const bookmark = this._bookmarks.get(message.id);
					if (bookmark) {
						await this._openBookmark(page, bookmark, message.newTab);
					}
					return;
				}
				case 'bookmarksOverflow': {
					const picked = await vscode.window.showQuickPick(
						this._bookmarks.list().map(bookmark => ({ label: bookmark.title, description: hostLabel(bookmark.url), bookmark })),
						{ title: vscode.l10n.t('Bookmarks'), matchOnDescription: true });
					if (picked) {
						await this._openBookmark(page, picked.bookmark, false);
					}
					return;
				}
			}
		} catch (error) {
			this._log.warn(`Chrome Tab ${this.id} ${message.type}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// --- Bookmarks ---

	private _postBookmarks(): void {
		void this.panel.webview.postMessage({ type: 'bookmarks', items: this._bookmarks.list() });
	}

	/** The address-bar star: bookmarks the page, or edits its bookmark like Chrome's star does. */
	private async _toggleBookmark(page: Page): Promise<void> {
		const url = page.url();
		if (!/^https?:/.test(url)) {
			return;
		}
		const existing = this._bookmarks.findByUrl(url);
		if (existing) {
			await this._editBookmark(existing, false);
			return;
		}
		const title = (await page.title().catch(() => '')).trim() || hostLabel(url) || url;
		await this._bookmarks.add({ title, url, icon: await captureFavicon(page) });
	}

	private async _openBookmark(page: Page, bookmark: Bookmark, newTab: boolean): Promise<void> {
		if (newTab) {
			await vscode.commands.executeCommand('marvincode.chrome.openUrl', bookmark.url);
		} else {
			await page.goto(bookmark.url, { waitUntil: 'commit' });
		}
	}

	private async _editBookmark(bookmark: Bookmark, offerOpen: boolean): Promise<void> {
		type Action = 'open' | 'rename' | 'remove';
		const items: (vscode.QuickPickItem & { action: Action })[] = [
			...(offerOpen ? [{ label: `$(link-external) ${vscode.l10n.t('Open in New Chrome Tab')}`, action: 'open' as const }] : []),
			{ label: `$(edit) ${vscode.l10n.t('Rename Bookmark…')}`, action: 'rename' },
			{ label: `$(trash) ${vscode.l10n.t('Remove Bookmark')}`, action: 'remove' },
		];
		const picked = await vscode.window.showQuickPick(items, { title: bookmark.title, placeHolder: bookmark.url });
		if (picked?.action === 'open') {
			await vscode.commands.executeCommand('marvincode.chrome.openUrl', bookmark.url);
		} else if (picked?.action === 'rename') {
			const title = await vscode.window.showInputBox({ title: vscode.l10n.t('Rename Bookmark'), value: bookmark.title, prompt: bookmark.url });
			if (title?.trim()) {
				await this._bookmarks.update(bookmark.id, { title: title.trim() });
			}
		} else if (picked?.action === 'remove') {
			await this._bookmarks.remove(bookmark.id);
		}
	}

	/** Fills in the icon of a bookmark saved before its page had one (or while offline). */
	private async _refreshBookmarkIcon(page: Page): Promise<void> {
		const bookmark = this._bookmarks.findByUrl(page.url());
		if (bookmark && !bookmark.icon) {
			const icon = await captureFavicon(page);
			if (icon) {
				await this._bookmarks.update(bookmark.id, { icon });
			}
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
			const key = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 };
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
<body data-disconnected="${vscode.l10n.t('This Chrome Tab lost its connection (the extension host restarted). Close it and open the page again.')}">
	<div id="toolbar">
		<button id="back" title="${vscode.l10n.t('Back')}" disabled>&#x2039;</button>
		<button id="forward" title="${vscode.l10n.t('Forward')}" disabled>&#x203A;</button>
		<button id="reload" title="${vscode.l10n.t('Reload')}">&#x21BB;</button>
		<form id="nav"><input id="url" type="text" spellcheck="false" autocomplete="off" placeholder="${vscode.l10n.t('Enter a URL')}"><button id="star" type="button" aria-pressed="false" title="${vscode.l10n.t('Bookmark This Page')}" data-add="${vscode.l10n.t('Bookmark This Page')}" data-edit="${vscode.l10n.t('Edit Bookmark for This Page')}">${STAR_EMPTY_ICON}${STAR_FULL_ICON}</button></form>
		<button id="dark" aria-pressed="false" title="${vscode.l10n.t('Dark Mode')}" aria-label="${vscode.l10n.t('Dark Mode')}" data-on="${vscode.l10n.t('Turn Off Dark Mode')}" data-off="${vscode.l10n.t('Turn On Dark Mode')}">${MOON_ICON}</button>
		<button id="share" aria-pressed="false" title="${vscode.l10n.t('Share with Agent')}" aria-label="${vscode.l10n.t('Share with Agent')}" data-share="${vscode.l10n.t('Share with Agent')}" data-unshare="${vscode.l10n.t('Stop Sharing with Agent')}"><span class="label">${vscode.l10n.t('Sharing with Agent')}</span>${SHARE_ICON}</button>
		<button id="external" title="${vscode.l10n.t('Open in Google Chrome')}">&#x2197;</button>
	</div>
	<div id="bookmarks" hidden><div id="bm-list" role="toolbar" aria-label="${vscode.l10n.t('Bookmarks')}"></div><button id="bm-more" hidden title="${vscode.l10n.t('Show All Bookmarks')}">&#xBB;</button></div>
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
