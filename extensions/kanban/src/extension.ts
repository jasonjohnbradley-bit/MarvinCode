/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardEditorProvider } from './boardEditorProvider';
import { scaffoldBoard } from './boardModel';
import { BoardsViewProvider } from './boardsViewProvider';
import { AgentRunner } from './campaign/agentRunner';
import { AgentsViewProvider } from './campaign/agentsViewProvider';
import { registerCampaignCommands } from './campaign/commands';
import { CardDecorationProvider } from './cardDecorations';
import { registerJiraCommands } from './jira/commands';
import { pairRemarkable } from './remarkable/client';
import { importMeetingNotes } from './remarkable/ingest';
import { registerStatusBar } from './statusBar';
import { registerKanbanTools } from './tools';

export function activate(context: vscode.ExtensionContext): void {
	const runner = new AgentRunner();
	context.subscriptions.push(runner);
	context.subscriptions.push(BoardEditorProvider.register(context));
	context.subscriptions.push(BoardsViewProvider.register());
	context.subscriptions.push(AgentsViewProvider.register(runner));
	context.subscriptions.push(CardDecorationProvider.register());
	context.subscriptions.push(registerStatusBar(runner));
	context.subscriptions.push(vscode.commands.registerCommand('kanban.newBoard', () => scaffoldBoard()));
	context.subscriptions.push(registerCampaignCommands(runner));
	context.subscriptions.push(registerJiraCommands(context));
	context.subscriptions.push(vscode.commands.registerCommand('kanban.remarkable.connect', () => pairRemarkable(context.secrets)));
	context.subscriptions.push(vscode.commands.registerCommand('kanban.remarkable.import', () => importMeetingNotes(context.secrets, runner)));
	context.subscriptions.push(registerKanbanTools(context.secrets));
}
