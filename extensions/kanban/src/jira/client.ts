/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Priority } from '../boardModel';

export interface JiraIssue {
	readonly id: string;
	readonly key: string;
	readonly summary: string;
	readonly description: string;
	readonly statusName: string;
	readonly priorityName: string | undefined;
	readonly issueType: string | undefined;
	readonly updated: string;
}

export interface JiraProject {
	readonly id: string;
	readonly key: string;
	readonly name: string;
}

export interface JiraTransition {
	readonly id: string;
	readonly toStatusName: string;
}

interface AdfNode {
	readonly type?: string;
	readonly text?: string;
	readonly content?: AdfNode[];
}

/** Flattens an Atlassian Document Format tree to plain text. */
export function adfToPlainText(node: AdfNode | string | undefined | null): string {
	if (!node) {
		return '';
	}
	if (typeof node === 'string') {
		return node;
	}
	if (node.type === 'text') {
		return node.text ?? '';
	}
	const inner = (node.content ?? []).map(child => adfToPlainText(child)).join('');
	switch (node.type) {
		case 'paragraph':
		case 'heading':
		case 'listItem':
		case 'codeBlock':
		case 'blockquote':
			return inner + '\n';
		case 'hardBreak':
			return '\n';
		default:
			return inner;
	}
}

/** Builds a minimal ADF document from plain text (one paragraph per line group). */
export function plainTextToAdf(text: string): object {
	const paragraphs = text.split(/\n{2,}/).map(block => block.trim()).filter(block => block.length > 0);
	return {
		type: 'doc',
		version: 1,
		content: (paragraphs.length ? paragraphs : ['']).map(block => ({
			type: 'paragraph',
			content: block ? [{ type: 'text', text: block.replace(/\n/g, ' ') }] : []
		}))
	};
}

/** Buckets Jira priority names into the board's priority scale (ported from agentic-kanban). */
export function mapJiraPriority(name: string | undefined): Priority | undefined {
	if (!name) {
		return undefined;
	}
	const lower = name.toLowerCase();
	if (/highest|critical|blocker/.test(lower)) {
		return 'urgent';
	}
	if (/high|major/.test(lower)) {
		return 'high';
	}
	if (/medium|normal/.test(lower)) {
		return 'medium';
	}
	if (/low|lowest|trivial|minor/.test(lower)) {
		return 'low';
	}
	return undefined;
}

const SECRET_KEY_PREFIX = 'kanban.jira.';

export interface JiraCredentials {
	readonly email: string;
	readonly apiToken: string;
}

export async function getStoredCredentials(secrets: vscode.SecretStorage, host: string): Promise<JiraCredentials | undefined> {
	const raw = await secrets.get(SECRET_KEY_PREFIX + host);
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed.email === 'string' && typeof parsed.apiToken === 'string' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function storeCredentials(secrets: vscode.SecretStorage, host: string, credentials: JiraCredentials): Promise<void> {
	await secrets.store(SECRET_KEY_PREFIX + host, JSON.stringify(credentials));
}

function issueFromFields(id: string, key: string, fields: Record<string, any>): JiraIssue {
	return {
		id,
		key,
		summary: typeof fields['summary'] === 'string' ? fields['summary'] : '',
		description: adfToPlainText(fields['description']).trim(),
		statusName: fields['status']?.name ?? '',
		priorityName: fields['priority']?.name,
		issueType: fields['issuetype']?.name,
		updated: fields['updated'] ?? ''
	};
}

const ISSUE_FIELDS = 'summary,description,status,priority,issuetype,updated';

/**
 * Minimal Jira Cloud REST v3 client. Reads flatten ADF to plain text;
 * writes build minimal ADF (the flaw agentic-kanban never fixed).
 */
export class JiraClient {

	private readonly host: string;
	private readonly authHeader: string;

	constructor(host: string, credentials: JiraCredentials) {
		this.host = host.replace(/\/+$/, '');
		this.authHeader = 'Basic ' + Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64');
	}

	issueUrl(key: string): string {
		return `${this.host}/browse/${key}`;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.host}/rest/api/3${path}`, {
			method,
			headers: {
				'Authorization': this.authHeader,
				'Accept': 'application/json',
				...(body === undefined ? {} : { 'Content-Type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!response.ok) {
			const text = (await response.text().catch(() => '')).slice(0, 400);
			throw new Error(`Jira ${method} ${path} failed: HTTP ${response.status}${text ? ` — ${text}` : ''}`);
		}
		return response.status === 204 ? undefined as T : await response.json() as T;
	}

	/** Connection test; returns the display name of the authenticated user. */
	async myself(): Promise<string> {
		const me = await this.request<{ displayName?: string; emailAddress?: string }>('GET', '/myself');
		return me.displayName ?? me.emailAddress ?? 'unknown';
	}

	async searchProjects(query: string): Promise<JiraProject[]> {
		const result = await this.request<{ values: { id: string; key: string; name: string }[] }>(
			'GET', `/project/search?maxResults=50${query ? `&query=${encodeURIComponent(query)}` : ''}`);
		return result.values.map(p => ({ id: p.id, key: p.key, name: p.name }));
	}

	/** Distinct status names used by the project's issue types. */
	async projectStatuses(projectKey: string): Promise<string[]> {
		const result = await this.request<{ statuses: { name: string }[] }[]>('GET', `/project/${encodeURIComponent(projectKey)}/statuses`);
		const names = new Set<string>();
		for (const issueType of result) {
			for (const status of issueType.statuses) {
				names.add(status.name);
			}
		}
		return [...names];
	}

	/** Paginated JQL search returning all matching issues. */
	async searchIssues(jql: string, limit = 500): Promise<JiraIssue[]> {
		const issues: JiraIssue[] = [];
		let nextPageToken: string | undefined;
		while (issues.length < limit) {
			const page = await this.request<{ issues: { id: string; key: string; fields: Record<string, any> }[]; nextPageToken?: string }>(
				'POST', '/search/jql', { jql, maxResults: 100, fields: ISSUE_FIELDS.split(','), nextPageToken });
			for (const issue of page.issues ?? []) {
				issues.push(issueFromFields(issue.id, issue.key, issue.fields));
			}
			nextPageToken = page.nextPageToken;
			if (!nextPageToken || !(page.issues ?? []).length) {
				break;
			}
		}
		return issues;
	}

	/** Returns the issue, or undefined when it does not exist (404). */
	async getIssue(key: string): Promise<JiraIssue | undefined> {
		try {
			const issue = await this.request<{ id: string; key: string; fields: Record<string, any> }>(
				'GET', `/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`);
			return issueFromFields(issue.id, issue.key, issue.fields);
		} catch (error) {
			if (error instanceof Error && /HTTP 404/.test(error.message)) {
				return undefined;
			}
			throw error;
		}
	}

	async createIssue(projectKey: string, issueType: string, summary: string, description: string): Promise<{ id: string; key: string }> {
		return this.request<{ id: string; key: string }>('POST', '/issue', {
			fields: {
				project: { key: projectKey },
				issuetype: { name: issueType },
				summary,
				description: plainTextToAdf(description)
			}
		});
	}

	async updateIssue(key: string, fields: { summary?: string; description?: string }): Promise<void> {
		const payload: Record<string, unknown> = {};
		if (fields.summary !== undefined) {
			payload['summary'] = fields.summary;
		}
		if (fields.description !== undefined) {
			payload['description'] = plainTextToAdf(fields.description);
		}
		await this.request('PUT', `/issue/${encodeURIComponent(key)}`, { fields: payload });
	}

	async getTransitions(key: string): Promise<JiraTransition[]> {
		const result = await this.request<{ transitions: { id: string; to: { name: string } }[] }>(
			'GET', `/issue/${encodeURIComponent(key)}/transitions`);
		return result.transitions.map(t => ({ id: t.id, toStatusName: t.to.name }));
	}

	async transitionIssue(key: string, transitionId: string): Promise<void> {
		await this.request('POST', `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transitionId } });
	}

	async addComment(key: string, text: string): Promise<void> {
		await this.request('POST', `/issue/${encodeURIComponent(key)}/comment`, { body: plainTextToAdf(text) });
	}
}
