/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// `marvincode.chrome.*` commands for the claude-bridge extension (vscode-bridge MCP).
// Same shapes and consent model as `marvincode.browser.*` in
// src/vs/workbench/contrib/marvinBridge: pages an agent opens are shared with it
// (the MCP permission prompt is the consent); a page the user opened must be
// shared first. The difference is the session — these pages are signed in as the
// user through device SSO, which the share dialog says.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Locator, Page } from 'playwright-core';
import type { ChromeTab } from './chromeTab';
import { agentUrlBlockedReason } from './networkFilter';
import type { ChromeTabs } from './tabs';

interface AiSnapshotPage {
	ariaSnapshot(options: { mode: 'ai' }): Promise<string>;
}

interface PageInfo {
	id: string;
	url: string;
	title: string;
	shared: boolean;
}

interface Interaction {
	result?: unknown;
	error?: string;
	summary: string;
}

const ACTION_TIMEOUT = 10000;

function sameHost(a: string, b: string): boolean {
	try {
		return new URL(a).host === new URL(b).host;
	} catch {
		return false;
	}
}

function checkUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Not a valid absolute URL: ${url}`);
	}
	const blocked = agentUrlBlockedReason(parsed.href);
	if (blocked) {
		throw new Error(blocked);
	}
	return parsed.href;
}

async function settle(page: Page): Promise<void> {
	await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
	// Single-page apps navigate without a new document; give their requests a moment.
	await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
}

// Evaluated in each frame as a string: the extension compiles without the DOM lib.
const PASSWORD_VALUES = `[...document.querySelectorAll('input[type=password]')].map(i => i.value).filter(v => v)`;
const MASK = '••••••••';

async function passwordValues(page: Page): Promise<Set<string>> {
	const values = new Set<string>();
	for (const frame of page.frames()) {
		const found = await frame.evaluate(PASSWORD_VALUES).catch(() => []) as string[];
		for (const value of found) {
			values.add(value);
		}
	}
	return values;
}

/**
 * The aria snapshot prints a textbox's value even for a password field, so a page
 * shared after the user typed a password would hand it to the agent. Mask the value
 * of any textbox line that holds the current value of a password field.
 */
function maskPasswords(snapshot: string, secrets: ReadonlySet<string>): string {
	if (secrets.size === 0) {
		return snapshot;
	}
	return snapshot.split('\n').map(line => {
		const match = /^(?<head>\s*- textbox\b.*\[ref=[^\]]+\][^:]*: )(?<value>.*)$/.exec(line);
		if (!match?.groups) {
			return line;
		}
		let value = match.groups.value;
		if (/^".*"$/.test(value)) {
			try {
				value = JSON.parse(value);
			} catch {
				// Not a JSON-quoted value; compare it as printed.
			}
		}
		return secrets.has(value) ? `${match.groups.head}${MASK}` : line;
	}).join('\n');
}

async function summary(tab: ChromeTab): Promise<string> {
	const page = await tab.page();
	const url = page.url();
	// Like the Integrated Browser: a page on a blocked domain returns only the
	// policy error, so blocked content cannot reach the agent.
	const blocked = /^https?:/.test(url) ? agentUrlBlockedReason(url) : undefined;
	if (blocked) {
		return blocked;
	}
	const title = await page.title().catch(() => '');
	const raw = await (page as unknown as AiSnapshotPage).ariaSnapshot({ mode: 'ai' }).catch(() => undefined);
	const snapshot = raw === undefined ? undefined : maskPasswords(raw, await passwordValues(page));
	return [
		...(title ? [`Page Title: ${title}`] : []),
		`URL: ${url}`,
		...(tab.dialogLine ? [tab.dialogLine] : []),
		`Snapshot: ${snapshot === undefined ? '<unavailable>' : `\n${snapshot.trim()}`}`,
	].join('\n');
}

export function registerAgentCommands(context: vscode.ExtensionContext, tabs: ChromeTabs): void {
	const resolve = (pageId: string): ChromeTab => {
		const tab = tabs.get(pageId);
		if (!tab) {
			throw new Error(`No Chrome page with id '${pageId}'. Use marvincode.chrome.listPages to see the open pages.`);
		}
		return tab;
	};
	const requireShared = (pageId: string): ChromeTab => {
		const tab = resolve(pageId);
		if (!tab.shared) {
			throw new Error(`Chrome page '${pageId}' is not shared with agents. Ask the user to click Share with Agent in the Chrome Tab toolbar, or call shareBrowserPage (the user will be asked).`);
		}
		return tab;
	};
	const locate = (page: Page, args: { ref?: string; selector?: string }): Locator | undefined => {
		const selector = args.ref ? `aria-ref=${args.ref}` : args.selector;
		return selector ? page.locator(selector) : undefined;
	};
	const interact = async (tab: ChromeTab, action: (page: Page) => Promise<unknown>): Promise<Interaction> => {
		const page = await tab.page();
		let result: unknown;
		let error: string | undefined;
		try {
			result = await action(page);
			await settle(page);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		return { ...(result === undefined ? {} : { result }), ...(error ? { error } : {}), summary: await summary(tab) };
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('marvincode.chrome.listPages', (): { pages: PageInfo[] } => ({
			pages: tabs.list().map(tab => ({ id: tab.id, url: tab.url || 'about:blank', title: tab.title, shared: tab.shared })),
		})),

		vscode.commands.registerCommand('marvincode.chrome.open', async (args: { url: string; forceNew?: boolean }) => {
			const url = checkUrl(args.url);
			if (!args.forceNew) {
				const existing = tabs.list().find(tab => tab.shared && sameHost(tab.url, url));
				if (existing) {
					return { pageId: existing.id, summary: await summary(existing), reused: true };
				}
			}
			const tab = tabs.open({ url, shared: true, preserveFocus: true });
			const page = await tab.page();
			// Device-SSO sign-in bounces through login.microsoftonline.com before
			// settling, so wait for the final page rather than the first commit.
			await page.waitForLoadState('load', { timeout: 15000 }).catch(() => undefined);
			await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
			return { pageId: tab.id, summary: await summary(tab), reused: false };
		}),

		vscode.commands.registerCommand('marvincode.chrome.share', async (args: { pageId: string }) => {
			return { shared: await resolve(args.pageId).requestShare(true) };
		}),

		vscode.commands.registerCommand('marvincode.chrome.read', async (args: { pageId: string }) => {
			return { summary: await summary(requireShared(args.pageId)) };
		}),

		vscode.commands.registerCommand('marvincode.chrome.screenshot', async (args: { pageId: string; ref?: string; selector?: string }) => {
			const page = await requireShared(args.pageId).page();
			const locator = locate(page, args);
			const options = { type: 'jpeg' as const, quality: 80, scale: 'css' as const, timeout: ACTION_TIMEOUT };
			const data = locator ? await locator.screenshot(options) : await page.screenshot(options);
			const target = path.join(os.tmpdir(), `marvincode-chrome-${Math.random().toString(16).slice(2, 10)}.jpg`);
			await fs.promises.writeFile(target, data);
			return { path: target };
		}),

		vscode.commands.registerCommand('marvincode.chrome.navigate', async (args: { pageId: string; url?: string; action?: 'back' | 'forward' | 'reload' }) => {
			const tab = requireShared(args.pageId);
			const page = await tab.page();
			if (args.action === 'reload') {
				await page.reload({ waitUntil: 'domcontentloaded' });
			} else if (args.action === 'back') {
				await page.goBack({ waitUntil: 'domcontentloaded' });
			} else if (args.action === 'forward') {
				await page.goForward({ waitUntil: 'domcontentloaded' });
			} else if (args.url) {
				await page.goto(checkUrl(args.url), { waitUntil: 'domcontentloaded' });
			} else {
				throw new Error('Either "url" or "action" (back | forward | reload) is required.');
			}
			return { summary: await summary(tab) };
		}),

		vscode.commands.registerCommand('marvincode.chrome.click', async (args: { pageId: string; ref?: string; selector?: string; dblClick?: boolean; button?: 'left' | 'right' | 'middle' }) => {
			const tab = requireShared(args.pageId);
			return interact(tab, async page => {
				const locator = locate(page, args);
				if (!locator) {
					throw new Error('Either a "ref" (from read/open snapshots) or "selector" is required.');
				}
				const options = { button: args.button ?? 'left', timeout: ACTION_TIMEOUT };
				await (args.dblClick ? locator.dblclick(options) : locator.click(options));
			});
		}),

		vscode.commands.registerCommand('marvincode.chrome.type', async (args: { pageId: string; ref?: string; selector?: string; text?: string; key?: string; submit?: boolean }) => {
			const tab = requireShared(args.pageId);
			if (!args.text && !args.key) {
				throw new Error('Either a "text" or "key" parameter is required.');
			}
			return interact(tab, async page => {
				const locator = locate(page, args);
				if (args.key) {
					await (locator ? locator.press(args.key, { timeout: ACTION_TIMEOUT }) : page.keyboard.press(args.key));
					return;
				}
				if (locator) {
					await locator.fill(args.text ?? '', { timeout: ACTION_TIMEOUT });
					if (args.submit) {
						await locator.press('Enter', { timeout: ACTION_TIMEOUT });
					}
				} else {
					await page.keyboard.type(args.text ?? '');
					if (args.submit) {
						await page.keyboard.press('Enter');
					}
				}
			});
		}),
	);
}
