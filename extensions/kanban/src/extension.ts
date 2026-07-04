/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardEditorProvider } from './boardEditorProvider';
import { scaffoldBoard } from './boardModel';
import { BoardsViewProvider } from './boardsViewProvider';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(BoardEditorProvider.register(context));
	context.subscriptions.push(BoardsViewProvider.register());
	context.subscriptions.push(vscode.commands.registerCommand('kanban.newBoard', () => scaffoldBoard()));
}
