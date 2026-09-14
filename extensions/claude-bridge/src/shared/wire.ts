/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { z } from 'zod';

export const Request = z.object({
	id: z.string(),
	tool: z.string(),
	args: z.unknown(),
});
export type RequestT = z.infer<typeof Request>;

export const Response = z.union([
	z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
	z.object({
		id: z.string(),
		ok: z.literal(false),
		error: z.object({ code: z.string(), message: z.string() }),
	}),
]);
export type ResponseT = z.infer<typeof Response>;

export const FRAME_DELIMITER = '\n';

export function frame(obj: unknown): string {
	return JSON.stringify(obj) + FRAME_DELIMITER;
}

export function parseFrames(buffer: string): { messages: unknown[]; remainder: string } {
	const messages: unknown[] = [];
	let remainder = buffer;
	let idx = remainder.indexOf(FRAME_DELIMITER);
	while (idx !== -1) {
		const line = remainder.slice(0, idx);
		remainder = remainder.slice(idx + 1);
		if (line.trim().length > 0) {
			try {
				messages.push(JSON.parse(line));
			} catch {
				// skip malformed frame
			}
		}
		idx = remainder.indexOf(FRAME_DELIMITER);
	}
	return { messages, remainder };
}
