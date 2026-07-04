/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IncomingMessage, Server, ServerResponse } from 'http';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentEvent, IAgentGraphFilter, IAgentGraphService, IAgentGraphSnapshot, IAgentSessionSummary } from '../common/agentGraph.js';
import { deriveGraph, normalizeClaudeCodeHook, normalizeCustomEvent } from '../node/agentEventNormalizer.js';
import { AgentGraphStore } from '../node/agentGraphStore.js';
import { linkSessionToTouchedCards } from '../node/kanbanCardLinker.js';

export const IAgentGraphMainService = createDecorator<IAgentGraphMainService>('agentGraphMainService');

export interface IAgentGraphMainService extends IAgentGraphService { }

const DEFAULT_INGEST_PORT = 48620;

/**
 * Owns the agent-event SQLite store and a localhost HTTP listener that
 * external agents (Claude Code hooks, custom agents) POST events to.
 * Lives in the main process so one writer serves every window.
 */
export class AgentGraphMainService extends Disposable implements IAgentGraphMainService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidIngest = this._register(new Emitter<IAgentEvent>());
	readonly onDidIngest: Event<IAgentEvent> = this._onDidIngest.event;

	private readonly store: AgentGraphStore;
	private server: Server | undefined;
	private readonly queue: IAgentEvent[] = [];
	private flushing = false;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this.store = new AgentGraphStore(join(environmentMainService.userDataPath, 'agentGraph', 'events.db'));
		this.startServer();
	}

	private async startServer(): Promise<void> {
		const { createServer } = await import('http');
		const port = this.configurationService.getValue<number>('agentGraph.ingestPort') || DEFAULT_INGEST_PORT;
		const server = createServer((req, res) => this.handleRequest(req, res));
		server.on('error', error => {
			this.logService.error(`[agentGraph] ingest server failed to listen on 127.0.0.1:${port}`, error);
		});
		server.listen(port, '127.0.0.1', () => {
			this.logService.info(`[agentGraph] ingest server listening on 127.0.0.1:${port}`);
		});
		this.server = server;
		this._register({ dispose: () => this.server?.close() });
	}

	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== 'POST' || req.url !== '/ingest') {
			res.statusCode = 404;
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > 1024 * 1024) {
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			// Reply immediately: ingest must never slow the sender down
			res.statusCode = 204;
			res.end();
			try {
				const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
				const now = Date.now();
				const event = raw['hook_event_name'] !== undefined
					? normalizeClaudeCodeHook(raw, now)
					: normalizeCustomEvent(raw, now);
				if (event) {
					this.enqueue(event);
				}
			} catch (error) {
				this.logService.warn('[agentGraph] dropped malformed ingest payload', error);
			}
		});
	}

	private enqueue(event: IAgentEvent): void {
		this.queue.push(event);
		this.flush();
	}

	private async flush(): Promise<void> {
		if (this.flushing) {
			return;
		}
		this.flushing = true;
		try {
			while (this.queue.length > 0) {
				const event = this.queue.shift()!;
				const { nodes, edges } = deriveGraph(event);
				try {
					await this.store.insert(event, nodes, edges);
					this._onDidIngest.fire(event);
				} catch (error) {
					this.logService.error('[agentGraph] failed to store event', error);
				}
				try {
					await linkSessionToTouchedCards(event);
				} catch (error) {
					this.logService.trace('[agentGraph] failed to link session to card', error);
				}
			}
		} finally {
			this.flushing = false;
		}
	}

	async ingestEvent(event: IAgentEvent): Promise<void> {
		this.enqueue(event);
	}

	getRecentEvents(limit: number, filter?: IAgentGraphFilter): Promise<IAgentEvent[]> {
		return this.store.getRecentEvents(limit, filter);
	}

	getSessions(): Promise<IAgentSessionSummary[]> {
		return this.store.getSessions();
	}

	getGraph(filter?: IAgentGraphFilter): Promise<IAgentGraphSnapshot> {
		return this.store.getGraph(filter);
	}
}
