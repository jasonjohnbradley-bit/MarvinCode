/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { bridgeRuntimeDir, defaultSocketPath, socketPathFor } from '../shared/socketPath';
import { frame, parseFrames, Response as ResponseSchema } from '../shared/wire';

export class CallError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
	}
}

interface CallOpts {
	cwd: string;
	timeoutMs?: number;
}

export async function callBridge(tool: string, args: unknown, opts: CallOpts): Promise<unknown> {
	const socketPath = resolveSocketPath(opts.cwd);
	if (!socketPath) {
		throw new CallError(
			'NO_SOCKET',
			'No Claude Bridge socket found. Open MarvinCode with a workspace — the built-in Claude Bridge extension starts automatically.'
		);
	}

	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const sock = net.createConnection(socketPath);
		let buffer = '';
		const timeoutMs = opts.timeoutMs ?? 60_000;
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new CallError('TIMEOUT', `bridge call timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		sock.on('connect', () => {
			sock.write(frame({ id, tool, args }));
		});
		sock.setEncoding('utf8');
		sock.on('data', chunk => {
			buffer += chunk;
			const { messages, remainder } = parseFrames(buffer);
			buffer = remainder;
			for (const msg of messages) {
				const parsed = ResponseSchema.safeParse(msg);
				if (!parsed.success || parsed.data.id !== id) {
					continue;
				}
				clearTimeout(timer);
				sock.end();
				if (parsed.data.ok) {
					resolve(parsed.data.result);
				} else {
					reject(new CallError(parsed.data.error.code, parsed.data.error.message));
				}
				return;
			}
		});
		sock.on('error', err => {
			clearTimeout(timer);
			reject(new CallError((err as NodeJS.ErrnoException).code ?? 'SOCKET_ERROR', err.message));
		});
		sock.on('close', () => {
			clearTimeout(timer);
		});
	});
}

function resolveSocketPath(cwd: string): string | null {
	// 1) Exact workspace-hash match
	const exact = socketPathFor(cwd);
	if (isLiveSocket(exact)) {
		return exact;
	}

	// 2) Walk up parents looking for a workspace whose hash matches a live socket
	let parent = path.dirname(path.resolve(cwd));
	while (parent !== path.dirname(parent)) {
		const candidate = socketPathFor(parent);
		if (isLiveSocket(candidate)) {
			return candidate;
		}
		parent = path.dirname(parent);
	}

	// 3) Scan lockfiles for a workspaceRoot that is a prefix of cwd (longest wins)
	const runtimeDir = bridgeRuntimeDir();
	let bestMatch: { socket: string; rootLength: number } | null = null;
	try {
		for (const entry of fs.readdirSync(runtimeDir)) {
			if (!entry.endsWith('.lock.json')) {
				continue;
			}
			try {
				const lock = JSON.parse(fs.readFileSync(path.join(runtimeDir, entry), 'utf8')) as {
					socketPath?: string;
					workspaceRoot?: string;
				};
				if (!lock.socketPath || !lock.workspaceRoot) {
					continue;
				}
				const root = path.resolve(lock.workspaceRoot);
				if ((cwd === root || cwd.startsWith(root + path.sep)) && (!bestMatch || root.length > bestMatch.rootLength)) {
					if (isLiveSocket(lock.socketPath)) {
						bestMatch = { socket: lock.socketPath, rootLength: root.length };
					}
				}
			} catch {
				// ignore broken lock entries
			}
		}
	} catch {
		// runtime dir does not exist yet
	}
	if (bestMatch) {
		return bestMatch.socket;
	}

	// 4) Fallback: default.sock (most recently activated window)
	const def = defaultSocketPath();
	return isLiveSocket(def) ? def : null;
}

function isLiveSocket(p: string): boolean {
	try {
		return fs.statSync(p).isSocket();
	} catch {
		return false;
	}
}
