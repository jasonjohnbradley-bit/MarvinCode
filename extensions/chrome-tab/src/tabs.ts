/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Page } from 'playwright-core';
import type { BookmarkStore } from './bookmarks';
import type { ChromeHost } from './chromeHost';
import { ChromeTab, ChromeTabOptions } from './chromeTab';

/** Page ids are prefixed so the vscode-bridge can route them to this extension. */
export const CHROME_PAGE_PREFIX = 'chrome:';

export class ChromeTabs implements vscode.Disposable {
	private readonly _tabs = new Map<string, ChromeTab>();
	private _next = 1;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly _host: ChromeHost,
		private readonly _extensionUri: vscode.Uri,
		private readonly _log: vscode.LogOutputChannel,
		private readonly _bookmarks: BookmarkStore,
	) {
		this._disposables.push(_host.onDidOpenPopup(page => {
			// Let our own open() register its page first; give popups their own tab.
			setTimeout(() => {
				if (!page.isClosed() && !this.findByPage(page)) {
					this.open({ page, viewColumn: vscode.ViewColumn.Active });
				}
			}, 50);
		}));
	}

	open(options: ChromeTabOptions): ChromeTab {
		const id = `${CHROME_PAGE_PREFIX}${this._next++}`;
		const tab = new ChromeTab(id, this._host, this._extensionUri, this._log, this._bookmarks, options);
		this._tabs.set(id, tab);
		tab.onDidDispose(() => this._tabs.delete(id));
		return tab;
	}

	get(id: string): ChromeTab | undefined {
		return this._tabs.get(id);
	}

	list(): ChromeTab[] {
		return [...this._tabs.values()];
	}

	findByPage(page: Page): ChromeTab | undefined {
		return this.list().find(tab => tab.isFor(page));
	}

	closeAll(): void {
		for (const tab of this.list()) {
			tab.dispose();
		}
	}

	dispose(): void {
		this.closeAll();
		for (const d of this._disposables) {
			d.dispose();
		}
	}
}
