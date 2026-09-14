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

/** Locate a binary in the common Homebrew prefixes, then on PATH. */
function locate(name: string, prefixes: string[]): string | undefined {
	for (const candidate of prefixes) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	try {
		const hit = execFileSync('which', [name], { encoding: 'utf8' }).trim();
		return hit || undefined;
	} catch {
		return undefined;
	}
}

// Rasterize the SVG at 3x its intrinsic px size — crisp enough that a vision
// model can read small handwriting without the file becoming needlessly huge.
const RASTER_SCALE = 3;
// A gentle contrast stretch applied to the raster: deepens faint pencil strokes
// toward black and cleans the near-white background, WITHOUT hard thresholding
// (which would re-introduce the aliasing we removed). Preserves colour and the
// anti-aliased stroke edges. `-level black,white`: input <=20% -> black,
// >=93% -> white, the rest stretched linearly.
const CONTRAST_LEVELS = '20%,93%';

/**
 * A function that rasterizes an SVG file to a PNG file. We prefer librsvg
 * (`rsvg-convert`): it anti-aliases strokes properly, giving crisp handwriting.
 * ImageMagick is only a fallback for the SVG step — its built-in MSVG renderer
 * produces aliased, near 1-bit output that makes handwriting blocky to read/OCR
 * — but it is still used (when present) for the raster contrast pass, which is a
 * plain PNG->PNG operation it handles well.
 */
function resolveRasterizer(): (svgPath: string, pngPath: string) => void {
	const magick = locate('magick', ['/opt/homebrew/bin/magick', '/usr/local/bin/magick']);
	const applyContrast = (pngPath: string): void => {
		if (magick) {
			execFileSync(magick, [pngPath, '-level', CONTRAST_LEVELS, pngPath], { timeout: 30_000 });
		}
	};

	const rsvg = locate('rsvg-convert', ['/opt/homebrew/bin/rsvg-convert', '/usr/local/bin/rsvg-convert']);
	if (rsvg) {
		return (svgPath, pngPath) => {
			execFileSync(rsvg, ['-z', String(RASTER_SCALE), '-b', 'white', '-o', pngPath, svgPath], { timeout: 30_000 });
			applyContrast(pngPath);
		};
	}
	if (magick) {
		// Fallback: ImageMagick does both the (lower-quality) SVG render and the
		// contrast stretch in one pass.
		return (svgPath, pngPath) => {
			execFileSync(magick, ['-density', String(96 * RASTER_SCALE), '-background', 'white', svgPath, '-flatten', '-level', CONTRAST_LEVELS, pngPath], { timeout: 30_000 });
		};
	}
	throw new Error(vscode.l10n.t(
		'Handwriting rendering needs an SVG rasterizer. Install librsvg (recommended, crisp output): `brew install librsvg` — or ImageMagick: `brew install imagemagick`.'));
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
 * (librsvg, falling back to ImageMagick). Returns the ordered PNG paths
 * (capped at 10 pages).
 */
export async function renderNotebookPages(api: RemarkableApi, doc: RemarkableDoc, scratchRoot: string): Promise<string[]> {
	const python = resolvePython();
	const rasterize = resolveRasterizer();

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
			rasterize(svgPath, pngPath);
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
