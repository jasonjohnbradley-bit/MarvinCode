/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LangfuseClient } from './api';

const SECRET_KEY = 'langfuse.secretKey';
const CONFIG_SECTION = 'langfuse';

export interface LangfuseSettings {
	readonly host: string;
	readonly publicKey: string;
	readonly secretKey: string;
}

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

export function getHost(): string {
	const host = config().get<string>('host', 'https://us.cloud.langfuse.com').trim();
	return host.replace(/\/+$/, '');
}

/** Resolved settings, or undefined when the public/secret keys are not set yet. */
export async function getSettings(secrets: vscode.SecretStorage): Promise<LangfuseSettings | undefined> {
	const publicKey = config().get<string>('publicKey', '').trim();
	const secretKey = (await secrets.get(SECRET_KEY))?.trim();
	if (!publicKey || !secretKey) {
		return undefined;
	}
	return { host: getHost(), publicKey, secretKey };
}

/** Builds an API client from the stored settings, or undefined if not connected. */
export async function getClient(secrets: vscode.SecretStorage): Promise<LangfuseClient | undefined> {
	const settings = await getSettings(secrets);
	return settings ? new LangfuseClient(settings.host, settings.publicKey, settings.secretKey) : undefined;
}

export async function isConnected(secrets: vscode.SecretStorage): Promise<boolean> {
	return (await getSettings(secrets)) !== undefined;
}

/**
 * Interactive credential entry: host → public key → secret key. Verifies the
 * keys against `/health` before persisting (host + public key to settings, the
 * secret key to the OS keychain). Returns true on success.
 */
export async function setKeys(secrets: vscode.SecretStorage): Promise<boolean> {
	const host = (await vscode.window.showInputBox({
		title: vscode.l10n.t('Langfuse Host'),
		prompt: vscode.l10n.t('Base URL of your Langfuse instance'),
		value: getHost(),
		ignoreFocusOut: true,
		validateInput: value => /^https?:\/\/.+/.test(value.trim()) ? undefined : vscode.l10n.t('Enter a URL starting with http(s)://'),
	}))?.trim();
	if (!host) {
		return false;
	}

	const publicKey = (await vscode.window.showInputBox({
		title: vscode.l10n.t('Langfuse Public Key'),
		prompt: vscode.l10n.t('From Langfuse → Settings → API Keys'),
		placeHolder: 'pk-lf-…',
		value: config().get<string>('publicKey', ''),
		ignoreFocusOut: true,
		validateInput: value => value.trim().length > 0 ? undefined : vscode.l10n.t('Public key is required'),
	}))?.trim();
	if (!publicKey) {
		return false;
	}

	const secretKey = (await vscode.window.showInputBox({
		title: vscode.l10n.t('Langfuse Secret Key'),
		prompt: vscode.l10n.t('Stored securely in the OS keychain'),
		placeHolder: 'sk-lf-…',
		password: true,
		ignoreFocusOut: true,
		validateInput: value => value.trim().length > 0 ? undefined : vscode.l10n.t('Secret key is required'),
	}))?.trim();
	if (!secretKey) {
		return false;
	}

	const normalizedHost = host.replace(/\/+$/, '');
	const verified = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting to Langfuse…') },
		async () => {
			try {
				await new LangfuseClient(normalizedHost, publicKey, secretKey).health();
				return true;
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Langfuse connection failed: {0}', err instanceof Error ? err.message : String(err)));
				return false;
			}
		});
	if (!verified) {
		return false;
	}

	await config().update('host', normalizedHost, vscode.ConfigurationTarget.Global);
	await config().update('publicKey', publicKey, vscode.ConfigurationTarget.Global);
	await secrets.store(SECRET_KEY, secretKey);
	void vscode.window.showInformationMessage(vscode.l10n.t('Connected to Langfuse.'));
	return true;
}

/** Clears the secret key and public key. */
export async function disconnect(secrets: vscode.SecretStorage): Promise<void> {
	await secrets.delete(SECRET_KEY);
	await config().update('publicKey', '', vscode.ConfigurationTarget.Global);
}
