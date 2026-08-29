/**
 * OTP core (BE3) — generate, store, throttle, verify 6-digit email codes.
 *
 * Dual-purpose by schema (migrations/0001_init.sql `otp_pendings`): the
 * `subject` is the plaintext email for artists and will be the fan email HMAC
 * hash for fans (BE4), so no readable fan PII ever lands in this table. The
 * code itself is stored only as HMAC-SHA256(code, OTP_PEPPER) — a database
 * leak reveals neither codes nor pepper.
 *
 * Rate-limit matrix (production-owned specifics; every number is enforced in
 * code below and overridable per call for tests / QA1):
 *
 * | Control               | Value                    | Enforced via                    |
 * |-----------------------|--------------------------|---------------------------------|
 * | Code shape            | 6 digits, crypto-random  | generateOtpCode (rejection      |
 * |                       | (unbiased)               | sampling — no modulo bias)      |
 * | OTP lifetime          | 10 minutes               | expires_at                      |
 * | Verify attempts       | 5 per code, then the     | attempts (lockout deletes the   |
 * |                       | pending is invalidated   | pending — brute force gets 5    |
 * |                       |                          | guesses per 10^6-code space)    |
 * | Resend cooldown       | 60 s per subject         | last_sent_at                    |
 * | Sends per pending     | 3 (initial + 2 resends)  | send_count (a new cycle starts  |
 * |                       |                          | only after expiry)              |
 * | Per-IP short window   | 5 sends / 10 min         | otp_rate_counters 'ip10m:<ip>'  |
 * | Per-IP daily window   | 20 sends / 24 h          | otp_rate_counters 'ip1d:<ip>'   |
 * | Global daily window   | 80 sends / 24 h          | otp_rate_counters 'global1d'    |
 *
 * Why these numbers keep us "comfortably under" Resend's free 100/day cap
 * (R2: docs/ultron/research/R2-email-provider.md):
 *   - The global window is a hard ceiling on ACTUAL sends: 80 < 100, leaving
 *     20/day of headroom for retries/clock skew regardless of how many IPs an
 *     attacker rotates. Blocked attempts never reach the mailer, and a block
 *     at an earlier step does not increment later counters, so spam cannot
 *     exhaust the global budget without sending.
 *   - Per-IP 20/day means one abusive visitor costs at most 20 sends; a
 *     NAT-shared crowd (school/office) still gets 20 people/day through, which
 *     matches MVP scale (a drop has at most a few hundred fans).
 *   - Per-subject 3 sends / 10 min bounds mail per identity: a frustrated
 *     legit user gets at most 3 codes per cycle, an identity-flooder at most
 *     3/10min = 432/day — but the per-IP and global windows sit above that
 *     and cut the real totals to <=20/IP and <=80 overall.
 *   - Realistic MVP volume is a few dozen sends/day (artists sign in rarely;
 *     fans verify once per browser), so the binding constraints are the abuse
 *     windows, not the caps.
 * Windows are FIXED (UTC-midnight-aligned for daily, clock-10-min for short):
 * trivially testable, no sliding bookkeeping; worst case a boundary-straddler
 * gets 2x one window's limit across two windows, which the caps absorb.
 *
 * Enumeration safety: `requestOtp` never consults any identity table — a
 * pending is created and "sent" for ANY well-formed address, so responses do
 * not depend on whether an account exists (artists are only created at verify
 * time). `verifyOtp` returns the same `invalid` for "no pending" and "wrong
 * code".
 */

import type { D1Database } from '@cloudflare/workers-types';
import { hmacHex, timingSafeEqual } from './crypto';
import type { Mailer } from './mailer';
import { fromSqlUtc, toSqlUtc, windowStart } from './time';

/** The two populations sharing otp_pendings. */
export type OtpPurpose = 'artist' | 'fan';

/** Full limit set; every field overridable per call (tests, QA1, ops tuning). */
export interface OtpLimits {
	/** Seconds a code stays valid. */
	ttlSeconds: number;
	/** Seconds a subject must wait between sends. */
	resendCooldownSeconds: number;
	/** Max sends (initial + resends) before the pending must expire. */
	maxSendsPerPending: number;
	/** Max failed verifies before the pending is invalidated. */
	maxVerifyAttempts: number;
	/** Per-IP sends per short window. */
	ipWindowSends: number;
	/** Short window length (ms). */
	ipWindowMs: number;
	/** Per-IP sends per daily window. */
	ipDailySends: number;
	/** Daily window length (ms) — also the global window. */
	dailyWindowMs: number;
	/** Whole-app sends per daily window; keeps us under the provider cap. */
	globalDailySends: number;
}

/** The production matrix (see the table above). */
export const OTP_LIMITS: OtpLimits = {
	ttlSeconds: 600,
	resendCooldownSeconds: 60,
	maxSendsPerPending: 3,
	maxVerifyAttempts: 5,
	ipWindowSends: 5,
	ipWindowMs: 10 * 60 * 1000,
	ipDailySends: 20,
	dailyWindowMs: 24 * 60 * 60 * 1000,
	globalDailySends: 80
};

/** Everything the OTP request path needs. */
export interface RequestOtpDeps {
	db: D1Database;
	/** 'artist' now; 'fan' from BE4 on. */
	purpose: OtpPurpose;
	/** Storage key: plaintext email (artist) or its HMAC hash (fan). */
	subject: string;
	/** Delivery address for the mailer (equals subject for artists). */
	deliverTo: string;
	/** OTP_PEPPER — codes are hashed before storage. */
	pepper: string;
	mailer: Mailer;
	/** Client address for the per-IP windows ('' -> 'unknown'). */
	ip: string;
	/** Injected clock — every rule is deterministic under test. */
	now: Date;
	/** Optional per-call limit overrides merged over OTP_LIMITS. */
	limits?: Partial<OtpLimits>;
}

/** How the request path refused the send (retryable) or failed it. */
export type OtpRequestResult =
	| { ok: true; expiresAt: Date; resendAvailableAt: Date }
	| { ok: false; reason: 'cooldown'; retryAfterSeconds: number }
	| { ok: false; reason: 'pending-exhausted'; retryAfterSeconds: number }
	| { ok: false; reason: 'ip-rate-limited'; retryAfterSeconds: number }
	| { ok: false; reason: 'global-cap'; retryAfterSeconds: number }
	| { ok: false; reason: 'send-failed'; cause: unknown };

/** Everything the verify path needs. */
export interface VerifyOtpDeps {
	db: D1Database;
	purpose: OtpPurpose;
	subject: string;
	/** The submitted code as typed by the user. */
	code: string;
	pepper: string;
	now: Date;
	limits?: Partial<OtpLimits>;
}

/**
 * Verify outcomes. `invalid` covers no-pending / wrong code / malformed input
 * (enumeration-safe); `expired` and `locked` only ever describe a pending the
 * requester themselves created, so they leak nothing about accounts.
 */
export type OtpVerifyResult = { ok: true } | { ok: false; reason: 'invalid' } | { ok: false; reason: 'expired' } | { ok: false; reason: 'locked' };

interface PendingRow {
	code_hash: string;
	attempts: number;
	send_count: number;
	last_sent_at: string | null;
	expires_at: string;
}

const CODE_PATTERN = /^\d{6}$/;

/**
 * Cryptographically secure 6-digit code with rejection sampling: uniform
 * draws below the largest multiple of 1_000_000 in 2^32, so no digit is even
 * slightly favored (modulo bias would otherwise skew the last digits).
 */
export function generateOtpCode(): string {
	const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000; // 4_294_000_000
	const buffer = new Uint32Array(1);
	let value: number;
	do {
		crypto.getRandomValues(buffer);
		value = buffer[0]!;
	} while (value >= limit);
	return String(value % 1_000_000).padStart(6, '0');
}

/** HMAC-SHA256(code, pepper) hex — the only stored form of a code. */
export async function hashOtp(code: string, pepper: string): Promise<string> {
	return hmacHex(code, pepper);
}

function mergedLimits(overrides?: Partial<OtpLimits>): OtpLimits {
	return { ...OTP_LIMITS, ...overrides };
}

/** Seconds until `at`, floored at 0 (never promise a negative wait). */
function secondsUntil(at: number, now: number): number {
	return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Atomically increment a fixed-window counter and return the new value.
 * Blocked attempts therefore consume quota (conservative: an attacker's
 * traffic counts against itself); a check at an earlier step never increments
 * later windows, so blocked traffic cannot drain the global budget.
 */
async function incrementCounter(
	db: D1Database,
	scope: string,
	start: Date,
	now: Date,
	dailyWindowMs: number
): Promise<number> {
	// Lazy janitor: drop closed windows (PK-indexed scan of a tiny table).
	await db
		.prepare('DELETE FROM otp_rate_counters WHERE window_start < ?1')
		.bind(toSqlUtc(new Date(now.getTime() - dailyWindowMs)))
		.run();
	const row = await db
		.prepare(
			`INSERT INTO otp_rate_counters (scope, window_start, sends)
			 VALUES (?1, ?2, 1)
			 ON CONFLICT (scope, window_start) DO UPDATE SET sends = otp_rate_counters.sends + 1
			 RETURNING sends`
		)
		.bind(scope, toSqlUtc(start))
		.first<{ sends: number }>();
	return row?.sends ?? 1;
}

/**
 * Fetch the pending for a subject, classifying staleness. An expired row is
 * deleted (freeing the UNIQUE(purpose, subject) slot for a fresh cycle) but
 * still reported via `expired` so verify can answer `expired` — distinct from
 * `invalid` — instead of silently treating a real pending as absent.
 */
async function loadPending(
	db: D1Database,
	purpose: OtpPurpose,
	subject: string,
	now: Date
): Promise<{ row: PendingRow | null; expired: boolean }> {
	const row = await db
		.prepare('SELECT code_hash, attempts, send_count, last_sent_at, expires_at FROM otp_pendings WHERE purpose = ?1 AND subject = ?2')
		.bind(purpose, subject)
		.first<PendingRow>();
	if (!row) return { row: null, expired: false };
	if (fromSqlUtc(row.expires_at) <= now.getTime()) {
		await db.prepare('DELETE FROM otp_pendings WHERE purpose = ?1 AND subject = ?2').bind(purpose, subject).run();
		return { row: null, expired: true };
	}
	return { row, expired: false };
}

/**
 * Create (or resend) an OTP for a subject, applying the full matrix.
 *
 * Order matters: the cheap, identity-local checks (cooldown, per-pending cap)
 * run BEFORE any counter increments, so a harmless double-click costs no IP
 * quota; then the counters go ip-short -> ip-daily -> global, stopping at the
 * first refusal. Only after all gates pass is the mailer called — the store
 * happens first so a failed send leaves a verifiable pending the user can
 * retry after the cooldown rather than a mailed-but-unverifiable code.
 */
export async function requestOtp(deps: RequestOtpDeps): Promise<OtpRequestResult> {
	const { db, purpose, subject, deliverTo, pepper, mailer, now } = deps;
	const limits = mergedLimits(deps.limits);
	const nowMs = now.getTime();

	const pending = await loadPending(db, purpose, subject, now).then(({ row }) => row);
	if (pending) {
		const lastSentMs = pending.last_sent_at ? fromSqlUtc(pending.last_sent_at) : 0;
		const cooldownEndsMs = lastSentMs + limits.resendCooldownSeconds * 1000;
		if (cooldownEndsMs > nowMs) {
			return { ok: false, reason: 'cooldown', retryAfterSeconds: secondsUntil(cooldownEndsMs, nowMs) };
		}
		if (pending.send_count >= limits.maxSendsPerPending) {
			// Too many resends for this code cycle: wait for it to expire.
			const expiresMs = fromSqlUtc(pending.expires_at);
			return { ok: false, reason: 'pending-exhausted', retryAfterSeconds: secondsUntil(expiresMs, nowMs) };
		}
	}

	const ip = deps.ip.trim() || 'unknown';
	// Scopes encode the window LENGTH, not just the subject: a 10-minute window
	// starting exactly at UTC midnight would otherwise share a row with the
	// daily window of the same IP and double-count every send (00:00–00:10 UTC).
	const ipShortScope = `ip10m:${ip}`;
	const ipDayScope = `ip1d:${ip}`;

	const shortStart = windowStart(now, limits.ipWindowMs);
	if ((await incrementCounter(db, ipShortScope, shortStart, now, limits.dailyWindowMs)) > limits.ipWindowSends) {
		const nextWindowMs = shortStart.getTime() + limits.ipWindowMs;
		return { ok: false, reason: 'ip-rate-limited', retryAfterSeconds: secondsUntil(nextWindowMs, nowMs) };
	}

	const dayStart = windowStart(now, limits.dailyWindowMs);
	if ((await incrementCounter(db, ipDayScope, dayStart, now, limits.dailyWindowMs)) > limits.ipDailySends) {
		const nextWindowMs = dayStart.getTime() + limits.dailyWindowMs;
		return { ok: false, reason: 'ip-rate-limited', retryAfterSeconds: secondsUntil(nextWindowMs, nowMs) };
	}

	if ((await incrementCounter(db, 'global1d', dayStart, now, limits.dailyWindowMs)) > limits.globalDailySends) {
		const nextWindowMs = dayStart.getTime() + limits.dailyWindowMs;
		return { ok: false, reason: 'global-cap', retryAfterSeconds: secondsUntil(nextWindowMs, nowMs) };
	}

	const code = generateOtpCode();
	const codeHash = await hashOtp(code, pepper);
	const expiresAt = new Date(nowMs + limits.ttlSeconds * 1000);

	// Upsert: one live pending per identity. A resend replaces the code and
	// resets attempts (a new code deserves a fresh guess budget); send_count
	// accumulates across the cycle. Cooldown uses last_sent_at.
	await db
		.prepare(
			`INSERT INTO otp_pendings (purpose, subject, code_hash, attempts, send_count, last_sent_at, expires_at, created_at)
			 VALUES (?1, ?2, ?3, 0, 1, ?4, ?5, ?4)
			 ON CONFLICT (purpose, subject) DO UPDATE SET
			   code_hash = excluded.code_hash,
			   attempts = 0,
			   send_count = otp_pendings.send_count + 1,
			   last_sent_at = excluded.last_sent_at,
			   expires_at = excluded.expires_at`
		)
		.bind(purpose, subject, codeHash, toSqlUtc(now), toSqlUtc(expiresAt))
		.run();

	try {
		await mailer.sendOtp({ to: deliverTo, purpose, code, expiresInSeconds: limits.ttlSeconds });
	} catch (cause) {
		// Stored but undelivered: the user may retry after the cooldown (which
		// resends a fresh code). Counters were consumed — conservative.
		return { ok: false, reason: 'send-failed', cause };
	}

	return { ok: true, expiresAt, resendAvailableAt: new Date(nowMs + limits.resendCooldownSeconds * 1000) };
}

/**
 * Verify a submitted code. Exactly-once: success deletes the pending.
 * Wrong codes increment `attempts`; reaching maxVerifyAttempts invalidates the
 * pending (the `locked` result) so guessing is capped at 5 per issued code.
 */
export async function verifyOtp(deps: VerifyOtpDeps): Promise<OtpVerifyResult> {
	const { db, purpose, subject, code, pepper, now } = deps;
	const limits = mergedLimits(deps.limits);

	// Malformed input is indistinguishable from a wrong code.
	const submitted = code.trim();
	if (!CODE_PATTERN.test(submitted)) return { ok: false, reason: 'invalid' };

	const { row: pending, expired } = await loadPending(db, purpose, subject, now);
	if (!pending) {
		// A real-but-stale pending answers `expired` (the row is now deleted);
		// anything else is indistinguishable from a wrong code.
		return expired ? { ok: false, reason: 'expired' } : { ok: false, reason: 'invalid' };
	}

	const submittedHash = await hashOtp(submitted, pepper);
	if (timingSafeEqual(submittedHash, pending.code_hash)) {
		await db.prepare('DELETE FROM otp_pendings WHERE purpose = ?1 AND subject = ?2').bind(purpose, subject).run();
		return { ok: true };
	}

	const attempts = pending.attempts + 1;
	if (attempts >= limits.maxVerifyAttempts) {
		// Lockout: invalidate so the (already useless) code cannot be ground on.
		await db.prepare('DELETE FROM otp_pendings WHERE purpose = ?1 AND subject = ?2').bind(purpose, subject).run();
		return { ok: false, reason: 'locked' };
	}
	await db.prepare('UPDATE otp_pendings SET attempts = ?1 WHERE purpose = ?2 AND subject = ?3').bind(attempts, purpose, subject).run();
	return { ok: false, reason: 'invalid' };
}
