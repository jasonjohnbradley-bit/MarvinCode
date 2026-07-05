/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { appendCardSession, appendHandoff, BoardFile, Card, doneColumnId, loadCards, moveCardInBoard, parseBoardFile, setCardColumn, updateCardMeta, writeBoardFile } from '../boardModel';
import { buildCardContext } from '../cardContext';

export type AgentRunState = 'queued' | 'working' | 'done' | 'failed' | 'killed';

export interface AgentRun {
	readonly id: string;
	readonly kind: 'card' | 'coordinator';
	readonly groupLabel?: string;
	readonly boardUri: vscode.Uri;
	readonly card: Card;
	state: AgentRunState;
	readonly queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	lastOutputAt: number;
	claudeSessionId?: string;
	branch?: string;
	worktreeDir?: string;
	toolNames: Set<string>;
	exitCode?: number;
	stderrTail: string;
	child?: ChildProcess;
}

/** A run is considered stalled when it is working but silent for this long. */
export const STALL_THRESHOLD_MS = 10 * 60 * 1000;

const WORKTREES_DIR = '.kanban-worktrees';

let cachedClaudePath: string | undefined;

function resolveClaudePath(): string {
	if (cachedClaudePath && fs.existsSync(cachedClaudePath)) {
		return cachedClaudePath;
	}
	try {
		const found = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
		if (found) {
			return cachedClaudePath = found;
		}
	} catch {
		// which failed — try the well-known locations
	}
	for (const candidate of [
		path.join(os.homedir(), '.local', 'bin', 'claude'),
		path.join(os.homedir(), '.claude', 'local', 'claude'),
		'/usr/local/bin/claude',
		'/opt/homebrew/bin/claude'
	]) {
		if (fs.existsSync(candidate)) {
			return cachedClaudePath = candidate;
		}
	}
	throw new Error('claude CLI not found. Install Claude Code and make sure `claude` is on your PATH.');
}

function gitRepoRoot(dir: string): string | undefined {
	try {
		return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function ensureGitignoreEntry(repoRoot: string): void {
	const gitignore = path.join(repoRoot, '.gitignore');
	const entry = `${WORKTREES_DIR}/`;
	try {
		const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
		if (!current.split(/\r?\n/).includes(entry)) {
			fs.writeFileSync(gitignore, current.replace(/\s*$/, '\n') + entry + '\n');
		}
	} catch {
		// A missing gitignore entry is annoying, not fatal
	}
}

function createWorktree(repoRoot: string, cardId: string): { dir: string; branch: string } {
	ensureGitignoreEntry(repoRoot);
	let dir = path.join(repoRoot, WORKTREES_DIR, cardId);
	let branch = `card/${cardId}`;
	try {
		execFileSync('git', ['-C', repoRoot, 'worktree', 'add', dir, '-b', branch], { encoding: 'utf8' });
	} catch {
		// Branch or dir may exist from an earlier run — retry with a unique suffix
		const suffix = Date.now().toString(36);
		dir = `${dir}-${suffix}`;
		branch = `card/${cardId}-${suffix}`;
		execFileSync('git', ['-C', repoRoot, 'worktree', 'add', dir, '-b', branch], { encoding: 'utf8' });
	}
	return { dir, branch };
}

/**
 * Runs claude CLI agents on cards: one child process per card, capped
 * concurrency with a FIFO queue, optional git-worktree isolation, card
 * status written back to front-matter, and lifecycle events posted to the
 * agent graph's ingest endpoint.
 */
export class AgentRunner implements vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private readonly queue: { run: AgentRun; prompt: string; resolve: (run: AgentRun) => void }[] = [];
	readonly runs = new Map<string, AgentRun>();
	private readonly output = vscode.window.createOutputChannel(vscode.l10n.t('Kanban Agents'));

	private get maxConcurrent(): number {
		return Math.max(1, vscode.workspace.getConfiguration('kanban').get<number>('agents.maxConcurrent', 2));
	}

	private get useWorktrees(): boolean {
		return vscode.workspace.getConfiguration('kanban').get<boolean>('agents.useWorktrees', true);
	}

	/** Runs an agent on a card; resolves when the process exits. */
	runOnCard(boardUri: vscode.Uri, board: BoardFile, cards: readonly Card[], card: Card, groupLabel?: string): Promise<AgentRun> {
		const prompt = [
			buildCardContext(board, cards, card),
			'',
			'---',
			'',
			'Complete this task. The card file describing it is at:',
			card.uri.fsPath,
			'',
			'When you are done, append a handoff entry to that card file. If the file has no `## Handoffs` section yet, add one at the end. The entry format is:',
			'',
			'### <ISO timestamp> — card-agent',
			'- Findings: <what you did and learned>',
			'- Next steps: <anything left for a follow-up>',
			'- Blockers: <only if something blocked you>',
			'',
			'Do not change the card\'s `column` or `agentStatus` front-matter — the board manages those. Do not work on other cards.'
		].join('\n');
		return this.enqueue('card', boardUri, card, prompt, groupLabel);
	}

	/** Runs a coordinator (DM) decomposition prompt; resolves on exit. */
	runCoordinator(boardUri: vscode.Uri, card: Card, prompt: string): Promise<AgentRun> {
		return this.enqueue('coordinator', boardUri, card, prompt);
	}

	kill(runId: string): void {
		const run = this.runs.get(runId);
		if (run?.state === 'working' && run.child) {
			run.state = 'killed';
			run.child.kill('SIGTERM');
		} else if (run?.state === 'queued') {
			const index = this.queue.findIndex(item => item.run.id === runId);
			if (index !== -1) {
				const [item] = this.queue.splice(index, 1);
				run.state = 'killed';
				run.endedAt = Date.now();
				item.resolve(run);
			}
		}
		this._onDidChange.fire();
	}

	private enqueue(kind: 'card' | 'coordinator', boardUri: vscode.Uri, card: Card, prompt: string, groupLabel?: string): Promise<AgentRun> {
		const run: AgentRun = {
			id: `${kind}-${card.id}-${Date.now().toString(36)}`,
			kind,
			groupLabel,
			boardUri,
			card,
			state: 'queued',
			queuedAt: Date.now(),
			lastOutputAt: Date.now(),
			toolNames: new Set(),
			stderrTail: ''
		};
		this.runs.set(run.id, run);
		this._onDidChange.fire();
		return new Promise<AgentRun>(resolve => {
			this.queue.push({ run, prompt, resolve });
			this.pump();
		});
	}

	private pump(): void {
		const working = [...this.runs.values()].filter(run => run.state === 'working').length;
		while (this.queue.length && [...this.runs.values()].filter(run => run.state === 'working').length < this.maxConcurrent) {
			const item = this.queue.shift()!;
			if (item.run.state !== 'queued') {
				continue;
			}
			void this.start(item.run, item.prompt, item.resolve);
		}
		if (working === 0 && this.queue.length === 0) {
			this._onDidChange.fire();
		}
	}

	private async start(run: AgentRun, prompt: string, resolve: (run: AgentRun) => void): Promise<void> {
		const boardDir = path.dirname(path.dirname(run.boardUri.fsPath));
		let cwd = boardDir;
		try {
			const claude = resolveClaudePath();
			if (run.kind === 'card' && this.useWorktrees) {
				const repoRoot = gitRepoRoot(boardDir);
				if (repoRoot) {
					const worktree = createWorktree(repoRoot, run.card.id);
					run.worktreeDir = worktree.dir;
					run.branch = worktree.branch;
					cwd = worktree.dir;
					prompt += `\n\nYou are working in a dedicated git worktree at ${worktree.dir} on branch ${worktree.branch}. Make and commit your code changes there. The card file path above is absolute and lives outside the worktree — edit it in place.`;
				}
			}

			run.state = 'working';
			run.startedAt = Date.now();
			run.lastOutputAt = Date.now();
			this._onDidChange.fire();
			this.output.appendLine(`\n=== ${new Date().toISOString()} ${run.kind} agent on "${run.card.title}" [${run.card.id}] (cwd: ${cwd}) ===`);

			if (run.kind === 'card') {
				await updateCardMeta(run.card.uri, { agentStatus: 'running' });
			}

			// Strip the nested-session markers so a claude child works even
			// when MarvinCode itself was launched from a claude session
			const env = { ...process.env };
			delete env['CLAUDECODE'];
			delete env['CLAUDE_CODE'];
			delete env['CLAUDE_CODE_ENTRYPOINT'];

			const child = spawn(claude, ['--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '-p', prompt], {
				cwd,
				env,
				stdio: ['pipe', 'pipe', 'pipe']
			});
			run.child = child;
			child.stdin?.end();

			let buffer = '';
			child.stdout?.on('data', (chunk: Buffer) => {
				buffer += chunk.toString('utf8');
				let newline;
				while ((newline = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					this.handleStreamLine(run, line);
				}
			});
			child.stderr?.on('data', (chunk: Buffer) => {
				run.stderrTail = (run.stderrTail + chunk.toString('utf8')).slice(-500);
			});
			child.on('close', code => {
				void this.finish(run, code ?? 1).finally(() => resolve(run));
			});
			child.on('error', error => {
				run.stderrTail = String(error).slice(-500);
				void this.finish(run, 1).finally(() => resolve(run));
			});
		} catch (error) {
			run.state = 'failed';
			run.endedAt = Date.now();
			run.stderrTail = String(error instanceof Error ? error.message : error).slice(-500);
			this.output.appendLine(`Failed to start agent: ${run.stderrTail}`);
			if (run.kind === 'card') {
				await updateCardMeta(run.card.uri, { agentStatus: 'failed' }).catch(() => undefined);
			}
			this._onDidChange.fire();
			resolve(run);
			this.pump();
		}
	}

	private handleStreamLine(run: AgentRun, line: string): void {
		if (!line.trim()) {
			return;
		}
		run.lastOutputAt = Date.now();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.output.appendLine(line);
			return;
		}
		if (parsed['type'] === 'system' && parsed['subtype'] === 'init' && typeof parsed['session_id'] === 'string') {
			run.claudeSessionId = parsed['session_id'];
			void appendCardSession(run.card.uri, run.claudeSessionId).catch(() => undefined);
			this.postGraphEvent(run, 'task.create', true, { phase: 'dispatch' });
			this._onDidChange.fire();
		} else if (parsed['type'] === 'assistant') {
			const message = parsed['message'] as { content?: { type: string; text?: string; name?: string }[] } | undefined;
			for (const block of message?.content ?? []) {
				if (block.type === 'text' && block.text) {
					this.output.appendLine(block.text);
				} else if (block.type === 'tool_use' && block.name) {
					run.toolNames.add(block.name);
					this.output.appendLine(`[tool] ${block.name}`);
				}
			}
		} else if (parsed['type'] === 'result' && typeof parsed['result'] === 'string') {
			this.output.appendLine(`--- result ---\n${parsed['result']}`);
		}
	}

	private async finish(run: AgentRun, exitCode: number): Promise<void> {
		const killed = run.state === 'killed';
		run.exitCode = exitCode;
		run.endedAt = Date.now();
		run.state = killed ? 'killed' : exitCode === 0 ? 'done' : 'failed';
		run.child = undefined;
		this.output.appendLine(`=== ${run.state} (exit ${exitCode}) "${run.card.title}" after ${Math.round((run.endedAt - (run.startedAt ?? run.endedAt)) / 1000)}s ===`);

		if (run.kind === 'card') {
			try {
				if (run.state === 'done') {
					await updateCardMeta(run.card.uri, { agentStatus: '' });
					await this.moveCardToDone(run);
					if (run.branch) {
						await appendHandoff(run.card.uri, { author: 'card-agent', note: `Code changes are on branch \`${run.branch}\` (worktree ${run.worktreeDir}).` });
					}
					this.cleanupWorktree(run);
				} else {
					await updateCardMeta(run.card.uri, { agentStatus: 'failed' });
					await appendHandoff(run.card.uri, {
						author: 'card-agent',
						blockers: killed ? 'Agent was killed before finishing.' : `Agent exited with code ${exitCode}.`,
						note: run.stderrTail ? `stderr tail:\n\n\`\`\`\n${run.stderrTail}\n\`\`\`` : undefined
					});
				}
			} catch (error) {
				this.output.appendLine(`Failed to update card after run: ${error}`);
			}
			this.postGraphEvent(run, 'task.complete', run.state === 'done', { exitCode, tools: [...run.toolNames] });
		}
		this._onDidChange.fire();
		this.pump();
	}

	private async moveCardToDone(run: AgentRun): Promise<void> {
		const boardText = new TextDecoder().decode(await vscode.workspace.fs.readFile(run.boardUri));
		const board = parseBoardFile(boardText);
		const done = doneColumnId(board);
		if (!done) {
			return;
		}
		await writeBoardFile(run.boardUri, moveCardInBoard(board, run.card.id, done, Number.MAX_SAFE_INTEGER));
		const card = (await loadCards(run.boardUri)).find(c => c.id === run.card.id);
		if (card && card.column !== done) {
			await setCardColumn(card.uri, done);
		}
	}

	private cleanupWorktree(run: AgentRun): void {
		if (!run.worktreeDir) {
			return;
		}
		try {
			// Only removes when the worktree is clean; a dirty worktree (or
			// one whose branch has unmerged commits) is left for review.
			const status = execFileSync('git', ['-C', run.worktreeDir, 'status', '--porcelain'], { encoding: 'utf8' });
			if (!status.trim()) {
				execFileSync('git', ['-C', run.worktreeDir, 'worktree', 'remove', run.worktreeDir], { encoding: 'utf8' });
			}
		} catch {
			// Leave the worktree in place
		}
	}

	/** Fire-and-forget event into the agent graph's ingest endpoint. */
	private postGraphEvent(run: AgentRun, verb: string, ok: boolean, payload: Record<string, unknown>): void {
		const port = vscode.workspace.getConfiguration('agentGraph').get<number>('ingestPort', 48620);
		const cardPath = run.card.uri.fsPath.replace(/\\/g, '/');
		fetch(`http://127.0.0.1:${port}/ingest`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				sessionId: run.claudeSessionId ?? run.id,
				actor: 'card-agent',
				verb,
				ok,
				objects: [
					{ type: 'task', key: run.card.id, label: `card ${run.card.id}` },
					{ type: 'file', key: cardPath, label: cardPath.split('/').pop() ?? cardPath }
				],
				payload
			})
		}).catch(() => undefined);
	}

	dispose(): void {
		for (const run of this.runs.values()) {
			if (run.state === 'working') {
				run.child?.kill('SIGTERM');
			}
		}
		this.output.dispose();
		this._onDidChange.dispose();
	}
}
