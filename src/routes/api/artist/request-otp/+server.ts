/**
 * POST /api/artist/request-otp — email -> 6-digit code (BE3).
 *
 * Enumeration-safe by construction: no artist lookup happens here. A pending
 * OTP is created and mailed for ANY well-formed address, so the 200 body is
 * byte-identical whether or not an artist account exists (accounts are only
 * created at verify time). Rate-limit refusals describe the requester's own
 * prior activity (their IP / their pending), not account existence.
 */

import { json } from '@sveltejs/kit';
import { normalizeEmail } from '$lib/server/email';
import { createMailer } from '$lib/server/mailer';
import { OTP_LIMITS, requestOtp } from '$lib/server/otp';
import type { RequestHandler } from './$types';

function retryResponse(error: string, retryAfterSeconds: number, status: number) {
	return json({ error, retryAfterSeconds }, { status });
}

export const POST: RequestHandler = async (event) => {
	if (!event.platform) {
		return json({ error: 'server_misconfigured' }, { status: 500 });
	}
	const env = event.platform.env;

	const body = await event.request.json().catch(() => null);
	const normalized = normalizeEmail((body as { email?: unknown } | null)?.email);
	if (!normalized) {
		return json({ error: 'invalid_email' }, { status: 400 });
	}

	let ip = 'unknown';
	try {
		ip = event.getClientAddress();
	} catch {
		// No forwarding context (e.g. odd preview environments): bucket together.
	}

	const result = await requestOtp({
		db: env.DB,
		purpose: 'artist',
		subject: normalized.email,
		deliverTo: normalized.email,
		pepper: env.OTP_PEPPER,
		mailer: createMailer(env),
		ip,
		now: new Date()
	});

	if (result.ok) {
		// Same body for every address — nothing here depends on account existence.
		return json({ ok: true, expiresInSeconds: OTP_LIMITS.ttlSeconds, resendInSeconds: OTP_LIMITS.resendCooldownSeconds });
	}
	switch (result.reason) {
		case 'cooldown':
			return retryResponse('otp_cooldown', result.retryAfterSeconds, 429);
		case 'pending-exhausted':
			return retryResponse('otp_pending_exhausted', result.retryAfterSeconds, 429);
		case 'ip-rate-limited':
			return retryResponse('rate_limited', result.retryAfterSeconds, 429);
		case 'global-cap':
			// Distinct class per R2: the provider budget, not the user's fault.
			return retryResponse('email_throttled', result.retryAfterSeconds, 503);
		case 'send-failed':
			console.error('artist OTP send failed', result.cause);
			return json({ error: 'email_send_failed' }, { status: 502 });
	}
};
