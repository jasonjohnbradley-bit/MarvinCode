/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { register, remarkable, RemarkableApi } from 'rmapi-js';
import * as vscode from 'vscode';

const SECRET_KEY = 'kanban.remarkable.deviceToken';
const PAIRING_URL = 'https://my.remarkable.com/device/browser/connect';
const LEGACY_PROFILE = path.join(os.homedir(), '.config', 'agentic-kanban', 'profile.json');

export interface RemarkableDoc {
	readonly id: string;
	readonly hash: string;
	readonly name: string;
	readonly folder: string;
	readonly fileType: string;
	readonly lastModified: string;
	readonly pinned: boolean;
}

let cachedToken: string | undefined;
let cachedApi: RemarkableApi | undefined;

async function getApi(deviceToken: string): Promise<RemarkableApi> {
	if (cachedApi && cachedToken === deviceToken) {
		return cachedApi;
	}
	cachedApi = await remarkable(deviceToken);
	cachedToken = deviceToken;
	return cachedApi;
}

/** Migrates the device token from the old agentic-kanban profile, if present. */
async function migrateLegacyToken(secrets: vscode.SecretStorage): Promise<string | undefined> {
	try {
		const profile = JSON.parse(fs.readFileSync(LEGACY_PROFILE, 'utf8'));
		const token = profile?.remarkable_cloud?.device_token;
		if (typeof token === 'string' && token.length > 50) {
			// Prove the token still works before adopting it
			await getApi(token);
			await secrets.store(SECRET_KEY, token);
			void vscode.window.showInformationMessage(vscode.l10n.t('reMarkable: reused the device registration from agentic-kanban (moved into the OS keychain).'));
			return token;
		}
	} catch {
		// No legacy profile, or the old token no longer works — pair fresh
	}
	return undefined;
}

/** Interactive pairing: one-time code from my.remarkable.com. */
export async function pairRemarkable(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const open = vscode.l10n.t('Open Pairing Page');
	const answer = await vscode.window.showInformationMessage(
		vscode.l10n.t('Pair with reMarkable: get a one-time code from my.remarkable.com, then enter it here.'),
		{ modal: true, detail: PAIRING_URL },
		open, vscode.l10n.t('Enter Code'));
	if (!answer) {
		return undefined;
	}
	if (answer === open) {
		await vscode.env.openExternal(vscode.Uri.parse(PAIRING_URL));
	}
	const code = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('One-time connect code (8 characters)'),
		placeHolder: 'e.g. apwngead',
		ignoreFocusOut: true,
		validateInput: value => /^[a-z]{8,12}$/i.test(value.trim()) ? undefined : vscode.l10n.t('Codes are 8-12 letters')
	});
	if (!code) {
		return undefined;
	}
	try {
		const token = await register(code.trim().toLowerCase());
		await secrets.store(SECRET_KEY, token);
		cachedApi = undefined;
		cachedToken = undefined;
		void vscode.window.showInformationMessage(vscode.l10n.t('reMarkable paired — the device token is stored in the OS keychain.'));
		return token;
	} catch (error) {
		void vscode.window.showErrorMessage(vscode.l10n.t('reMarkable pairing failed: {0}', error instanceof Error ? error.message : String(error)));
		return undefined;
	}
}

/** Stored token → legacy migration → interactive pairing, in that order. */
export async function ensureRemarkable(secrets: vscode.SecretStorage): Promise<RemarkableApi | undefined> {
	let token = await secrets.get(SECRET_KEY);
	if (!token) {
		token = await migrateLegacyToken(secrets);
	}
	if (!token) {
		token = await pairRemarkable(secrets);
	}
	if (!token) {
		return undefined;
	}
	try {
		return await getApi(token);
	} catch (error) {
		void vscode.window.showErrorMessage(vscode.l10n.t('reMarkable connection failed (try "Kanban: Connect to reMarkable" to re-pair): {0}', error instanceof Error ? error.message : String(error)));
		return undefined;
	}
}

/** All documents (newest first) with their folder paths resolved. */
export async function listDocuments(api: RemarkableApi): Promise<RemarkableDoc[]> {
	const items = await api.listItems();
	const folderNames = new Map<string, { name: string; parent: string }>();
	for (const item of items) {
		if (item.type === 'CollectionType') {
			folderNames.set(item.id, { name: item.visibleName, parent: item.parent ?? '' });
		}
	}
	const folderPath = (parent: string | undefined): string => {
		const parts: string[] = [];
		let current = parent ?? '';
		while (current && current !== 'trash' && folderNames.has(current)) {
			const folder = folderNames.get(current)!;
			parts.unshift(folder.name);
			current = folder.parent;
		}
		return parts.join(' / ');
	};
	return items
		.filter(item => item.type === 'DocumentType' && item.parent !== 'trash')
		.map(item => ({
			id: item.id,
			hash: item.hash,
			name: item.visibleName,
			folder: folderPath(item.parent),
			fileType: (item as { fileType?: string }).fileType ?? 'notebook',
			lastModified: item.lastModified,
			pinned: item.pinned
		}))
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastModified.localeCompare(a.lastModified));
}

/** Formats a reMarkable lastModified value (ISO string or epoch seconds/ms string). */
export function formatRmDate(value: string): string {
	if (/^\d+$/.test(value)) {
		const n = Number(value);
		return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

/**
 * Fetches the document's embedded input PDF (imported/annotated PDFs and
 * epub-less documents) to a temp file. Throws for pure handwritten
 * notebooks, which have no .pdf entry — callers fall back to page
 * rendering.
 */
export async function downloadPdf(api: RemarkableApi, doc: RemarkableDoc): Promise<string> {
	const bytes = await api.getPdf(doc.id, doc.hash);
	if (!bytes || !bytes.length) {
		throw new Error(vscode.l10n.t('"{0}" has no embedded PDF.', doc.name));
	}
	const file = path.join(os.tmpdir(), `marvincode-remarkable-${doc.id.slice(0, 8)}.pdf`);
	fs.writeFileSync(file, Buffer.from(bytes));
	return file;
}
