/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import { IWindowsVmConfig } from './config';

export const CONNECTION_NAME = 'Windows VM';

/**
 * Builds the Guacamole json-auth payload for the configured VM connection.
 * See https://guacamole.apache.org/doc/gug/json-auth.html
 */
export function buildPayload(config: IWindowsVmConfig, password: string, rdpOverride?: { hostname: string; port: number }): object {
	const parameters: Record<string, string> = {
		'hostname': rdpOverride?.hostname ?? config.host,
		'port': String(rdpOverride?.port ?? config.rdpPort),
		'username': config.username,
		'password': password,
		'security': config.security,
		'ignore-cert': String(config.ignoreCert),
		'resize-method': config.resizeMethod,
		'color-depth': String(config.colorDepth),
		'enable-font-smoothing': 'true',
	};
	if (config.domain) {
		parameters['domain'] = config.domain;
	}
	return {
		username: config.username || 'user',
		expires: String(Date.now() + config.sessionHours * 3600 * 1000),
		connections: {
			[CONNECTION_NAME]: {
				protocol: 'rdp',
				parameters,
			},
		},
	};
}

/**
 * Signs and encrypts a json-auth payload per the Guacamole spec:
 * HMAC-SHA-256 signature prepended to the UTF-8 JSON, AES-128-CBC with an
 * all-zero IV, base64-encoded. The result is the `data` token.
 */
export function encryptPayload(payload: object, secretKeyHex: string): string {
	const key = Buffer.from(secretKeyHex, 'hex');
	if (key.length !== 16) {
		throw new Error('Guacamole json-auth secret key must be 16 bytes (32 hex digits)');
	}
	const json = Buffer.from(JSON.stringify(payload), 'utf8');
	const signature = crypto.createHmac('sha256', key).update(json).digest();
	const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
	const encrypted = Buffer.concat([cipher.update(Buffer.concat([signature, json])), cipher.final()]);
	return encrypted.toString('base64');
}

/**
 * Returns the URL that logs into the local Guacamole gateway with the given token.
 */
export function buildDesktopUrl(gatewayPort: number, dataToken: string): string {
	return `http://127.0.0.1:${gatewayPort}/guacamole/#/?data=${encodeURIComponent(dataToken)}`;
}

/**
 * Glob used with `workbench.action.browser.open` to reuse an existing desktop tab.
 */
export function buildReuseUrlFilter(gatewayPort: number): string {
	return `http://127.0.0.1:${gatewayPort}/guacamole/**`;
}
