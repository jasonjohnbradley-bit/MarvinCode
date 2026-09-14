/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';

const PASSWORD_SECRET_KEY = 'windowsVm.password';
const JSON_SECRET_KEY = 'windowsVm.jsonSecretKey';

/**
 * Snapshot of all `windowsVm.*` settings relevant to a connection attempt.
 */
export interface IWindowsVmConfig {
	readonly host: string;
	readonly rdpPort: number;
	readonly username: string;
	readonly domain: string;
	readonly security: string;
	readonly ignoreCert: boolean;
	readonly resizeMethod: string;
	readonly colorDepth: number;
	readonly gatewayPort: number;
	readonly sessionHours: number;
	readonly imageTag: string;
	readonly openToSide: boolean;
	readonly sshEnabled: boolean;
	readonly sshUser: string;
	readonly sshPort: number;
}

/**
 * Reads the current `windowsVm.*` configuration.
 */
export function readConfig(): IWindowsVmConfig {
	const config = vscode.workspace.getConfiguration('windowsVm');
	return {
		host: config.get<string>('host', ''),
		rdpPort: config.get<number>('rdpPort', 3389),
		username: config.get<string>('username', ''),
		domain: config.get<string>('domain', ''),
		security: config.get<string>('security', 'nla'),
		ignoreCert: config.get<boolean>('ignoreCert', true),
		resizeMethod: config.get<string>('display.resizeMethod', 'display-update'),
		colorDepth: config.get<number>('display.colorDepth', 24),
		gatewayPort: config.get<number>('gateway.port', 58080),
		sessionHours: config.get<number>('gateway.sessionHours', 24),
		imageTag: config.get<string>('gateway.imageTag', '1.6.0'),
		openToSide: config.get<boolean>('openToSide', false),
		sshEnabled: config.get<boolean>('ssh.enabled', false),
		sshUser: config.get<string>('ssh.user', ''),
		sshPort: config.get<number>('ssh.port', 22),
	};
}

/**
 * Returns the stored VM password, prompting the user (and storing the answer) if missing.
 */
export async function getOrPromptPassword(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const stored = await secrets.get(PASSWORD_SECRET_KEY);
	if (stored) {
		return stored;
	}
	return promptAndStorePassword(secrets);
}

/**
 * Prompts for the VM password and stores it in secret storage.
 */
export async function promptAndStorePassword(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const password = await vscode.window.showInputBox({
		title: vscode.l10n.t('Windows VM Password'),
		prompt: vscode.l10n.t('Password for the RDP session (stored securely in the OS keychain)'),
		password: true,
		ignoreFocusOut: true,
	});
	if (password) {
		await secrets.store(PASSWORD_SECRET_KEY, password);
	}
	return password || undefined;
}

/**
 * Returns the Guacamole json-auth secret key (32 hex digits = 16 bytes), generating it on first use.
 */
export async function getOrCreateJsonSecretKey(secrets: vscode.SecretStorage): Promise<string> {
	const stored = await secrets.get(JSON_SECRET_KEY);
	if (stored) {
		return stored;
	}
	const key = crypto.randomBytes(16).toString('hex');
	await secrets.store(JSON_SECRET_KEY, key);
	return key;
}
