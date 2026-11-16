/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Owns the one headless Google Chrome process behind every Chrome Tab.
//
// Real, IT-managed Chrome (not Electron's Chromium) is the point: Chrome 135+ on
// macOS talks to the Microsoft Enterprise SSO plug-in, so sites behind Entra
// device-based Conditional Access load where the Integrated Browser cannot.
// Playwright launches it over a CDP *pipe* — no TCP debugging port exists for
// other local processes to attach to — with a dedicated profile, which Chrome
// 136+ requires for remote debugging anyway.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BrowserContext, Page } from 'playwright-core';
import { loadPlaywright } from './playwright';

const PROFILE_SLOTS = 4;
const PROFILE_IN_USE = /ProcessSingleton|SingletonLock|profile.{0,40}(in use|locked)|existing browser session/i;

export class ChromeHost implements vscode.Disposable {
	private _context: Promise<BrowserContext> | undefined;
	private _live: BrowserContext | undefined;
	private _scale: number | undefined;
	private _ownPending = 0;

	private readonly _onDidOpenPopup = new vscode.EventEmitter<Page>();
	/** Pages Chrome opened by itself (window.open, target=_blank). */
	readonly onDidOpenPopup = this._onDidOpenPopup.event;

	constructor(
		private readonly _storageDir: string,
		private readonly _log: vscode.LogOutputChannel,
	) { }

	get isRunning(): boolean {
		return this._context !== undefined;
	}

	/** Device scale factor Chrome renders at; fixed for the life of the process. */
	get scale(): number | undefined {
		return this._scale;
	}

	/** Starts Chrome on first use. `displayScale` is the first Chrome Tab's devicePixelRatio. */
	context(displayScale?: number): Promise<BrowserContext> {
		if (!this._context) {
			const configured = vscode.workspace.getConfiguration('marvincode.chrome').get<number>('deviceScaleFactor', 0);
			const scale = configured > 0 ? configured : Math.max(1, Math.round(displayScale ?? 2));
			const launching = this._launch(scale);
			this._context = launching;
			launching.catch(() => {
				if (this._context === launching) {
					this._context = undefined;
				}
			});
		}
		return this._context;
	}

	async newPage(displayScale?: number): Promise<Page> {
		const context = await this.context(displayScale);
		this._ownPending++;
		try {
			return await context.newPage();
		} finally {
			this._ownPending--;
		}
	}

	async close(): Promise<void> {
		const context = this._context;
		this._context = undefined;
		this._live = undefined;
		this._scale = undefined;
		if (context) {
			try {
				await (await context).close();
			} catch {
				// Launch failed or Chrome already gone.
			}
		}
	}

	dispose(): void {
		void this.close();
		this._onDidOpenPopup.dispose();
	}

	private async _launch(scale: number): Promise<BrowserContext> {
		const playwright = loadPlaywright();
		const executablePath = vscode.workspace.getConfiguration('marvincode.chrome').get<string>('executablePath', '').trim();
		fs.mkdirSync(this._storageDir, { recursive: true });

		let lastError: unknown;
		for (let slot = 1; slot <= PROFILE_SLOTS; slot++) {
			const profile = path.join(this._storageDir, slot === 1 ? 'chrome-profile' : `chrome-profile-${slot}`);
			try {
				this._log.info(`Launching Chrome (profile ${profile}, scale ${scale})`);
				const context = await playwright.chromium.launchPersistentContext(profile, {
					...(executablePath ? { executablePath } : { channel: 'chrome' }),
					headless: true,
					viewport: null,
					acceptDownloads: true,
					args: [`--force-device-scale-factor=${scale}`, '--window-size=1920,1200'],
				});
				this._live = context;
				this._scale = scale;
				context.on('page', page => this._onPage(page));
				context.on('close', () => {
					if (this._live === context) {
						this._log.warn('Chrome closed');
						this._live = undefined;
						this._context = undefined;
						this._scale = undefined;
					}
				});
				void this._logVersion(context);
				return context;
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				if (PROFILE_IN_USE.test(message)) {
					this._log.warn(`Profile ${profile} is in use by another window; trying the next one`);
					continue;
				}
				this._log.error(`Chrome failed to start: ${message}`);
				throw error;
			}
		}
		throw lastError;
	}

	private _onPage(page: Page): void {
		// Our own newPage() calls also raise 'page'; only report pages Chrome opened.
		const maybeOwn = this._ownPending > 0;
		void page.opener().then(opener => {
			if (maybeOwn && !opener) {
				return;
			}
			this._onDidOpenPopup.fire(page);
		}, () => undefined);
	}

	private async _logVersion(context: BrowserContext): Promise<void> {
		try {
			const page = context.pages()[0];
			if (!page) {
				return;
			}
			const session = await context.newCDPSession(page);
			const version = await session.send('Browser.getVersion');
			await session.detach();
			this._log.info(`Chrome ready: ${version.product}`);
		} catch {
			// Diagnostic only.
		}
	}
}
