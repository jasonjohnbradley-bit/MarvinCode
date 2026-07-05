/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AgentEventVerb, IAgentEvent, IAgentEventObject, IAgentGraphService } from '../../../../platform/agentGraph/common/agentGraph.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { LanguageModelToolsService } from '../../chat/browser/tools/languageModelToolsService.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IChatEditingService, ModifiedFileEntryState } from '../../chat/common/editing/chatEditingService.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';

const EDIT_TOOL_PATTERN = /edit|write|create_file|apply_patch|replace_string|insert_edit/i;
const TERMINAL_TOOL_PATTERN = /terminal|run_in_terminal|execute/i;

/**
 * Streams the built-in chat/agent stack's activity into the agent graph:
 * prompts via IChatService, tool starts via the public onDidInvokeTool
 * event and tool completions via the fork's onDidFinishTool event on the
 * concrete tools service.
 */
export class ChatAgentGraphListener extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatAgentGraphListener';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IChatService chatService: IChatService,
		@IChatEditingService chatEditingService: IChatEditingService,
		@IAgentGraphService private readonly agentGraphService: IAgentGraphService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Agent file edits carry their accept/reject outcome into the graph
		const entryStates = new Map<string, ModifiedFileEntryState>();
		this._register(autorun(reader => {
			for (const session of chatEditingService.editingSessionsObs.read(reader)) {
				for (const entry of session.entries.read(reader)) {
					const state = entry.state.read(reader);
					if (entryStates.get(entry.entryId) === state) {
						continue;
					}
					entryStates.set(entry.entryId, state);
					if (entryStates.size > 2000) {
						entryStates.clear();
					}
					if (state !== ModifiedFileEntryState.Accepted && state !== ModifiedFileEntryState.Rejected) {
						continue;
					}
					const accepted = state === ModifiedFileEntryState.Accepted;
					const path = entry.modifiedURI.fsPath.replace(/\\/g, '/');
					const objects: IAgentEventObject[] = [{ type: 'file', key: path, label: path.split('/').pop() ?? path }];
					const cardMatch = /\/\.kanban\/cards\/([\w.-]+)\.md$/.exec(path);
					if (cardMatch) {
						objects.push({ type: 'task', key: cardMatch[1], label: `card ${cardMatch[1]}` });
					}
					this.send({
						id: generateUuid(),
						ts: Date.now(),
						source: 'vscode-chat',
						sessionId: session.chatSessionResource.toString(),
						promptId: entry.lastModifyingRequestId,
						actor: 'vscode-chat',
						verb: 'file.edit',
						objects,
						ok: accepted,
						payload: { editState: accepted ? 'accepted' : 'rejected' }
					});
				}
			}
		}));

		this._register(chatService.onDidSubmitRequest(e => {
			try {
				const sessionId = e.chatSessionResource?.toString() ?? 'vscode-chat-unknown';
				this.send({
					id: generateUuid(),
					ts: Date.now(),
					source: 'vscode-chat',
					sessionId,
					actor: 'vscode-chat',
					verb: 'prompt.submit',
					objects: []
				});
			} catch (error) {
				this.logService.trace('[agentGraph] failed to record chat request', error);
			}
		}));

		this._register(toolsService.onDidInvokeTool(e => {
			try {
				this.send({
					id: generateUuid(),
					ts: Date.now(),
					source: 'vscode-chat',
					sessionId: e.sessionResource?.toString() ?? 'vscode-chat-unknown',
					promptId: e.requestId,
					actor: 'vscode-chat',
					verb: 'tool.start',
					objects: [{ type: 'tool', key: e.toolId, label: e.toolId }]
				});
			} catch (error) {
				this.logService.trace('[agentGraph] failed to record tool start', error);
			}
		}));

		if (toolsService instanceof LanguageModelToolsService) {
			this._register(toolsService.onDidFinishTool(e => {
				try {
					const objects: IAgentEventObject[] = [{ type: 'tool', key: e.toolId, label: e.toolId }];
					let verb: AgentEventVerb = 'tool.end';
					const parameters = e.parameters && typeof e.parameters === 'object' ? e.parameters as Record<string, unknown> : undefined;

					const filePath = [parameters?.['filePath'], parameters?.['file_path'], parameters?.['path'], parameters?.['uri']]
						.find((value): value is string => typeof value === 'string');
					if (filePath) {
						const normalized = filePath.replace(/\\/g, '/');
						objects.push({ type: 'file', key: normalized, label: normalized.split('/').pop() ?? normalized });
						if (EDIT_TOOL_PATTERN.test(e.toolId)) {
							verb = 'file.edit';
						}
						const cardMatch = /\/\.kanban\/cards\/([\w.-]+)\.md$/.exec(normalized);
						if (cardMatch) {
							objects.push({ type: 'task', key: cardMatch[1], label: `card ${cardMatch[1]}` });
						}
					}
					const command = typeof parameters?.['command'] === 'string' ? parameters['command'] as string : undefined;
					if (command && TERMINAL_TOOL_PATTERN.test(e.toolId)) {
						const label = command.length > 80 ? command.slice(0, 77) + '…' : command;
						objects.push({ type: 'command', key: label, label });
						verb = 'command.run';
					}

					// The kanban extension's LM tools carry card ids in their
					// parameters — surface them as task nodes, and successful
					// links as card-to-card edges (via the payload).
					let payload: Record<string, unknown> | undefined;
					if (e.toolId.startsWith('kanban_')) {
						for (const key of ['cardId', 'fromCard', 'toCard']) {
							const value = parameters?.[key];
							if (typeof value === 'string' && !objects.some(o => o.type === 'task' && o.key === value)) {
								objects.push({ type: 'task', key: value, label: `card ${value}` });
							}
						}
						if (e.toolId === 'kanban_create_card' && e.ok) {
							verb = 'task.create';
						}
						if (e.toolId === 'kanban_link_cards' && e.ok
							&& typeof parameters?.['fromCard'] === 'string'
							&& typeof parameters?.['toCard'] === 'string'
							&& typeof parameters?.['type'] === 'string') {
							payload = { kanbanLink: { from: parameters['fromCard'], to: parameters['toCard'], type: parameters['type'] } };
						}
					}

					this.send({
						id: generateUuid(),
						ts: Date.now(),
						source: 'vscode-chat',
						sessionId: e.sessionResource?.toString() ?? 'vscode-chat-unknown',
						promptId: e.chatRequestId,
						actor: 'vscode-chat',
						verb,
						objects,
						ok: e.ok,
						durationMs: e.durationMs,
						payload
					});
				} catch (error) {
					this.logService.trace('[agentGraph] failed to record tool call', error);
				}
			}));
		}
	}

	private send(event: IAgentEvent): void {
		this.agentGraphService.ingestEvent(event).catch(error => this.logService.trace('[agentGraph] ingest failed', error));
	}
}
