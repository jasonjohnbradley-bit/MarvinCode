/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type {
	CloseSimpleBrowserOutputT,
	ListSimpleBrowserTabsOutputT,
	OpenSimpleBrowserOutputT,
} from './shared/schema';

const SIMPLE_BROWSER_VIEW_TYPE = 'mainThreadWebview-simpleBrowser.view';

export class SimpleBrowserTracker implements vscode.Disposable {
	private readonly urls = new WeakMap<vscode.Tab, string>();
	private readonly disposable: vscode.Disposable;

	constructor() {
		this.disposable = vscode.window.tabGroups.onDidChangeTabs(e => {
			for (const tab of e.closed) {
				this.urls.delete(tab);
			}
		});
	}

	dispose(): void {
		this.disposable.dispose();
	}

	async open(url: string, reuse: boolean): Promise<OpenSimpleBrowserOutputT> {
		if (reuse) {
			const existing = this.findSimpleBrowserTabs();
			const toClose = existing.slice(1);
			if (toClose.length > 0) {
				await vscode.window.tabGroups.close(toClose, true);
			}
			if (existing.length > 0) {
				const before = existing[0];
				await vscode.commands.executeCommand('simpleBrowser.show', url);
				// simpleBrowser.show may open a fresh tab; if so, drop the previous tracked entry
				const after = this.findSimpleBrowserTabs();
				for (const t of after) {
					this.urls.set(t, url);
				}
				if (!after.includes(before)) {
					try {
						await vscode.window.tabGroups.close(before, true);
					} catch {
						// ignore
					}
				}
				return { url, reused: true };
			}
		}

		const before = new Set(this.findSimpleBrowserTabs());
		await vscode.commands.executeCommand('simpleBrowser.show', url);
		const after = this.findSimpleBrowserTabs();
		const newTabs = after.filter(t => !before.has(t));
		if (newTabs.length === 0 && after.length > 0) {
			// command reused an existing tab without us asking — record on the active one
			const active = after.find(t => t.isActive) ?? after[0];
			this.urls.set(active, url);
			return { url, reused: true };
		}
		for (const t of newTabs) {
			this.urls.set(t, url);
		}
		return { url, reused: false };
	}

	list(): ListSimpleBrowserTabsOutputT['tabs'] {
		const out: ListSimpleBrowserTabsOutputT['tabs'] = [];
		for (const tab of this.findSimpleBrowserTabs()) {
			const url = this.urls.get(tab);
			out.push({
				url: url ?? null,
				label: tab.label,
				isActive: tab.isActive,
				tracked: url !== undefined,
			});
		}
		return out;
	}

	async close(all: boolean): Promise<CloseSimpleBrowserOutputT> {
		const tabs = this.findSimpleBrowserTabs();
		if (tabs.length === 0) {
			return { closed: 0 };
		}
		const targets = all ? tabs : [tabs.find(t => t.isActive) ?? tabs[0]];
		await vscode.window.tabGroups.close(targets, true);
		return { closed: targets.length };
	}

	private findSimpleBrowserTabs(): vscode.Tab[] {
		const out: vscode.Tab[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input;
				if (input instanceof vscode.TabInputWebview && input.viewType === SIMPLE_BROWSER_VIEW_TYPE) {
					out.push(tab);
				}
			}
		}
		return out;
	}
}
