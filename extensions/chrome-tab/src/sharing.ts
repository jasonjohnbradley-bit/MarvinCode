/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { agentUrlBlockedReason } from './networkFilter';

const ASK_SETTING = 'askBeforeSharing';

/**
 * Asks before a Chrome page is shared with agents, like the Integrated Browser's
 * "Share with Agent?" dialog. A share the user starts from the toolbar can skip
 * the question ("Always Share" turns off `marvincode.chrome.askBeforeSharing`);
 * a share an agent asks for always asks, because these pages are signed in as
 * the user. Pages on domains the agent network filter blocks cannot be shared.
 */
export async function confirmShare(title: string, url: string, requestedByAgent: boolean): Promise<boolean> {
	const blocked = /^https?:/.test(url) ? agentUrlBlockedReason(url) : undefined;
	if (blocked) {
		await vscode.window.showWarningMessage(vscode.l10n.t('Cannot Share with Agent'), { modal: true, detail: blocked });
		return false;
	}
	const config = vscode.workspace.getConfiguration('marvincode.chrome');
	if (!requestedByAgent && !config.get<boolean>(ASK_SETTING, true)) {
		return true;
	}
	const share = vscode.l10n.t('Share');
	const always = vscode.l10n.t('Always Share');
	const message = requestedByAgent
		? vscode.l10n.t('An agent is asking to use this Chrome page. Share it?')
		: vscode.l10n.t('Share this Chrome page with agents?');
	const detail = vscode.l10n.t('{0}\n{1}\n\nAgents will be able to read and control it. It is signed in as you (Caseware device sign-in).', title, url);
	const picked = requestedByAgent
		? await vscode.window.showWarningMessage(message, { modal: true, detail }, share)
		: await vscode.window.showWarningMessage(message, { modal: true, detail }, share, always);
	if (picked === always) {
		await config.update(ASK_SETTING, false, vscode.ConfigurationTarget.Global);
	}
	return picked === share || picked === always;
}
