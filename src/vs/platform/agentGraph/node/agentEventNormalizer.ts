/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../base/common/uuid.js';
import { AgentEventVerb, IAgentEvent, IAgentEventObject, IAgentGraphEdge, IAgentGraphNode } from '../common/agentGraph.js';

const KANBAN_CARD_PATTERN = /\/\.kanban\/cards\/([\w.-]+)\.md$/;

/**
 * When a file object points at a Kanban card, contribute a task object so
 * the card shows up in the graph and can be linked back to the session.
 */
export function addKanbanTaskObjects(objects: IAgentEventObject[]): void {
	for (const object of [...objects]) {
		if (object.type === 'file') {
			const match = KANBAN_CARD_PATTERN.exec(object.key);
			if (match && !objects.some(existing => existing.type === 'task' && existing.key === match[1])) {
				objects.push({ type: 'task', key: match[1], label: `card ${match[1]}` });
			}
		}
	}
}

/**
 * Maps a Claude Code hook payload (https://code.claude.com/docs/en/hooks)
 * to the normalized event shape, or undefined for hook events we ignore.
 */
export function normalizeClaudeCodeHook(raw: Record<string, unknown>, now: number): IAgentEvent | undefined {
	const hookEvent = typeof raw['hook_event_name'] === 'string' ? raw['hook_event_name'] : undefined;
	const sessionId = typeof raw['session_id'] === 'string' ? raw['session_id'] : undefined;
	if (!hookEvent || !sessionId) {
		return undefined;
	}

	let verb: AgentEventVerb;
	let ok: boolean | undefined;
	switch (hookEvent) {
		case 'SessionStart':
		case 'SubagentStart':
			verb = 'session.start';
			break;
		case 'SessionEnd':
		case 'SubagentStop':
			verb = 'session.end';
			break;
		case 'UserPromptSubmit':
			verb = 'prompt.submit';
			break;
		case 'PreToolUse':
			verb = 'tool.start';
			break;
		case 'PostToolUse':
			verb = 'tool.end';
			ok = true;
			break;
		case 'PostToolUseFailure':
			verb = 'tool.end';
			ok = false;
			break;
		case 'TaskCreated':
			verb = 'task.create';
			break;
		case 'TaskCompleted':
			verb = 'task.complete';
			break;
		default:
			return undefined;
	}

	const toolName = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : undefined;
	const toolInput = raw['tool_input'] && typeof raw['tool_input'] === 'object' ? raw['tool_input'] as Record<string, unknown> : undefined;
	const objects: IAgentEventObject[] = [];
	if (toolName) {
		objects.push({ type: 'tool', key: toolName, label: toolName });
		const filePath = typeof toolInput?.['file_path'] === 'string' ? toolInput['file_path'] as string : undefined;
		if (filePath) {
			const isWrite = /^(Write|Edit|NotebookEdit|MultiEdit)$/i.test(toolName);
			objects.push({ type: 'file', key: filePath.replace(/\\/g, '/'), label: filePath.replace(/\\/g, '/').split('/').pop() ?? filePath });
			verb = verb === 'tool.end' && isWrite ? 'file.edit' : verb;
		}
		const command = typeof toolInput?.['command'] === 'string' ? toolInput['command'] as string : undefined;
		if (command && /^Bash|PowerShell$/i.test(toolName)) {
			const label = command.length > 80 ? command.slice(0, 77) + '…' : command;
			objects.push({ type: 'command', key: label, label });
		}
	}

	addKanbanTaskObjects(objects);

	const agentType = typeof raw['agent_type'] === 'string' ? raw['agent_type'] as string : undefined;
	return {
		id: generateUuid(),
		ts: now,
		source: 'claude-code',
		sessionId,
		promptId: typeof raw['prompt_id'] === 'string' ? raw['prompt_id'] as string : undefined,
		actor: agentType ? `claude-code:${agentType}` : 'claude-code',
		verb,
		objects,
		ok,
		payload: {
			hookEvent,
			cwd: raw['cwd'],
			toolName,
			prompt: typeof raw['prompt'] === 'string' ? (raw['prompt'] as string).slice(0, 2000) : undefined
		}
	};
}

/** Accepts a pre-normalized event over HTTP (custom agents), validating minimally. */
export function normalizeCustomEvent(raw: Record<string, unknown>, now: number): IAgentEvent | undefined {
	const sessionId = typeof raw['sessionId'] === 'string' ? raw['sessionId'] : undefined;
	const verb = typeof raw['verb'] === 'string' ? raw['verb'] as AgentEventVerb : undefined;
	if (!sessionId || !verb) {
		return undefined;
	}
	return {
		id: typeof raw['id'] === 'string' ? raw['id'] as string : generateUuid(),
		ts: typeof raw['ts'] === 'number' ? raw['ts'] as number : now,
		source: 'custom-agent',
		sessionId,
		promptId: typeof raw['promptId'] === 'string' ? raw['promptId'] as string : undefined,
		actor: typeof raw['actor'] === 'string' ? raw['actor'] as string : 'custom-agent',
		verb,
		objects: Array.isArray(raw['objects']) ? (raw['objects'] as IAgentEventObject[]).filter(o => o && typeof o.key === 'string' && typeof o.type === 'string') : [],
		ok: typeof raw['ok'] === 'boolean' ? raw['ok'] as boolean : undefined,
		durationMs: typeof raw['durationMs'] === 'number' ? raw['durationMs'] as number : undefined,
		payload: raw['payload']
	};
}

/** Derives the graph nodes and edges an event contributes. */
export function deriveGraph(event: IAgentEvent): { nodes: IAgentGraphNode[]; edges: IAgentGraphEdge[] } {
	const nodes: IAgentGraphNode[] = [];
	const edges: IAgentGraphEdge[] = [];
	const sessionKey = event.sessionId;

	nodes.push({ type: 'session', key: sessionKey, label: `${event.source} ${sessionKey.slice(0, 8)}`, firstSeen: event.ts, lastSeen: event.ts });

	if (event.promptId) {
		nodes.push({ type: 'prompt', key: event.promptId, label: `prompt ${event.promptId.slice(0, 8)}`, firstSeen: event.ts, lastSeen: event.ts });
		edges.push({ fromType: 'session', fromKey: sessionKey, toType: 'prompt', toKey: event.promptId, rel: 'submitted', eventId: event.id, ts: event.ts });
	}

	const anchorType = event.promptId ? 'prompt' : 'session';
	const anchorKey = event.promptId ?? sessionKey;
	for (const object of event.objects) {
		nodes.push({ type: object.type, key: object.key, label: object.label, firstSeen: event.ts, lastSeen: event.ts });
		edges.push({ fromType: anchorType, fromKey: anchorKey, toType: object.type, toKey: object.key, rel: event.verb, eventId: event.id, ts: event.ts });
	}

	// Tool → file/command edges make "which tool touched which file" visible
	const tool = event.objects.find(object => object.type === 'tool');
	if (tool) {
		for (const object of event.objects) {
			if (object.type === 'file' || object.type === 'command') {
				edges.push({ fromType: 'tool', fromKey: tool.key, toType: object.type, toKey: object.key, rel: event.verb, eventId: event.id, ts: event.ts });
			}
		}
	}

	// Kanban card links become task-to-task edges so the dependency
	// structure of a board is visible in the graph
	const payload = event.payload as { kanbanLink?: { from?: unknown; to?: unknown; type?: unknown } } | undefined;
	const kanbanLink = payload?.kanbanLink;
	if (kanbanLink && typeof kanbanLink.from === 'string' && typeof kanbanLink.to === 'string' && typeof kanbanLink.type === 'string') {
		for (const key of [kanbanLink.from, kanbanLink.to]) {
			if (!nodes.some(node => node.type === 'task' && node.key === key)) {
				nodes.push({ type: 'task', key, label: `card ${key}`, firstSeen: event.ts, lastSeen: event.ts });
			}
		}
		edges.push({ fromType: 'task', fromKey: kanbanLink.from, toType: 'task', toKey: kanbanLink.to, rel: kanbanLink.type, eventId: event.id, ts: event.ts });
	}
	return { nodes, edges };
}
