/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { appendHandoff, BoardFile, Card, doneColumnId, handoffsSection, loadCards, parseBoardFile, readyCards } from '../boardModel';
import { AgentRunner } from './agentRunner';

const DISPATCH_DELAY_MS = 2_000;
const MAX_READY_RETRIES = 5;
const READY_RETRY_DELAY_MS = 3_000;

interface BoardSnapshot {
	readonly board: BoardFile;
	readonly cards: Card[];
}

/** Campaigns keyed by parent card id — one active campaign per parent. */
export const activeCampaigns = new Map<string, Campaign>();

/**
 * Drives a decomposed card set to completion: dispatches every ready child
 * card (readiness = not done, not blocked by an unfinished blocker) through
 * the runner, re-evaluates after each completion so finished blockers
 * unlock their dependents, and finishes with a summary handoff on the
 * parent card. The runner's global concurrency cap applies throughout.
 */
export class Campaign {

	private readonly dispatched = new Set<string>();
	private readonly completed = new Set<string>();
	private readonly failed = new Set<string>();
	private retryCount = 0;
	private dispatchAttempts = 0;
	private finished = false;
	private timedOut = false;
	private startedAt = 0;
	private safetyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly runner: AgentRunner,
		private readonly boardUri: vscode.Uri,
		private readonly parentCard: Card
	) { }

	async start(): Promise<void> {
		const config = vscode.workspace.getConfiguration('kanban');
		const snapshot = await this.loadSnapshot();
		const children = this.childrenOf(snapshot);
		if (!children.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No child cards found for "{0}" — run the coordinator first (cards need a parent:{1} link).', this.parentCard.title, this.parentCard.id));
			activeCampaigns.delete(this.parentCard.id);
			return;
		}

		if (config.get<boolean>('campaign.requireApproval', true)) {
			const done = doneColumnId(snapshot.board);
			const pending = children.filter(child => child.column !== done);
			const detail = pending.map(child => {
				const blockers = snapshot.cards.filter(other => other.column !== done && other.links.some(link => link.type === 'blocking' && link.target === child.id));
				return `• ${child.title}${blockers.length ? ` (waits for: ${blockers.map(b => b.title).join(', ')})` : ''}`;
			}).join('\n');
			const start = vscode.l10n.t('Start Campaign');
			const picked = await vscode.window.showInformationMessage(
				vscode.l10n.t('Campaign for "{0}": dispatch agents on {1} card(s)?', this.parentCard.title, pending.length),
				{ modal: true, detail },
				start
			);
			if (picked !== start) {
				activeCampaigns.delete(this.parentCard.id);
				return;
			}
		}

		this.startedAt = Date.now();
		const timeoutMinutes = Math.max(1, config.get<number>('campaign.timeoutMinutes', 30));
		this.safetyTimer = setTimeout(() => {
			this.timedOut = true;
			void this.finish();
		}, timeoutMinutes * 60_000);
		await this.dispatchReady();
	}

	private async loadSnapshot(): Promise<BoardSnapshot> {
		const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.boardUri));
		return { board: parseBoardFile(text), cards: await loadCards(this.boardUri) };
	}

	private childrenOf(snapshot: BoardSnapshot): Card[] {
		return snapshot.cards.filter(card => card.links.some(link => link.type === 'parent' && link.target === this.parentCard.id));
	}

	private inFlight(): number {
		return [...this.dispatched].filter(id => !this.completed.has(id) && !this.failed.has(id)).length;
	}

	private async dispatchReady(): Promise<void> {
		if (this.finished) {
			return;
		}
		const snapshot = await this.loadSnapshot();
		const children = this.childrenOf(snapshot);
		const ready = new Set(readyCards(snapshot.board, snapshot.cards).map(card => card.id));
		const toDispatch = children.filter(child =>
			ready.has(child.id) && !this.dispatched.has(child.id) && !this.completed.has(child.id) && !this.failed.has(child.id));

		if (!toDispatch.length) {
			if (this.inFlight() > 0) {
				return; // completions will re-enter
			}
			if (this.dispatchAttempts > 0 || this.retryCount >= MAX_READY_RETRIES) {
				await this.finish();
			} else {
				// Startup race: the coordinator may still be writing cards
				this.retryCount++;
				setTimeout(() => void this.dispatchReady(), READY_RETRY_DELAY_MS);
			}
			return;
		}

		for (const child of toDispatch) {
			this.dispatched.add(child.id);
			this.dispatchAttempts++;
			void this.runner.runOnCard(this.boardUri, snapshot.board, snapshot.cards, child, vscode.l10n.t('Campaign: {0}', this.parentCard.title)).then(run => {
				(run.state === 'done' ? this.completed : this.failed).add(child.id);
				setTimeout(() => void this.dispatchReady(), DISPATCH_DELAY_MS);
			});
		}
	}

	private async finish(): Promise<void> {
		if (this.finished) {
			return;
		}
		this.finished = true;
		if (this.safetyTimer) {
			clearTimeout(this.safetyTimer);
		}
		activeCampaigns.delete(this.parentCard.id);

		try {
			const snapshot = await this.loadSnapshot();
			const children = this.childrenOf(snapshot);
			const done = doneColumnId(snapshot.board);
			const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
			const lines = [
				`Campaign ${this.timedOut ? 'timed out' : 'finished'}: ${this.completed.size}/${children.length} completed, ${this.failed.size} failed, ${elapsed}s elapsed.`,
				''
			];
			for (const child of children) {
				const status = this.failed.has(child.id) ? 'FAILED'
					: child.column === done ? 'done'
						: this.dispatched.has(child.id) ? 'incomplete' : 'not dispatched';
				lines.push(`- ${child.title} [${child.id}] — ${status}`);
				const handoffs = handoffsSection(child.body).trim();
				const lastEntry = handoffs.split(/^###\s/m).filter(entry => entry.trim()).pop();
				if (lastEntry) {
					lines.push(`  Last handoff: ${lastEntry.split('\n').slice(1).join(' ').trim().slice(0, 300)}`);
				}
			}
			await appendHandoff(this.parentCard.uri, { author: 'campaign', note: lines.join('\n') });
			const message = this.timedOut
				? vscode.l10n.t('Campaign for "{0}" timed out: {1}/{2} cards completed.', this.parentCard.title, this.completed.size, children.length)
				: vscode.l10n.t('Campaign for "{0}" finished: {1}/{2} cards completed, {3} failed.', this.parentCard.title, this.completed.size, children.length, this.failed.size);
			void (this.failed.size || this.timedOut ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
		} catch (error) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Campaign finished but writing the summary failed: {0}', String(error)));
		}
	}
}

/** Starts a campaign for a parent card unless one is already running. */
export function startCampaign(runner: AgentRunner, boardUri: vscode.Uri, parentCard: Card): void {
	if (activeCampaigns.has(parentCard.id)) {
		void vscode.window.showWarningMessage(vscode.l10n.t('A campaign for "{0}" is already running.', parentCard.title));
		return;
	}
	const campaign = new Campaign(runner, boardUri, parentCard);
	activeCampaigns.set(parentCard.id, campaign);
	void campaign.start();
}
