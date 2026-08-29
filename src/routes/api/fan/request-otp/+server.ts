/**
 * POST /api/fan/request-otp — email -> 6-digit code (BE4).
 *
 * Reuses the BE3 OTP machinery with `purpose: 'fan'`: the pending's subject is
 * the fan's canonical HMAC hash (hashFanEmail), NOT the email — no readable
 * fan PII lands in otp_pendings; the plaintext address exists only inside the
 * mailer call. The response never echoes the hash (or the email).
 *
 * Enumeration-safe by construction: no fan_identities/claims lookup happens
 * here — a pending is created and mailed for ANY well-formed address, so the
 * 200 body is byte-identical whether or not the email holds claims. Rate
 * limits are wired exactly like the artist endpoint (getClientAddress ->
 * requestOtp's per-IP windows); fan and artist sends from one IP share the
 * same per-IP and global budgets by design (one mailer budget per visitor,
 * one per app — see otp.ts's matrix).
 */

import { json } from '@sveltejs/kit';
import { hashFanEmail } from '$lib/server/fan-identity';
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

	// subject = canonical hash (identity); deliverTo = plaintext (mailer only).
	const fanHash = await hashFanEmail(normalized.email, env.EMAIL_PEPPER);
	const result = await requestOtp({
		db: env.DB,
		purpose: 'fan',
		subject: fanHash,
		deliverTo: normalized.email,
		pepper: env.OTP_PEPPER,
		mailer: createMailer(env),
		ip,
		now: new Date()
	});

	if (result.ok) {
		// Same body for every address — nothing here depends on claim existence.
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
			console.error('fan OTP send failed', result.cause);
			return json({ error: 'email_send_failed' }, { status: 502 });
	}
};
