/**
 * POST /api/artist/verify-otp — code -> session cookie (BE3).
 *
 * First successful verify creates the artist row (email-OTP sign-in: the
 * verified email IS the account), then issues the signed HttpOnly session
 * cookie (see $lib/server/artist-session). Codes are exactly-once.
 *
 * Enumeration safety: `invalid_code` is returned identically for a wrong code,
 * a missing pending, and a malformed submission; nothing reveals whether an
 * artist account exists. The artist row is only written on a verified code.
 */

import { json } from '@sveltejs/kit';
import {
	ARTIST_SESSION_COOKIE,
	artistSessionCookieOptions,
	issueArtistSession
} from '$lib/server/artist-session';
import { normalizeEmail } from '$lib/server/email';
import { verifyOtp } from '$lib/server/otp';
import { toSqlUtc } from '$lib/server/time';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (!event.platform) {
		return json({ error: 'server_misconfigured' }, { status: 500 });
	}
	const env = event.platform.env;

	const body = await event.request.json().catch(() => null);
	const normalized = normalizeEmail((body as { email?: unknown } | null)?.email);
	const code = (body as { code?: unknown } | null)?.code;
	if (!normalized || typeof code !== 'string') {
		return json({ error: 'invalid_code' }, { status: 400 });
	}

	const result = await verifyOtp({
		db: env.DB,
		purpose: 'artist',
		subject: normalized.email,
		code,
		pepper: env.OTP_PEPPER,
		now: new Date()
	});

	if (!result.ok) {
		if (result.reason === 'expired') {
			// The pending the user themselves requested has lapsed; ask for a new one.
			return json({ error: 'expired_code' }, { status: 400 });
		}
		if (result.reason === 'locked') {
			return json({ error: 'too_many_attempts' }, { status: 429 });
		}
		return json({ error: 'invalid_code' }, { status: 400 });
	}

	// Verified: create the artist on first login (idempotent), stamp last login.
	const now = new Date();
	await env.DB.prepare('INSERT INTO artists (email) VALUES (?1) ON CONFLICT (email) DO NOTHING').bind(normalized.email).run();
	const artist = await env.DB.prepare('SELECT id FROM artists WHERE email = ?1').bind(normalized.email).first<{ id: number }>();
	if (!artist) {
		return json({ error: 'server_error' }, { status: 500 });
	}
	await env.DB.prepare('UPDATE artists SET last_login_at = ?1 WHERE id = ?2').bind(toSqlUtc(now), artist.id).run();

	const session = await issueArtistSession({ db: env.DB, artistId: artist.id, secret: env.SESSION_SECRET, now });
	event.cookies.set(ARTIST_SESSION_COOKIE, session.cookieValue, artistSessionCookieOptions(event.url.protocol === 'https:'));

	return json({ ok: true });
};
