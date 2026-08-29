/**
 * Console client helpers (FE5) — the fetch plumbing shared by the artist
 * console pages. One rule above all: a 401 from any artist endpoint means
 * the session lapsed, and the artist is sent to sign-in with the current
 * path as the return target (mirroring the server-side route gate), never
 * left on a dead button. Callers stop by catching SessionLapsed.
 *
 * Client-only module (imports $app/navigation) — never import from a
 * +page.server.ts.
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';

/** Thrown after the sign-in redirect has been issued — abort the caller's flow. */
export class SessionLapsed extends Error {
	constructor() {
		super('artist session lapsed — redirected to sign-in');
	}
}

/** A JSON body as the console reads it: anything the endpoints may answer with. */
export type ConsoleJson = (Record<string, unknown> & {
	error?: string;
	message?: string;
	retryAfterSeconds?: number;
	resendInSeconds?: number;
}) | null;

export async function consoleFetch(path: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(path, init);
	if (res.status === 401) {
		void goto(`/console/sign-in?returnTo=${encodeURIComponent(page.url.pathname)}`);
		throw new SessionLapsed();
	}
	return res;
}

export async function consoleJsonBody(res: Response): Promise<ConsoleJson> {
	return (await res.json().catch(() => null)) as ConsoleJson;
}

/** POST JSON — the console's default verb against the BE7/BE8 endpoints. */
export async function postConsoleJson(path: string, body: unknown): Promise<{ res: Response; body: ConsoleJson }> {
	const res = await consoleFetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { res, body: await consoleJsonBody(res) };
}

/** PATCH JSON (project edits + pause/resume). */
export async function patchConsoleJson(path: string, body: unknown): Promise<{ res: Response; body: ConsoleJson }> {
	const res = await consoleFetch(path, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { res, body: await consoleJsonBody(res) };
}

/** SQL-UTC 'YYYY-MM-DD HH:MM:SS' → the honest console rendering. */
export function fmtSqlUtc(sql: string | null): string {
	if (!sql) return '—';
	const utc = sql.length === 19 ? sql.slice(0, 16).replace('T', ' ') : sql;
	return `${utc} UTC`;
}
