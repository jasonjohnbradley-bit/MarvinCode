/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardFile } from '../boardModel';
import { getStoredCredentials, JiraClient, storeCredentials } from './client';

export interface JiraBoardConfig {
	readonly host: string;
	readonly projectKey: string;
	readonly projectId: string;
	/** Jira status name → board column id (agentic-kanban's proven shape). */
	readonly statusMap: Record<string, string>;
	readonly issueType: string;
	readonly jql?: string;
	readonly pushHandoffs: boolean;
}

const DEFAULT_HOST = 'https://caseware.atlassian.net';

export function jiraConfigUri(boardUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(boardUri, '..', 'jira.json');
}

export async function readJiraConfig(boardUri: vscode.Uri): Promise<JiraBoardConfig | undefined> {
	try {
		const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(jiraConfigUri(boardUri))));
		if (typeof raw.host === 'string' && typeof raw.projectKey === 'string' && raw.statusMap && typeof raw.statusMap === 'object') {
			return {
				host: raw.host,
				projectKey: raw.projectKey,
				projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
				statusMap: raw.statusMap,
				issueType: typeof raw.issueType === 'string' ? raw.issueType : 'Task',
				jql: typeof raw.jql === 'string' ? raw.jql : undefined,
				pushHandoffs: raw.pushHandoffs === true
			};
		}
	} catch {
		// No config or unreadable — board is not linked
	}
	return undefined;
}

/** Client for a linked board, or an explanation of what is missing. */
export async function clientForBoard(secrets: vscode.SecretStorage, boardUri: vscode.Uri): Promise<{ client: JiraClient; config: JiraBoardConfig }> {
	const config = await readJiraConfig(boardUri);
	if (!config) {
		throw new Error(vscode.l10n.t('This board is not linked to Jira — run "Kanban: Link Board to Jira" first.'));
	}
	const credentials = await getStoredCredentials(secrets, config.host);
	if (!credentials) {
		throw new Error(vscode.l10n.t('No Jira credentials stored for {0} — run "Kanban: Connect to Jira" first.', config.host));
	}
	return { client: new JiraClient(config.host, credentials), config };
}

/** Interactive credential setup; verifies with /myself before storing. */
export async function connectToJira(secrets: vscode.SecretStorage): Promise<void> {
	const host = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Jira site URL'),
		value: DEFAULT_HOST,
		ignoreFocusOut: true
	});
	if (!host) {
		return;
	}
	const email = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Atlassian account email'),
		value: 'jason.bradley@caseware.com',
		ignoreFocusOut: true
	});
	if (!email) {
		return;
	}
	const apiToken = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Jira API token (create one at id.atlassian.com → Security → API tokens)'),
		password: true,
		ignoreFocusOut: true
	});
	if (!apiToken) {
		return;
	}
	const client = new JiraClient(host, { email, apiToken });
	try {
		const who = await client.myself();
		await storeCredentials(secrets, host.replace(/\/+$/, ''), { email, apiToken });
		void vscode.window.showInformationMessage(vscode.l10n.t('Connected to Jira as {0}. Credentials stored in the OS keychain.', who));
	} catch (error) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Jira connection failed: {0}', error instanceof Error ? error.message : String(error)));
	}
}

/** Fuzzy status-name → column proposal: exact title match, then substring heuristics. */
export function proposeStatusMap(statusNames: readonly string[], board: BoardFile): Record<string, string> {
	const map: Record<string, string> = {};
	const columns = board.columns;
	const byTitle = new Map(columns.map(column => [column.title.toLowerCase(), column.id]));
	const first = columns[0]?.id;
	const last = columns[columns.length - 1]?.id;
	const middle = columns.length > 2 ? columns[1].id : first;
	for (const status of statusNames) {
		const lower = status.toLowerCase();
		let target = byTitle.get(lower);
		if (!target) {
			if (/done|closed|complete|resolved|cancel/.test(lower)) {
				target = last;
			} else if (/progress|review|doing|develop|test/.test(lower)) {
				target = middle;
			} else {
				target = first; // to do / open / backlog / anything unknown
			}
		}
		if (target) {
			map[status] = target;
		}
	}
	return map;
}

/** Interactive board→project linking; writes .kanban/jira.json. */
export async function linkBoardToJira(secrets: vscode.SecretStorage, boardUri: vscode.Uri, board: BoardFile): Promise<void> {
	const host = (await readJiraConfig(boardUri))?.host ?? DEFAULT_HOST;
	const credentials = await getStoredCredentials(secrets, host);
	if (!credentials) {
		void vscode.window.showWarningMessage(vscode.l10n.t('No Jira credentials for {0} — run "Kanban: Connect to Jira" first.', host));
		return;
	}
	const client = new JiraClient(host, credentials);

	const query = await vscode.window.showInputBox({
		prompt: vscode.l10n.t('Search Jira projects by name or key'),
		ignoreFocusOut: true
	});
	if (query === undefined) {
		return;
	}
	const projects = await client.searchProjects(query);
	if (!projects.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t('No Jira projects matched "{0}".', query));
		return;
	}
	const pickedProject = await vscode.window.showQuickPick(
		projects.map(project => ({ label: `${project.key} — ${project.name}`, project })),
		{ placeHolder: vscode.l10n.t('Link this board to which Jira project?'), ignoreFocusOut: true });
	if (!pickedProject) {
		return;
	}

	const statusNames = await client.projectStatuses(pickedProject.project.key);
	const proposal = proposeStatusMap(statusNames, board);
	const columnItems = board.columns.map(column => ({ label: column.title, description: column.id, id: column.id }));
	const statusMap: Record<string, string> = {};
	for (const status of statusNames) {
		const proposed = proposal[status];
		const picked = await vscode.window.showQuickPick(
			columnItems.map(item => ({ ...item, picked: item.id === proposed, description: item.id === proposed ? vscode.l10n.t('{0} · proposed', item.description) : item.description })),
			{ placeHolder: vscode.l10n.t('Jira status "{0}" maps to which column?', status), ignoreFocusOut: true });
		if (!picked) {
			return;
		}
		statusMap[status] = picked.id;
	}

	const config: JiraBoardConfig = {
		host,
		projectKey: pickedProject.project.key,
		projectId: pickedProject.project.id,
		statusMap,
		issueType: 'Task',
		pushHandoffs: false
	};
	await vscode.workspace.fs.writeFile(jiraConfigUri(boardUri), new TextEncoder().encode(JSON.stringify(config, null, '\t') + '\n'));
	void vscode.window.showInformationMessage(vscode.l10n.t('Board linked to {0} ({1} statuses mapped). Run "Kanban: Sync Board with Jira" to pull issues.', pickedProject.project.key, String(statusNames.length)));
}
