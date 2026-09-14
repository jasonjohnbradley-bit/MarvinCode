/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { IWindowsVmConfig } from './config';

const execFileAsync = promisify(execFile);

const COMPOSE_PROJECT = 'marvincode-winvm';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;

/**
 * Manages the local Guacamole Docker stack (guacd + guacamole, json-auth, localhost-only).
 */
export class GuacamoleGateway {

	private readonly gatewayDir: string;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {
		this.gatewayDir = path.join(this.context.globalStorageUri.fsPath, 'gateway');
	}

	private get composeFile(): string {
		return path.join(this.gatewayDir, 'docker-compose.yml');
	}

	/**
	 * Checks that the Docker daemon is reachable.
	 */
	async isDockerRunning(): Promise<boolean> {
		try {
			await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Writes/refreshes the compose file for the given config and secret key.
	 */
	writeComposeFile(config: IWindowsVmConfig, jsonSecretKey: string): void {
		fs.mkdirSync(this.gatewayDir, { recursive: true });
		const compose = [
			`name: ${COMPOSE_PROJECT}`,
			'services:',
			'  guacd:',
			`    image: guacamole/guacd:${config.imageTag}`,
			'    restart: unless-stopped',
			'  guacamole:',
			`    image: guacamole/guacamole:${config.imageTag}`,
			'    restart: unless-stopped',
			'    depends_on: [guacd]',
			'    environment:',
			'      GUACD_HOSTNAME: guacd',
			'      JSON_ENABLED: "true"',
			`      JSON_SECRET_KEY: "${jsonSecretKey}"`,
			'    ports:',
			`      - "127.0.0.1:${config.gatewayPort}:8080"`,
			'',
		].join('\n');
		fs.writeFileSync(this.composeFile, compose, { mode: 0o600 });
	}

	/**
	 * Starts the stack and waits until the Guacamole web app responds.
	 */
	async start(config: IWindowsVmConfig, jsonSecretKey: string, progress?: vscode.Progress<{ message?: string }>): Promise<void> {
		this.writeComposeFile(config, jsonSecretKey);
		progress?.report({ message: vscode.l10n.t('starting gateway containers…') });
		await this.compose(['up', '-d']);
		progress?.report({ message: vscode.l10n.t('waiting for the gateway to become ready…') });
		await this.waitForHealthy(config.gatewayPort);
	}

	/**
	 * Stops and removes the stack containers.
	 */
	async stop(): Promise<void> {
		await this.compose(['down']);
	}

	/**
	 * True if the guacamole service is currently running.
	 */
	async isUp(): Promise<boolean> {
		if (!fs.existsSync(this.composeFile)) {
			return false;
		}
		try {
			const { stdout } = await this.compose(['ps', '--services', '--filter', 'status=running']);
			return stdout.includes('guacamole');
		} catch {
			return false;
		}
	}

	/**
	 * Streams recent container logs into the output channel.
	 */
	async showLogs(): Promise<void> {
		this.output.show(true);
		try {
			const { stdout, stderr } = await this.compose(['logs', '--tail', '200']);
			this.output.appendLine(stdout);
			if (stderr) {
				this.output.appendLine(stderr);
			}
		} catch (error) {
			this.output.appendLine(String(error));
		}
	}

	private async compose(args: string[]): Promise<{ stdout: string; stderr: string }> {
		return execFileAsync('docker', ['compose', '-f', this.composeFile, ...args], { timeout: 120_000 });
	}

	private async waitForHealthy(port: number): Promise<void> {
		const deadline = Date.now() + HEALTH_TIMEOUT_MS;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/guacamole/`, { signal: AbortSignal.timeout(3_000) });
				if (response.ok) {
					return;
				}
				lastError = new Error(`HTTP ${response.status}`);
			} catch (error) {
				lastError = error;
			}
			await new Promise<void>(resolve => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
		}
		throw new Error(vscode.l10n.t('Guacamole gateway did not become ready within {0}s ({1})', HEALTH_TIMEOUT_MS / 1000, String(lastError)));
	}
}
