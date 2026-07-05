/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemarkableApi } from 'rmapi-js';
import * as vscode from 'vscode';
import { RemarkableDoc } from './client';

const MAX_PAGES = 10;
const VENV_PYTHON = path.join(os.homedir(), '.marvincode', 'tools', 'rm-venv', 'bin', 'python3');

function resolvePython(): string {
	if (fs.existsSync(VENV_PYTHON)) {
		return VENV_PYTHON;
	}
	throw new Error(vscode.l10n.t(
		'Handwriting rendering needs the rmscene Python package. One-time setup:\n  python3 -m venv ~/.marvincode/tools/rm-venv && ~/.marvincode/tools/rm-venv/bin/pip install rmscene'));
}

function resolveMagick(): string {
	for (const candidate of ['/opt/homebrew/bin/magick', '/usr/local/bin/magick']) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	try {
		return execFileSync('which', ['magick'], { encoding: 'utf8' }).trim();
	} catch {
		throw new Error(vscode.l10n.t('Handwriting rendering needs ImageMagick (`brew install imagemagick`).'));
	}
}

/** Ordered page ids from the document's .content JSON (v6 cPages or legacy pages). */
function orderedPageIds(contentJson: Record<string, any>): string[] {
	const cPages = contentJson?.cPages?.pages;
	if (Array.isArray(cPages)) {
		return cPages.filter((page: any) => !page?.deleted).map((page: any) => page.id).filter((id: unknown): id is string => typeof id === 'string');
	}
	return Array.isArray(contentJson?.pages) ? contentJson.pages : [];
}

/**
 * Renders a handwritten notebook to PNG page images: sync-zip download →
 * .rm stroke files → SVG (rmscene, ported from agentic-kanban) → PNG
 * (ImageMagick). Returns the ordered PNG paths (capped at 10 pages).
 */
export async function renderNotebookPages(api: RemarkableApi, doc: RemarkableDoc, scratchRoot: string): Promise<string[]> {
	const python = resolvePython();
	const magick = resolveMagick();

	const zipBytes = await api.getDocument(doc.id, doc.hash);
	const workDir = fs.mkdtempSync(path.join(scratchRoot, 'rm-'));
	const zipPath = path.join(workDir, 'doc.zip');
	fs.writeFileSync(zipPath, Buffer.from(zipBytes));
	execFileSync('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', workDir]);

	// Page order comes from the .content JSON when present
	const findFile = (suffix: string): string | undefined => {
		const walk = (dir: string): string | undefined => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					const hit = walk(full);
					if (hit) {
						return hit;
					}
				} else if (entry.name.endsWith(suffix)) {
					return full;
				}
			}
			return undefined;
		};
		return walk(workDir);
	};
	const rmFiles = new Map<string, string>();
	const collect = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				collect(full);
			} else if (entry.name.endsWith('.rm')) {
				rmFiles.set(entry.name.replace(/\.rm$/, ''), full);
			}
		}
	};
	collect(workDir);
	if (!rmFiles.size) {
		throw new Error(vscode.l10n.t('"{0}" contains no handwriting pages.', doc.name));
	}

	let pageIds: string[] = [];
	const contentFile = findFile('.content');
	if (contentFile) {
		try {
			pageIds = orderedPageIds(JSON.parse(fs.readFileSync(contentFile, 'utf8')));
		} catch {
			// Fall back to directory order
		}
	}
	const ordered = pageIds.filter(id => rmFiles.has(id)).map(id => rmFiles.get(id)!);
	const pages = (ordered.length ? ordered : [...rmFiles.values()]).slice(0, MAX_PAGES);

	const pngPaths: string[] = [];
	for (let index = 0; index < pages.length; index++) {
		const svgPath = path.join(workDir, `page-${index + 1}.svg`);
		const pngPath = path.join(workDir, `page-${index + 1}.png`);
		try {
			const svg = execFileSync(python, [path.join(__dirname, '..', '..', 'scripts', 'rm_to_svg.py'), pages[index]], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
			fs.writeFileSync(svgPath, svg);
			execFileSync(magick, ['-background', 'white', svgPath, '-flatten', '-resize', '1404x1872', pngPath], { timeout: 30_000 });
			pngPaths.push(pngPath);
		} catch {
			// A page that fails to render is skipped, matching agentic-kanban
		}
	}
	if (!pngPaths.length) {
		throw new Error(vscode.l10n.t('None of the pages of "{0}" could be rendered.', doc.name));
	}
	return pngPaths;
}
