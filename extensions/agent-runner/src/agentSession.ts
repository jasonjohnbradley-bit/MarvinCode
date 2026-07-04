/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GraphEmitter } from './graphEmitter';

/**
 * Placeholder for the future embedded agent. When the Claude Agent SDK
 * lands, the wiring looks like this (dependency deliberately not added yet):
 *
 * ```ts
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 *
 * export async function runAgentSession(prompt: string, emitter: GraphEmitter): Promise<void> {
 * 	const sessionId = crypto.randomUUID();
 * 	await emitter.emit({ sessionId, actor: 'marvin-agent', verb: 'session.start', objects: [] });
 * 	for await (const message of query({
 * 		prompt,
 * 		options: {
 * 			hooks: {
 * 				PostToolUse: [{
 * 					hooks: [async input => {
 * 						await emitter.emit({
 * 							sessionId,
 * 							actor: 'marvin-agent',
 * 							verb: 'tool.end',
 * 							objects: [{ type: 'tool', key: String(input.tool_name), label: String(input.tool_name) }]
 * 						});
 * 						return {};
 * 					}]
 * 				}]
 * 			}
 * 		}
 * 	})) {
 * 		// stream handling
 * 	}
 * 	await emitter.emit({ sessionId, actor: 'marvin-agent', verb: 'session.end', objects: [] });
 * }
 * ```
 */

/** Emits a synthetic session proving the custom-agent → graph path end to end. */
export async function runStubSession(emitter: GraphEmitter): Promise<string> {
	const sessionId = `stub-${Date.now().toString(36)}`;
	const promptId = `${sessionId}-prompt`;
	await emitter.emit({ sessionId, actor: 'marvin-agent', verb: 'session.start', objects: [] });
	await emitter.emit({ sessionId, promptId, actor: 'marvin-agent', verb: 'prompt.submit', objects: [] });
	await emitter.emit({
		sessionId, promptId, actor: 'marvin-agent', verb: 'tool.end', ok: true, durationMs: 120,
		objects: [
			{ type: 'tool', key: 'stub_read', label: 'stub_read' },
			{ type: 'file', key: 'C:/Users/jason/dev/kanban-test/.kanban/board.json', label: 'board.json' }
		]
	});
	await emitter.emit({
		sessionId, promptId, actor: 'marvin-agent', verb: 'command.run', ok: true, durationMs: 340,
		objects: [
			{ type: 'tool', key: 'stub_terminal', label: 'stub_terminal' },
			{ type: 'command', key: 'echo hello from the custom agent', label: 'echo hello from the custom agent' }
		]
	});
	await emitter.emit({ sessionId, actor: 'marvin-agent', verb: 'session.end', objects: [] });
	return sessionId;
}
