/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GuacamoleGateway } from './gateway';

const POLL_INTERVAL_MS = 30_000;

/**
 * Status bar item reflecting the gateway state, with a QuickPick menu of actions.
 */
export class WindowsVmStatusBar implements vscode.Disposable {

	private readonly item: vscode.StatusBarItem;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly gateway: GuacamoleGateway) {
		this.item = vscode.window.createStatusBarItem('windowsVm.status', vscode.StatusBarAlignment.Right, 90);
		this.item.name = vscode.l10n.t('Windows VM');
		this.item.command = 'windowsVm.showMenu';
		this.item.text = '$(vm) Win VM';
		this.item.tooltip = vscode.l10n.t('Windows VM Desktop');
		this.item.show();
		this.timer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
		void this.refresh();
	}

	async refresh(): Promise<void> {
		const up = await this.gateway.isUp();
		this.item.text = up ? '$(vm-active) Win VM' : '$(vm) Win VM';
		this.item.tooltip = up
			? vscode.l10n.t('Windows VM Desktop — gateway running')
			: vscode.l10n.t('Windows VM Desktop — gateway stopped');
	}

	async showMenu(): Promise<void> {
		type ActionItem = vscode.QuickPickItem & { command: string };
		const items: ActionItem[] = [
			{ label: '$(vm) ' + vscode.l10n.t('Open Desktop'), command: 'windowsVm.openDesktop' },
			{ label: '$(play) ' + vscode.l10n.t('Start Gateway'), command: 'windowsVm.startGateway' },
			{ label: '$(debug-stop) ' + vscode.l10n.t('Stop Gateway'), command: 'windowsVm.stopGateway' },
			{ label: '$(output) ' + vscode.l10n.t('Show Gateway Logs'), command: 'windowsVm.showLogs' },
			{ label: '$(key) ' + vscode.l10n.t('Set VM Password'), command: 'windowsVm.setPassword' },
			{ label: '$(gear) ' + vscode.l10n.t('Settings'), command: 'windowsVm.openSettings' },
		];
		const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Windows VM') });
		if (picked) {
			await vscode.commands.executeCommand(picked.command);
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.item.dispose();
	}
}
