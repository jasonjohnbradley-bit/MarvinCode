/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Keeps the exact runtime-dir and per-workspace socket layout of the original
// claude-vscode-bridge repo, so existing MCP clients keep resolving sockets.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const DIR_NAME = 'claude-vscode-bridge';

export function bridgeRuntimeDir(): string {
	const xdg = process.env.XDG_RUNTIME_DIR;
	const base = xdg && xdg.length > 0 ? xdg : tmpdir();
	const dir = path.join(base, DIR_NAME);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	return dir;
}

export function workspaceHash(workspaceRoot: string): string {
	return createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16);
}

export function socketPathFor(workspaceRoot: string): string {
	return path.join(bridgeRuntimeDir(), `${workspaceHash(workspaceRoot)}.sock`);
}

export function lockPathFor(workspaceRoot: string): string {
	return path.join(bridgeRuntimeDir(), `${workspaceHash(workspaceRoot)}.lock.json`);
}

export function defaultSocketPath(): string {
	return path.join(bridgeRuntimeDir(), 'default.sock');
}

export function isSocketLive(socketPath: string): boolean {
	try {
		const s = statSync(socketPath);
		return s.isSocket();
	} catch {
		return false;
	}
}
