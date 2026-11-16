/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Applies the workbench's agent network filter (`chat.agent.networkFilter` and the
// allowed/denied domain lists) to agent-driven Chrome navigation, mirroring
// src/vs/platform/networkFilter/common/{networkFilterService,domainMatcher}.ts.
// The workbench service is not reachable from an extension, so the rules are
// re-implemented here: denied wins, an empty allow list allows anything not
// denied, and both lists empty denies everything (when the filter is on).

import * as vscode from 'vscode';

function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function patternHost(pattern: string): string {
	const trimmed = pattern.trim();
	if (trimmed.includes('://')) {
		try {
			return normalizeHost(new URL(trimmed).host);
		} catch {
			return '';
		}
	}
	return normalizeHost(trimmed);
}

function matches(host: string, pattern: string): boolean {
	const p = patternHost(pattern);
	if (!p) {
		return false;
	}
	if (p === '*') {
		return true;
	}
	if (p.startsWith('*.')) {
		const suffix = p.slice(2);
		return host === suffix || host.endsWith(`.${suffix}`);
	}
	return host === p;
}

/** Returns an error message when agents may not use `url`, otherwise undefined. */
export function agentUrlBlockedReason(url: string): string | undefined {
	const config = vscode.workspace.getConfiguration('chat.agent');
	if (!config.get<boolean>('networkFilter', false)) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `Not a valid absolute URL: ${url}`;
	}
	if (parsed.protocol === 'file:' || !parsed.host) {
		return undefined;
	}
	const host = normalizeHost(parsed.host);
	const allowed = config.get<string[]>('allowedNetworkDomains', []);
	const denied = config.get<string[]>('deniedNetworkDomains', []);
	let ok: boolean;
	if (allowed.length === 0 && denied.length === 0) {
		ok = false;
	} else if (denied.some(p => matches(host, p))) {
		ok = false;
	} else {
		ok = allowed.length === 0 || allowed.some(p => matches(host, p));
	}
	return ok ? undefined : `Access to ${host} is blocked by network domain policy (see \`chat.agent.allowedNetworkDomains\` and \`chat.agent.deniedNetworkDomains\` settings).`;
}

export function hostMatchesAny(url: string, patterns: readonly string[]): boolean {
	try {
		const host = normalizeHost(new URL(url).host);
		return patterns.some(p => matches(host, p));
	} catch {
		return false;
	}
}
