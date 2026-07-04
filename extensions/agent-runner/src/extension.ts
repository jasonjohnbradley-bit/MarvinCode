/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runStubSession } from './agentSession';
import { GraphEmitter } from './graphEmitter';

export function activate(context: vscode.ExtensionContext): void {
	const emitter = new GraphEmitter();
	context.subscriptions.push(vscode.commands.registerCommand('agentRunner.runStub', async () => {
		const sessionId = await runStubSession(emitter);
		vscode.window.showInformationMessage(vscode.l10n.t('Agent Runner: emitted stub session {0} — check the Agent Graph.', sessionId));
	}));
}
