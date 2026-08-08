import { error } from '@sveltejs/kit';
import type { SessionUser } from './auth.js';

/**
 * Route guards and the SSE helper.
 *
 * Every handler under /api starts with one of these guards on its first line.
 * That convention is why there is no route-level auth config to forget.
 */

export function requireUser(locals: App.Locals): SessionUser {
	if (!locals.user) error(401, 'Unauthorized');
	return locals.user;
}

export function requireAdmin(locals: App.Locals): SessionUser {
	const user = requireUser(locals);
	if (!user.isAdmin) error(403, 'Admin only');
	return user;
}

/** Parse a JSON body without throwing on empty or malformed input. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
	return (await request.json().catch(() => ({}))) as T;
}

export interface SseController {
	send(event: string, data: unknown): void;
	close(): void;
}

/**
 * Server-sent events with a heartbeat.
 *
 * The 25-second ping exists because idle proxies drop connections at 30-60s,
 * and a long AI composition turn produces nothing to send for minutes at a
 * time. `setup` returns its own teardown, called on both server close and
 * client disconnect so there is exactly one cleanup path.
 */
export function sseResponse(setup: (ctrl: SseController) => (() => void) | void): Response {
	let cleanup: (() => void) | void;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			let closed = false;

			const ctrl: SseController = {
				send(event, data) {
					if (closed) return;
					try {
						controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
					} catch {
						closed = true;
					}
				},
				close() {
					if (closed) return;
					closed = true;
					try {
						controller.close();
					} catch {
						/* already closed by the client */
					}
				}
			};

			heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(enc.encode(': ping\n\n'));
				} catch {
					closed = true;
				}
			}, 25_000);
			heartbeat.unref?.();

			cleanup = setup(ctrl);
		},
		cancel() {
			if (heartbeat) clearInterval(heartbeat);
			cleanup?.();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			// Belt and braces for any proxy that buffers by default.
			'x-accel-buffering': 'no'
		}
	});
}
