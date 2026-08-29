/**
 * POST /api/fan/sign-out (BE4). Deletes the server-side fan session row
 * behind the cookie (signature-verified first) and clears the cookie.
 * Idempotent: no cookie / already-revoked session still returns ok.
 */

import { json } from '@sveltejs/kit';
import { FAN_SESSION_COOKIE, fanSessionCookieOptions, revokeFanSession } from '$lib/server/fan-session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (event.platform) {
		await revokeFanSession({
			db: event.platform.env.DB,
			cookieValue: event.cookies.get(FAN_SESSION_COOKIE),
			secret: event.platform.env.SESSION_SECRET
		});
	}
	const { maxAge: _maxAge, ...deleteOptions } = fanSessionCookieOptions(event.url.protocol === 'https:');
	event.cookies.delete(FAN_SESSION_COOKIE, deleteOptions);
	return json({ ok: true });
};
