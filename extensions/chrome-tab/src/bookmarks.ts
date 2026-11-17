/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bookmarks shown in the Chrome Tab bookmarks bar, shared by every Chrome Tab.
// They live in the extension's global state, not in Chrome's profile: Chrome owns
// and rewrites its Bookmarks file while it runs, and has no CDP API for it.

import * as vscode from 'vscode';
import type { Page } from 'playwright-core';

export interface Bookmark {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	/** The site's favicon as a data: URL, or undefined for Chrome's default globe. */
	readonly icon?: string;
}

const STORAGE_KEY = 'chromeTab.bookmarks';
const MAX_ICON_BYTES = 64 * 1024;

// Evaluated in the page as a string: the extension compiles without the DOM lib.
// Picks the icon Chrome would show in its tab strip: a small rel=icon, any rel=icon,
// then apple-touch-icon, then /favicon.ico.
const FAVICON_URL = `(() => {
	const links = [...document.querySelectorAll('link[rel]')].filter(l => /(^|\\s)icon(\\s|$)/i.test(l.rel) && l.href);
	const sized = s => links.find(l => (l.sizes && l.sizes.value || '').split(/\\s+/).includes(s));
	const pick = sized('16x16') || sized('32x32') || links.find(l => /svg/i.test(l.type || l.href)) || links[0]
		|| [...document.querySelectorAll('link[rel~="apple-touch-icon" i]')].find(l => l.href);
	return pick ? pick.href : new URL('/favicon.ico', location.href).href;
})()`;

/**
 * Fetches the page's favicon with the page's own cookies (so icons behind the
 * device sign-in load) and returns it as a data: URL, or undefined when the site
 * has none or answers with something that is not an image.
 */
export async function captureFavicon(page: Page): Promise<string | undefined> {
	try {
		const href = String(await page.evaluate(FAVICON_URL));
		if (href.startsWith('data:image/')) {
			return href.length <= MAX_ICON_BYTES * 2 ? href : undefined;
		}
		if (!/^https?:/.test(href)) {
			return undefined;
		}
		const response = await page.context().request.get(href, { timeout: 5000 });
		const type = (response.headers()['content-type'] || '').split(';')[0].trim();
		if (!response.ok() || !type.startsWith('image/')) {
			return undefined;
		}
		const body = await response.body();
		return body.length > 0 && body.length <= MAX_ICON_BYTES ? `data:${type};base64,${body.toString('base64')}` : undefined;
	} catch {
		return undefined;
	}
}

export class BookmarkStore implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly _state: vscode.Memento) { }

	list(): readonly Bookmark[] {
		return this._state.get<Bookmark[]>(STORAGE_KEY, []);
	}

	get(id: string): Bookmark | undefined {
		return this.list().find(b => b.id === id);
	}

	findByUrl(url: string): Bookmark | undefined {
		return this.list().find(b => b.url === url);
	}

	async add(bookmark: Omit<Bookmark, 'id'>): Promise<Bookmark> {
		const added = { ...bookmark, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
		await this._save([...this.list(), added]);
		return added;
	}

	async update(id: string, change: Partial<Omit<Bookmark, 'id'>>): Promise<void> {
		await this._save(this.list().map(b => b.id === id ? { ...b, ...change } : b));
	}

	async remove(id: string): Promise<void> {
		await this._save(this.list().filter(b => b.id !== id));
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	private async _save(bookmarks: Bookmark[]): Promise<void> {
		await this._state.update(STORAGE_KEY, bookmarks);
		this._onDidChange.fire();
	}
}
