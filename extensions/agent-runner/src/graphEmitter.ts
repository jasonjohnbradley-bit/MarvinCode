/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface AgentGraphObject {
	readonly type: 'file' | 'command' | 'tool' | 'task' | 'url';
	readonly key: string;
	readonly label: string;
}

export interface AgentGraphEvent {
	readonly sessionId: string;
	readonly promptId?: string;
	readonly actor: string;
	readonly verb: string;
	readonly objects: readonly AgentGraphObject[];
	readonly ok?: boolean;
	readonly durationMs?: number;
	readonly payload?: unknown;
}

/**
 * Fire-and-forget emitter that POSTs normalized events to the Agent Graph
 * ingest endpoint hosted by the main process. Failures are swallowed: the
 * graph is an observer, never a dependency.
 */
export class GraphEmitter {

	private get endpoint(): string {
		const port = vscode.workspace.getConfiguration('agentGraph').get<number>('ingestPort', 48620);
		return `http://127.0.0.1:${port}/ingest`;
	}

	async emit(event: AgentGraphEvent): Promise<void> {
		try {
			await fetch(this.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(event)
			});
		} catch {
			// MarvinCode's ingest server is not reachable — drop silently
		}
	}
}
