/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AgentEventVerb, IAgentEvent, IAgentEventObject, IAgentGraphService } from '../../../../platform/agentGraph/common/agentGraph.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { LanguageModelToolsService } from '../../chat/browser/tools/languageModelToolsService.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
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
		@IAgentGraphService private readonly agentGraphService: IAgentGraphService,
		@ILogService private readonly logService: ILogService
	) {
		super();

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
					}
					const command = typeof parameters?.['command'] === 'string' ? parameters['command'] as string : undefined;
					if (command && TERMINAL_TOOL_PATTERN.test(e.toolId)) {
						const label = command.length > 80 ? command.slice(0, 77) + '…' : command;
						objects.push({ type: 'command', key: label, label });
						verb = 'command.run';
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
						durationMs: e.durationMs
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
