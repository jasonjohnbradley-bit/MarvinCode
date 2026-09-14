/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { getOrCreateJsonSecretKey, getOrPromptPassword, promptAndStorePassword, readConfig, IWindowsVmConfig } from './config';
import { GuacamoleGateway } from './gateway';
import { buildDesktopUrl, buildPayload, buildReuseUrlFilter, encryptPayload } from './guacAuth';
import { WindowsVmStatusBar } from './statusBar';

const SSH_TUNNEL_PORT = 53389;

let sshTunnel: ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Windows VM');
	context.subscriptions.push(output);

	const gateway = new GuacamoleGateway(context, output);
	const statusBar = new WindowsVmStatusBar(gateway);
	context.subscriptions.push(statusBar);

	// Empty tree so the activity bar view renders its welcome content (the action buttons).
	context.subscriptions.push(vscode.window.registerTreeDataProvider('windowsVm.panel', {
		getTreeItem: (element: vscode.TreeItem) => element,
		getChildren: () => [],
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('windowsVm.openDesktop', () => openDesktop(context, gateway, statusBar)),
		vscode.commands.registerCommand('windowsVm.setPassword', () => promptAndStorePassword(context.secrets)),
		vscode.commands.registerCommand('windowsVm.startGateway', () => startGateway(context, gateway, statusBar)),
		vscode.commands.registerCommand('windowsVm.stopGateway', () => stopGateway(gateway, statusBar)),
		vscode.commands.registerCommand('windowsVm.restartGateway', async () => {
			await stopGateway(gateway, statusBar);
			await startGateway(context, gateway, statusBar);
		}),
		vscode.commands.registerCommand('windowsVm.showLogs', () => gateway.showLogs()),
		vscode.commands.registerCommand('windowsVm.showMenu', () => statusBar.showMenu()),
		vscode.commands.registerCommand('windowsVm.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'windowsVm')),
	);
}

export function deactivate(): void {
	stopSshTunnel();
}

/**
 * Validates config, ensures the gateway is up, mints a fresh auth token and
 * opens (or refocuses) the desktop tab in the Integrated Browser.
 */
async function openDesktop(context: vscode.ExtensionContext, gateway: GuacamoleGateway, statusBar: WindowsVmStatusBar): Promise<void> {
	const config = readConfig();
	if (!config.host || !config.username) {
		const openSettings = vscode.l10n.t('Open Settings');
		const picked = await vscode.window.showErrorMessage(
			vscode.l10n.t('Set "windowsVm.host" and "windowsVm.username" before opening the desktop.'), openSettings);
		if (picked === openSettings) {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'windowsVm');
		}
		return;
	}

	const password = await getOrPromptPassword(context.secrets);
	if (!password) {
		return;
	}

	if (!await ensureDocker(gateway)) {
		return;
	}

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Windows VM') },
			async progress => {
				const secretKey = await getOrCreateJsonSecretKey(context.secrets);
				await gateway.start(config, secretKey, progress);

				const rdpOverride = config.sshEnabled ? await startSshTunnel(config) : undefined;
				const payload = buildPayload(config, password, rdpOverride);
				const token = encryptPayload(payload, secretKey);

				progress.report({ message: vscode.l10n.t('opening desktop…') });
				await vscode.commands.executeCommand('workbench.action.browser.open', {
					url: buildDesktopUrl(config.gatewayPort, token),
					reuseUrlFilter: buildReuseUrlFilter(config.gatewayPort),
					openToSide: config.openToSide,
				});
			});
	} catch (error) {
		const showLogs = vscode.l10n.t('Show Logs');
		const picked = await vscode.window.showErrorMessage(
			vscode.l10n.t('Failed to open the Windows desktop: {0}', error instanceof Error ? error.message : String(error)), showLogs);
		if (picked === showLogs) {
			await gateway.showLogs();
		}
	} finally {
		await statusBar.refresh();
	}
}

async function startGateway(context: vscode.ExtensionContext, gateway: GuacamoleGateway, statusBar: WindowsVmStatusBar): Promise<void> {
	if (!await ensureDocker(gateway)) {
		return;
	}
	const config = readConfig();
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Windows VM') },
			async progress => {
				const secretKey = await getOrCreateJsonSecretKey(context.secrets);
				await gateway.start(config, secretKey, progress);
			});
	} catch (error) {
		await vscode.window.showErrorMessage(vscode.l10n.t('Failed to start the gateway: {0}', error instanceof Error ? error.message : String(error)));
	} finally {
		await statusBar.refresh();
	}
}

async function stopGateway(gateway: GuacamoleGateway, statusBar: WindowsVmStatusBar): Promise<void> {
	stopSshTunnel();
	try {
		await gateway.stop();
	} catch (error) {
		await vscode.window.showErrorMessage(vscode.l10n.t('Failed to stop the gateway: {0}', error instanceof Error ? error.message : String(error)));
	} finally {
		await statusBar.refresh();
	}
}

async function ensureDocker(gateway: GuacamoleGateway): Promise<boolean> {
	if (await gateway.isDockerRunning()) {
		return true;
	}
	const openDocker = vscode.l10n.t('Open Docker');
	const picked = await vscode.window.showErrorMessage(
		vscode.l10n.t('Docker Desktop is not running. Start it, then try again.'), openDocker);
	if (picked === openDocker) {
		await vscode.env.openExternal(vscode.Uri.parse('docker-desktop://'));
	}
	return false;
}

/**
 * Forwards the VM's RDP port to localhost over SSH. guacd runs inside Docker,
 * so it reaches the tunnel via Docker Desktop's `host.docker.internal` alias.
 */
async function startSshTunnel(config: IWindowsVmConfig): Promise<{ hostname: string; port: number }> {
	stopSshTunnel();
	const user = config.sshUser || config.username;
	sshTunnel = spawn('ssh', [
		'-N',
		'-o', 'ExitOnForwardFailure=yes',
		'-o', 'BatchMode=yes',
		'-p', String(config.sshPort),
		'-L', `127.0.0.1:${SSH_TUNNEL_PORT}:127.0.0.1:${config.rdpPort}`,
		`${user}@${config.host}`,
	], { stdio: 'ignore' });
	sshTunnel.on('exit', () => { sshTunnel = undefined; });
	// Give the forward a moment to establish or fail fast.
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, 1_500);
		sshTunnel!.once('error', error => { clearTimeout(timer); reject(error); });
		sshTunnel!.once('exit', code => { clearTimeout(timer); reject(new Error(vscode.l10n.t('SSH tunnel exited with code {0}', code ?? -1))); });
	});
	return { hostname: 'host.docker.internal', port: SSH_TUNNEL_PORT };
}

function stopSshTunnel(): void {
	if (sshTunnel) {
		sshTunnel.kill();
		sshTunnel = undefined;
	}
}
