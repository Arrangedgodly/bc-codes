/**
 * POST /api/fan/verify-otp — code -> long-lived fan session cookie (BE4).
 *
 * Verifies against the fan OTP pending (subject = the canonical email HMAC),
 * then idempotently ensures the fan identity row and issues the 180-day
 * sliding fan session (see $lib/server/fan-session). The response body is
 * just `{ ok: true }` — it never echoes the email hash.
 *
 * Enumeration safety mirrors the artist endpoint: `invalid_code` is returned
 * identically for a wrong code, a missing pending, and a malformed
 * submission; the identity row is only written on a verified code (BE5's
 * dispense also upserts it, so either order works).
 */

import { json } from '@sveltejs/kit';
import { ensureFanIdentity, hashFanEmail } from '$lib/server/fan-identity';
import { FAN_SESSION_COOKIE, fanSessionCookieOptions, issueFanSession } from '$lib/server/fan-session';
import { normalizeEmail } from '$lib/server/email';
import { verifyOtp } from '$lib/server/otp';
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

	const fanHash = await hashFanEmail(normalized.email, env.EMAIL_PEPPER);
	const result = await verifyOtp({
		db: env.DB,
		purpose: 'fan',
		subject: fanHash,
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

	// Verified: ensure the hash-only identity (idempotent), then the session.
	const now = new Date();
	const identity = await ensureFanIdentity({ db: env.DB, fanHash, now });
	const session = await issueFanSession({ db: env.DB, fanId: identity.fanId, secret: env.SESSION_SECRET, now });
	event.cookies.set(FAN_SESSION_COOKIE, session.cookieValue, fanSessionCookieOptions(event.url.protocol === 'https:'));

	return json({ ok: true });
};
