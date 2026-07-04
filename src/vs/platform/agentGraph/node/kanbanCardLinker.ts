/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { IAgentEvent } from '../common/agentGraph.js';

const KANBAN_CARD_PATTERN = /[/\\]\.kanban[/\\]cards[/\\][\w.-]+\.md$/;

/**
 * Writes the session id of an agent that touched a Kanban card into the
 * card's `sessions:` front-matter list, so the card file itself carries
 * the link into the knowledge graph. Best-effort: any failure is the
 * caller's to log, and the card is never corrupted (only the front-matter
 * block is rewritten, and only when it parses).
 */
export async function linkSessionToTouchedCards(event: IAgentEvent): Promise<void> {
	if (!event.objects.some(object => object.type === 'task')) {
		return;
	}
	for (const object of event.objects) {
		if (object.type !== 'file' || !KANBAN_CARD_PATTERN.test(object.key)) {
			continue;
		}
		const text = await fs.readFile(object.key, 'utf8');
		const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(text);
		if (!match) {
			continue;
		}
		const lines = match[2].split(/\r?\n/);
		const sessionsIndex = lines.findIndex(line => line.startsWith('sessions:'));
		const existing = sessionsIndex >= 0
			? lines[sessionsIndex].slice('sessions:'.length).split(',').map(value => value.trim()).filter(value => value.length > 0)
			: [];
		if (existing.includes(event.sessionId)) {
			continue;
		}
		existing.push(event.sessionId);
		const sessionsLine = `sessions: ${existing.join(', ')}`;
		if (sessionsIndex >= 0) {
			lines[sessionsIndex] = sessionsLine;
		} else {
			lines.push(sessionsLine);
		}
		await fs.writeFile(object.key, `${match[1]}${lines.join('\n')}${match[3]}${text.slice(match[0].length)}`);
	}
}
