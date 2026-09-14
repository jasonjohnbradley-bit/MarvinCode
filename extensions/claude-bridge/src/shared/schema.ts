/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Single source of truth for the bridge's tool surface: both the MCP server
// (which advertises the tools to Claude Code) and the extension-side socket
// server (which validates and dispatches them) import from here.

import { z } from 'zod';

export const PositionSchema = z.object({
	line: z.number().int().nonnegative(),
	character: z.number().int().nonnegative(),
});

export const RangeSchema = z.object({
	start: PositionSchema,
	end: PositionSchema,
});

export const TabSchema = z.object({
	uri: z.string(),
	label: z.string(),
	isActive: z.boolean(),
	isDirty: z.boolean(),
	isPinned: z.boolean(),
	viewColumn: z.number().int().nullable(),
	kind: z.enum(['text', 'notebook', 'webview', 'terminal', 'diff', 'custom', 'other']),
});

export const GetEditorStateOutput = z.object({
	activeFile: z
		.object({
			uri: z.string(),
			languageId: z.string(),
			isDirty: z.boolean(),
			isUntitled: z.boolean(),
			lineCount: z.number().int(),
			cursor: PositionSchema.nullable(),
			selection: z
				.object({
					range: RangeSchema,
					text: z.string(),
				})
				.nullable(),
			visibleRanges: z.array(RangeSchema),
		})
		.nullable(),
	openTabs: z.array(TabSchema),
});

export const GetDirtyBufferInput = z.object({
	uri: z.string(),
	range: RangeSchema.optional(),
	maxBytes: z.number().int().positive().max(10_000_000).optional(),
});

export const GetDirtyBufferOutput = z.object({
	uri: z.string(),
	scheme: z.string(),
	isUntitled: z.boolean(),
	isDirty: z.boolean(),
	languageId: z.string(),
	content: z.string(),
	truncated: z.boolean(),
	sizeBytes: z.number().int().nonnegative(),
});

export const ListDirtyBuffersOutput = z.object({
	buffers: z.array(
		z.object({
			uri: z.string(),
			scheme: z.string(),
			isUntitled: z.boolean(),
			languageId: z.string(),
			sizeBytes: z.number().int().nonnegative(),
		})
	),
});

export const GetDebugStateOutput = z.object({
	activeSession: z
		.object({
			id: z.string(),
			name: z.string(),
			type: z.string(),
		})
		.nullable(),
	breakpoints: z.array(
		z.object({
			uri: z.string().nullable(),
			line: z.number().int().nullable(),
			condition: z.string().nullable(),
			enabled: z.boolean(),
		})
	),
});

export const OpenSimpleBrowserInput = z.object({
	url: z.string().url(),
	reuse: z.boolean().default(true),
});

export const OpenSimpleBrowserOutput = z.object({
	url: z.string(),
	reused: z.boolean(),
});

export const ListSimpleBrowserTabsOutput = z.object({
	tabs: z.array(
		z.object({
			url: z.string().nullable(),
			label: z.string(),
			isActive: z.boolean(),
			tracked: z.boolean(),
		})
	),
});

export const CloseSimpleBrowserInput = z.object({
	all: z.boolean().default(false),
});

export const CloseSimpleBrowserOutput = z.object({
	closed: z.number().int().nonnegative(),
});

// --- Integrated Browser (real Chromium, shared with agents) ---

export const ListBrowserPagesOutput = z.object({
	pages: z.array(
		z.object({
			id: z.string(),
			url: z.string(),
			title: z.string(),
			shared: z.boolean(),
		})
	),
});

export const OpenBrowserPageInput = z.object({
	url: z.string().url(),
	forceNew: z.boolean().default(false),
});

export const OpenBrowserPageOutput = z.object({
	pageId: z.string(),
	summary: z.string(),
	reused: z.boolean(),
});

export const ShareBrowserPageInput = z.object({
	pageId: z.string(),
});

export const ShareBrowserPageOutput = z.object({
	shared: z.boolean(),
});

export const ReadBrowserPageInput = z.object({
	pageId: z.string(),
});

export const ReadBrowserPageOutput = z.object({
	summary: z.string(),
});

export const ScreenshotBrowserPageInput = z.object({
	pageId: z.string(),
	ref: z.string().optional(),
	selector: z.string().optional(),
});

export const ScreenshotBrowserPageOutput = z.object({
	path: z.string(),
});

export const NavigateBrowserPageInput = z.object({
	pageId: z.string(),
	url: z.string().url().optional(),
	action: z.enum(['back', 'forward', 'reload']).optional(),
});

export const NavigateBrowserPageOutput = z.object({
	summary: z.string(),
});

export const ClickBrowserElementInput = z.object({
	pageId: z.string(),
	ref: z.string().optional(),
	selector: z.string().optional(),
	dblClick: z.boolean().default(false),
	button: z.enum(['left', 'right', 'middle']).default('left'),
});

export const InteractionOutput = z.object({
	result: z.unknown().optional(),
	error: z.string().optional(),
	summary: z.string(),
});

export const TypeInBrowserPageInput = z.object({
	pageId: z.string(),
	ref: z.string().optional(),
	selector: z.string().optional(),
	text: z.string().optional(),
	key: z.string().optional(),
	submit: z.boolean().default(false),
});

export type GetEditorStateOutputT = z.infer<typeof GetEditorStateOutput>;
export type GetDirtyBufferInputT = z.infer<typeof GetDirtyBufferInput>;
export type GetDirtyBufferOutputT = z.infer<typeof GetDirtyBufferOutput>;
export type ListDirtyBuffersOutputT = z.infer<typeof ListDirtyBuffersOutput>;
export type GetDebugStateOutputT = z.infer<typeof GetDebugStateOutput>;
export type OpenSimpleBrowserInputT = z.infer<typeof OpenSimpleBrowserInput>;
export type OpenSimpleBrowserOutputT = z.infer<typeof OpenSimpleBrowserOutput>;
export type ListSimpleBrowserTabsOutputT = z.infer<typeof ListSimpleBrowserTabsOutput>;
export type CloseSimpleBrowserInputT = z.infer<typeof CloseSimpleBrowserInput>;
export type CloseSimpleBrowserOutputT = z.infer<typeof CloseSimpleBrowserOutput>;
export type ListBrowserPagesOutputT = z.infer<typeof ListBrowserPagesOutput>;
export type OpenBrowserPageInputT = z.infer<typeof OpenBrowserPageInput>;
export type OpenBrowserPageOutputT = z.infer<typeof OpenBrowserPageOutput>;
export type ShareBrowserPageInputT = z.infer<typeof ShareBrowserPageInput>;
export type ShareBrowserPageOutputT = z.infer<typeof ShareBrowserPageOutput>;
export type ReadBrowserPageInputT = z.infer<typeof ReadBrowserPageInput>;
export type ReadBrowserPageOutputT = z.infer<typeof ReadBrowserPageOutput>;
export type ScreenshotBrowserPageInputT = z.infer<typeof ScreenshotBrowserPageInput>;
export type ScreenshotBrowserPageOutputT = z.infer<typeof ScreenshotBrowserPageOutput>;
export type NavigateBrowserPageInputT = z.infer<typeof NavigateBrowserPageInput>;
export type NavigateBrowserPageOutputT = z.infer<typeof NavigateBrowserPageOutput>;
export type ClickBrowserElementInputT = z.infer<typeof ClickBrowserElementInput>;
export type InteractionOutputT = z.infer<typeof InteractionOutput>;
export type TypeInBrowserPageInputT = z.infer<typeof TypeInBrowserPageInput>;

export const ToolName = z.enum([
	'getEditorState',
	'getDirtyBuffer',
	'listDirtyBuffers',
	'getDebugState',
	'openSimpleBrowser',
	'listSimpleBrowserTabs',
	'closeSimpleBrowser',
	'listBrowserPages',
	'openBrowserPage',
	'shareBrowserPage',
	'readBrowserPage',
	'screenshotBrowserPage',
	'navigateBrowserPage',
	'clickBrowserElement',
	'typeInBrowserPage',
]);
export type ToolNameT = z.infer<typeof ToolName>;

export const TOOL_INPUT_SCHEMAS = {
	getEditorState: z.object({}),
	getDirtyBuffer: GetDirtyBufferInput,
	listDirtyBuffers: z.object({}),
	getDebugState: z.object({}),
	openSimpleBrowser: OpenSimpleBrowserInput,
	listSimpleBrowserTabs: z.object({}),
	closeSimpleBrowser: CloseSimpleBrowserInput,
	listBrowserPages: z.object({}),
	openBrowserPage: OpenBrowserPageInput,
	shareBrowserPage: ShareBrowserPageInput,
	readBrowserPage: ReadBrowserPageInput,
	screenshotBrowserPage: ScreenshotBrowserPageInput,
	navigateBrowserPage: NavigateBrowserPageInput,
	clickBrowserElement: ClickBrowserElementInput,
	typeInBrowserPage: TypeInBrowserPageInput,
} as const satisfies Record<ToolNameT, z.ZodTypeAny>;

export const TOOL_OUTPUT_SCHEMAS = {
	getEditorState: GetEditorStateOutput,
	getDirtyBuffer: GetDirtyBufferOutput,
	listDirtyBuffers: ListDirtyBuffersOutput,
	getDebugState: GetDebugStateOutput,
	openSimpleBrowser: OpenSimpleBrowserOutput,
	listSimpleBrowserTabs: ListSimpleBrowserTabsOutput,
	closeSimpleBrowser: CloseSimpleBrowserOutput,
	listBrowserPages: ListBrowserPagesOutput,
	openBrowserPage: OpenBrowserPageOutput,
	shareBrowserPage: ShareBrowserPageOutput,
	readBrowserPage: ReadBrowserPageOutput,
	screenshotBrowserPage: ScreenshotBrowserPageOutput,
	navigateBrowserPage: NavigateBrowserPageOutput,
	clickBrowserElement: InteractionOutput,
	typeInBrowserPage: InteractionOutput,
} as const satisfies Record<ToolNameT, z.ZodTypeAny>;
