/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IAgentGraphService = createDecorator<IAgentGraphService>('agentGraphService');

export type AgentEventSource = 'claude-code' | 'vscode-chat' | 'custom-agent';

export type AgentEventVerb =
	| 'session.start'
	| 'session.end'
	| 'prompt.submit'
	| 'tool.start'
	| 'tool.end'
	| 'file.edit'
	| 'file.read'
	| 'command.run'
	| 'task.create'
	| 'task.complete';

export type AgentGraphNodeType = 'session' | 'prompt' | 'tool' | 'file' | 'command' | 'task' | 'url';

export interface IAgentEventObject {
	readonly type: AgentGraphNodeType;
	readonly key: string;
	readonly label: string;
}

/**
 * The normalized event shape every source (Claude Code hooks, the
 * built-in chat agents, custom agents) is mapped into before storage.
 */
export interface IAgentEvent {
	readonly id: string;
	readonly ts: number;
	readonly source: AgentEventSource;
	readonly sessionId: string;
	readonly promptId?: string;
	readonly actor: string;
	readonly verb: AgentEventVerb;
	readonly objects: readonly IAgentEventObject[];
	readonly ok?: boolean;
	readonly durationMs?: number;
	readonly payload?: unknown;
}

export interface IAgentGraphNode {
	readonly type: AgentGraphNodeType;
	readonly key: string;
	readonly label: string;
	readonly firstSeen: number;
	readonly lastSeen: number;
}

export interface IAgentGraphEdge {
	readonly fromType: AgentGraphNodeType;
	readonly fromKey: string;
	readonly toType: AgentGraphNodeType;
	readonly toKey: string;
	readonly rel: string;
	readonly eventId: string;
	readonly ts: number;
}

export interface IAgentGraphSnapshot {
	readonly nodes: readonly IAgentGraphNode[];
	readonly edges: readonly IAgentGraphEdge[];
}

export interface IAgentSessionSummary {
	readonly sessionId: string;
	readonly source: AgentEventSource;
	readonly firstTs: number;
	readonly lastTs: number;
	readonly eventCount: number;
}

export interface IAgentGraphFilter {
	readonly sessionId?: string;
	readonly sinceTs?: number;
}

export const AGENT_GRAPH_CHANNEL = 'agentGraph';

export interface IAgentGraphService {
	readonly _serviceBrand: undefined;

	/** Fires for every event that was successfully ingested and stored. */
	readonly onDidIngest: Event<IAgentEvent>;

	/** Ingests an already-normalized event (used by in-process sources). */
	ingestEvent(event: IAgentEvent): Promise<void>;

	getRecentEvents(limit: number, filter?: IAgentGraphFilter): Promise<IAgentEvent[]>;
	getSessions(): Promise<IAgentSessionSummary[]>;
	getGraph(filter?: IAgentGraphFilter): Promise<IAgentGraphSnapshot>;
}
