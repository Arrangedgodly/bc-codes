/**
 * POST /api/artist/sign-out (BE3). Deletes the server-side session row behind
 * the cookie (signature-verified first) and clears the cookie. Idempotent:
 * no cookie / already-revoked session still returns ok.
 */

import { json } from '@sveltejs/kit';
import { ARTIST_SESSION_COOKIE, artistSessionCookieOptions, revokeArtistSession } from '$lib/server/artist-session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (event.platform) {
		await revokeArtistSession({
			db: event.platform.env.DB,
			cookieValue: event.cookies.get(ARTIST_SESSION_COOKIE),
			secret: event.platform.env.SESSION_SECRET
		});
	}
	const { maxAge: _maxAge, ...deleteOptions } = artistSessionCookieOptions(event.url.protocol === 'https:');
	event.cookies.delete(ARTIST_SESSION_COOKIE, deleteOptions);
	return json({ ok: true });
};
