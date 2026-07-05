/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardFile, Card, doneColumnId } from '../boardModel';
import { buildCardContext } from '../cardContext';

const TOKEN_BUDGET = 10_000;

/** Rough token estimate: no real tokenizer needed for a truncation heuristic. */
export function estimateTokens(text: string): number {
	const words = text.split(/\s+/).filter(word => word.length > 0).length;
	const newlines = (text.match(/\n/g) ?? []).length;
	return Math.ceil(words * 1.3 + newlines);
}

interface BoardStateOptions {
	readonly excludeDone: boolean;
	readonly truncateBodies: boolean;
	readonly firstTwoColumnsOnly: boolean;
}

function buildBoardState(board: BoardFile, cards: readonly Card[], options: BoardStateOptions): string {
	const doneColumn = doneColumnId(board);
	let columns = board.columns as readonly { id: string; title: string }[];
	if (options.firstTwoColumnsOnly) {
		columns = columns.slice(0, 2);
	} else if (options.excludeDone && doneColumn) {
		columns = columns.filter(column => column.id !== doneColumn);
	}
	const lines: string[] = [];
	for (const column of columns) {
		const columnCards = cards.filter(card => card.column === column.id);
		lines.push(`### ${column.title} (${column.id}) — ${columnCards.length} card${columnCards.length === 1 ? '' : 's'}`);
		for (const card of columnCards) {
			const body = card.body.trim().replace(/\s+/g, ' ');
			const summary = options.truncateBodies && body.length > 200 ? body.slice(0, 197) + '…' : body;
			lines.push(`- "${card.title}" [${card.id}]${card.priority ? ` [${card.priority}]` : ''}${card.links.length ? ` links: ${card.links.map(l => `${l.type}:${l.target}`).join(', ')}` : ''}${summary ? ` — ${summary}` : ''}`);
		}
	}
	return lines.join('\n');
}

const CHAT_TOOLS_SECTION = `## Your Tools

Use the kanban tools to work the board:
- kanban_list_cards — read the board (columns, cards, blocked state)
- kanban_create_card — create a card (board, column, title, priority, labels, body)
- kanban_update_card — retitle / move / reprioritize a card
- kanban_link_cards — typed links: blocking (fromCard blocks toCard), related, parent (fromCard's parent is toCard)
- kanban_ready_cards — cards that are actionable now
- kanban_add_handoff — append a handoff note to a card
- kanban_get_card_context — full context for one card`;

function fileOpsSection(boardUri: vscode.Uri, firstColumnId: string): string {
	const boardDir = vscode.Uri.joinPath(boardUri, '..').fsPath;
	return `## How to Work the Board (file operations)

This board is plain files — you create and link cards by writing them:
- Card files live at \`${boardDir}/cards/<id>.md\`. Generate ids like JavaScript \`Date.now().toString(36) + Math.random().toString(36).slice(2, 8)\` (lowercase alphanumeric, ~14 chars).
- A card file is YAML-ish front-matter followed by a markdown body:

\`\`\`
---
id: <id>
title: <action-oriented title>
column: ${firstColumnId}
priority: <urgent|high|medium|low>
labels:
links: parent:<parentCardId>, blocking:<otherCardId>
created: <ISO timestamp>
---

<markdown body / brief>
\`\`\`

- \`links\` is comma-separated \`<type>:<targetCardId>\` with types: \`parent\` (this card's parent is target), \`blocking\` (this card blocks target), \`related\`. Never create a blocking cycle.
- After creating card files, add each new id to the \`order.${firstColumnId}\` array in \`${boardUri.fsPath}\` (keep the JSON's tab indentation).
- To add a handoff note, append to the card body a \`## Handoffs\` section containing entries like \`### <ISO timestamp> — coordinator\` followed by \`- Findings: …\` / \`- Next steps: …\` bullet lines.`;
}

/**
 * The DM decomposition prompt, ported from agentic-kanban's coordinator.
 * `chat-tools` speaks the kanban_* LM tool vocabulary (for the built-in
 * chat agent); `file-ops` embeds the card file format spec (for a headless
 * claude CLI run, which has no LM tools but excels at file edits).
 */
export function buildCoordinatorPrompt(boardUri: vscode.Uri, board: BoardFile, cards: readonly Card[], parentCard: Card, flavor: 'chat-tools' | 'file-ops', instructions?: string): string {
	const firstColumn = board.columns[0]?.id ?? 'todo';

	const render = (options: BoardStateOptions, reducedNote: boolean): string => {
		const sections = [
			`# Kanban Coordinator (DM) Mode

You are the coordinator ("Dungeon Master") for this board. Your job is to decompose the feature request below into a well-structured campaign of sub-cards that agents can execute independently.`,
			flavor === 'chat-tools' ? CHAT_TOOLS_SECTION : fileOpsSection(boardUri, firstColumn),
			`## Feature Request (Parent Card)

<parent_card>
Title: ${parentCard.title}
ID: ${parentCard.id}
Priority: ${parentCard.priority ?? 'unset'}
Board: ${boardUri.fsPath}
</parent_card>`,
			instructions ? `## Custom Instructions for This Run

<custom_instructions>
${instructions}
</custom_instructions>` : undefined,
			`## Parent Card Context

${buildCardContext(board, cards, parentCard)}`,
			`## Current Board State

<board_state>
${buildBoardState(board, cards, options)}${reducedNote ? '\n\n(Board state was reduced to fit the prompt budget — read the board for full detail.)' : ''}
</board_state>`,
			`## Workflow

1. **Analyze** the feature request and break it into 2-6 specific, independently testable sub-cards.
2. **Create** each sub-card in the "${firstColumn}" column with an action-oriented title, a priority, and a structured brief as the card body using these markdown sections (include only relevant ones — be specific, name exact files and functions where known): "## Files to touch", "## Functions to implement", "## Tests to write", "## Acceptance criteria", "## Caveats".
3. **Link** every sub-card to the parent: link type \`parent\` from the sub-card to ${parentCard.id}. Add \`blocking\` links only where true sequential dependencies exist (the blocker card blocks the dependent card). Do NOT create circular dependencies.
4. **Write** a starter handoff note on each sub-card: what to focus on, files or patterns to reference, constraints and design decisions.
5. **Always append a final verification card** titled "Verify and test: ${parentCard.title}" — its brief tells the agent to run the application/tests and validate the acceptance criteria of every sub-card. Every other sub-card you created must have a \`blocking\` link to this card (they block it), so it only becomes ready when the rest are done.
6. **Summarize** by writing a handoff note on the parent card (${parentCard.id}): list the created sub-card ids and titles, describe the dependency graph, and highlight decisions or tradeoffs.

## Rules

- Keep sub-cards focused: one clear responsibility each.
- Be specific in briefs — vague cards produce vague work.
- Do not duplicate work that is already in progress on the board.
- Always decompose into at least 2 sub-cards — even simple features benefit from a coding card + verification card split.`
		].filter((section): section is string => !!section);
		return sections.join('\n\n');
	};

	// Cumulative truncation levels, applied to the board-state section only
	const levels: BoardStateOptions[] = [
		{ excludeDone: false, truncateBodies: true, firstTwoColumnsOnly: false },
		{ excludeDone: true, truncateBodies: true, firstTwoColumnsOnly: false },
		{ excludeDone: true, truncateBodies: true, firstTwoColumnsOnly: true }
	];
	let prompt = render(levels[0], false);
	for (let level = 1; level < levels.length && estimateTokens(prompt) > TOKEN_BUDGET; level++) {
		prompt = render(levels[level], true);
	}
	return prompt;
}
