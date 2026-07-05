/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BoardFile, Card, doneColumnId, handoffsSection } from './boardModel';

/**
 * Assembles everything known about a card into a resume prompt: metadata,
 * typed links in both directions, parent and children context, and the
 * full card body including handoff notes. Shared by the
 * kanban_get_card_context tool and the campaign agent runner.
 */
export function buildCardContext(board: BoardFile, cards: readonly Card[], card: Card): string {
	const byId = new Map(cards.map(c => [c.id, c]));
	const doneColumn = doneColumnId(board);
	const lines = [
		`# Card ${card.id}: ${card.title}`,
		`- Column: ${card.column}${card.column === doneColumn ? ' (done)' : ''}`,
		card.priority ? `- Priority: ${card.priority}` : undefined,
		card.labels.length ? `- Labels: ${card.labels.join(', ')}` : undefined,
		card.sessions.length ? `- Agent sessions: ${card.sessions.join(', ')}` : undefined
	].filter((line): line is string => !!line);

	const inbound = cards.flatMap(other =>
		other.links.filter(link => link.target === card.id).map(link => ({ other, link })));
	if (card.links.length || inbound.length) {
		lines.push('', '## Links');
		for (const link of card.links) {
			const target = byId.get(link.target);
			lines.push(`- This card ${link.type === 'parent' ? 'has parent' : link.type === 'blocking' ? 'blocks' : 'relates to'} ${link.target}${target ? ` ("${target.title}", ${target.column})` : ' (missing)'}`);
		}
		for (const { other, link } of inbound) {
			lines.push(`- ${other.id} ("${other.title}", ${other.column}) ${link.type === 'parent' ? 'is parented to' : link.type === 'blocking' ? 'blocks' : 'relates to'} this card`);
		}
	}

	const parentLink = card.links.find(link => link.type === 'parent');
	const parent = parentLink ? byId.get(parentLink.target) : undefined;
	if (parent) {
		lines.push('', '## Parent card', `${parent.id}: ${parent.title} (${parent.column})`);
		const parentHandoffs = handoffsSection(parent.body).trim();
		if (parentHandoffs) {
			lines.push('', '### Parent handoff notes', parentHandoffs);
		}
	}

	const children = cards.filter(other => other.links.some(link => link.type === 'parent' && link.target === card.id));
	if (children.length) {
		lines.push('', '## Child cards');
		for (const child of children) {
			lines.push(`- ${child.id}: "${child.title}" (${child.column}${child.column === doneColumn ? ', done' : ''}${child.handoffCount ? `, ${child.handoffCount} handoff note${child.handoffCount === 1 ? '' : 's'}` : ''})`);
		}
	}

	if (card.body.trim()) {
		lines.push('', '## Card body', '', card.body.trim());
	}
	return lines.join('\n');
}
