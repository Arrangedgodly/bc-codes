/**
 * OTP core tests (BE3) — generate/hash/request/verify against the real D1
 * binding, with every clock and limit injectable. The capturing mailer
 * implements the Mailer port (no network, no console noise) and hands back
 * the codes so verify paths can be exercised end-to-end.
 *
 * Storage is NOT reset between tests in a file (verified against
 * @cloudflare/vitest-plugin 1.1.2), so every test runs in its own UTC daily
 * window: `beforeEach` bumps the clock base by 25h (kept 10-minute aligned),
 * which isolates the shared `global` counter just like the per-test unique
 * subjects/IPs isolate the per-subject and per-IP rules.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashOtp, generateOtpCode, requestOtp, verifyOtp, type OtpLimits } from '../src/lib/server/otp';
import type { Mailer, OtpMessage } from '../src/lib/server/mailer';
import { toSqlUtc, windowStart } from '../src/lib/server/time';

const PEPPER = 'test-otp-pepper';

/** Captures messages instead of sending; exposes the codes to the test. */
function captureMailer(): Mailer & { sent: OtpMessage[] } {
	const sent: OtpMessage[] = [];
	return {
		driver: 'console',
		async sendOtp(message) {
			sent.push(message);
		},
		sent
	};
}

/**
 * Epoch-aligned base (12:00:00Z sits exactly on a 10-minute and a UTC-day
 * boundary, so window crossings are deterministic: +601s = next short window,
 * +24h+1s = next daily window). beforeEach shifts it 50h per test: a test's
 * main day AND its "next day" tail-send day (base+24h) then fall strictly
 * between neighboring tests' days, so daily windows (incl. the shared global
 * counter) never couple tests.
 */
const BASE = Date.parse('2026-08-28T12:00:00Z');
let dayIndex = 0;
const dayBase = () => BASE + dayIndex * 50 * 3600 * 1000;
const at = (seconds: number) => new Date(dayBase() + seconds * 1000);
beforeEach(() => {
	dayIndex += 1;
});

/** Unique subject per call so per-subject rules never bleed across tests. */
let subjectCounter = 0;
const nextSubject = () => `subject-${++subjectCounter}@test.example`;
/** Unique IP per call so per-IP windows never bleed across tests. */
let ipCounter = 0;
const nextIp = () => `198.51.100.${(++ipCounter % 200) + 1}`;

interface Sent {
	ok: boolean;
	code: string;
}

/** requestOtp + captured mailer, asserting the send went through. */
async function send(
	opts: { subject?: string; ip?: string; now?: Date; limits?: Partial<OtpLimits>; mailer?: Mailer } = {}
): Promise<Sent> {
	const mailer = opts.mailer ?? captureMailer();
	const subject = opts.subject ?? nextSubject();
	const result = await requestOtp({
		db: env.DB,
		purpose: 'artist',
		subject,
		deliverTo: subject,
		pepper: PEPPER,
		mailer,
		ip: opts.ip ?? nextIp(),
		now: opts.now ?? at(0),
		limits: opts.limits
	});
	if (!result.ok) throw new Error(`expected requestOtp to succeed, got: ${JSON.stringify(result)}`);
	const message = (mailer as Mailer & { sent: OtpMessage[] }).sent.at(-1);
	if (!message) throw new Error('mailer captured no message');
	return { ok: true, code: message.code };
}

function verify(code: string, subject: string, now: Date, limits?: Partial<OtpLimits>) {
	return verifyOtp({ db: env.DB, purpose: 'artist', subject, code, pepper: PEPPER, now, limits });
}

describe('generateOtpCode — crypto-secure 6-digit codes', () => {
	it('always produces exactly 6 digits', () => {
		for (let i = 0; i < 2000; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
	});

	it('covers the full range including leading zeros', () => {
		const codes = new Set<string>();
		for (let i = 0; i < 20000; i++) codes.add(generateOtpCode());
		// Birthday collisions expected (~9.7% of 20k draws in a 10^6 space) — but
		// nearly all values should be distinct, and zero-prefixed codes must occur.
		expect(codes.size).toBeGreaterThan(18_500);
		const leading = [...codes].filter((code) => code.startsWith('0')).length;
		expect(leading).toBeGreaterThan(codes.size / 20);
	});

	it('is roughly uniform across digits (no modulo bias)', () => {
		const counts = new Array(10).fill(0);
		for (let i = 0; i < 60000; i++) for (const ch of generateOtpCode()) counts[Number(ch)]++;
		// 360k digit draws, 36k expected per digit; ±5% is far beyond chance.
		for (const count of counts) expect(count).toBeGreaterThan(34_000);
	});
});

describe('hashOtp — peppered hashing', () => {
	it('is deterministic, pepper-dependent, and hex-SHA-256 length', async () => {
		const a = await hashOtp('123456', PEPPER);
		expect(a).toHaveLength(64);
		expect(a).toMatch(/^[0-9a-f]+$/);
		expect(await hashOtp('123456', PEPPER)).toBe(a);
		expect(await hashOtp('123456', 'other-pepper')).not.toBe(a);
		expect(await hashOtp('654321', PEPPER)).not.toBe(a);
	});
});

describe('requestOtp + verifyOtp — happy path', () => {
	it('stores only the hashed code and verifies the mailed code exactly once', async () => {
		const subject = nextSubject();
		const { code } = await send({ subject, now: at(0) });

		const row = await env.DB.prepare('SELECT code_hash, attempts, send_count FROM otp_pendings WHERE purpose = ?1 AND subject = ?2')
			.bind('artist', subject)
			.first<{ code_hash: string; attempts: number; send_count: number }>();
		expect(row).not.toBeNull();
		expect(row!.code_hash).not.toContain(code); // plaintext never at rest
		expect(row!.code_hash).toBe(await hashOtp(code, PEPPER));
		expect(row!.attempts).toBe(0);
		expect(row!.send_count).toBe(1);

		expect(await verify(code, subject, at(30))).toEqual({ ok: true });
		// Exactly-once: the pending is consumed.
		expect(await verify(code, subject, at(31))).toEqual({ ok: false, reason: 'invalid' });
		expect(
			await env.DB.prepare('SELECT 1 AS x FROM otp_pendings WHERE purpose = ?1 AND subject = ?2').bind('artist', subject).first()
		).toBeNull();
	});

	it('rejects malformed submissions like wrong codes (no DB state touched)', async () => {
		const subject = nextSubject();
		const { code } = await send({ subject, now: at(0) });
		expect(await verify('', subject, at(10))).toEqual({ ok: false, reason: 'invalid' });
		expect(await verify('12345', subject, at(10))).toEqual({ ok: false, reason: 'invalid' });
		expect(await verify('1234567', subject, at(10))).toEqual({ ok: false, reason: 'invalid' });
		expect(await verify('abcdef', subject, at(10))).toEqual({ ok: false, reason: 'invalid' });
		expect(await verify('  12345  ', subject, at(10))).toEqual({ ok: false, reason: 'invalid' });
		// The real code still works after malformed attempts (they never counted).
		expect(await verify(code, subject, at(20))).toEqual({ ok: true });
	});
});

describe('verifyOtp — attempt lockout', () => {
	it('allows 4 wrong guesses, locks on the 5th, and invalidates the code', async () => {
		const subject = nextSubject();
		const { code } = await send({ subject, now: at(0) });
		const wrongCode = code === '000000' ? '111111' : '000000';

		for (let i = 1; i <= 4; i++) {
			expect(await verify(wrongCode, subject, at(i))).toEqual({ ok: false, reason: 'invalid' });
		}
		// attempts column advanced with each miss
		const row = await env.DB.prepare('SELECT attempts FROM otp_pendings WHERE purpose = ?1 AND subject = ?2')
			.bind('artist', subject)
			.first<{ attempts: number }>();
		expect(row!.attempts).toBe(4);

		expect(await verify(wrongCode, subject, at(5))).toEqual({ ok: false, reason: 'locked' });
		// Locked = pending deleted: even the correct code is now useless.
		expect(await verify(code, subject, at(6))).toEqual({ ok: false, reason: 'invalid' });
	});

	it('resets the guess budget when a resend issues a fresh code', async () => {
		const subject = nextSubject();
		const first = await send({ subject, now: at(0) });
		const wrongCode = first.code === '000000' ? '111111' : '000000';
		for (let i = 0; i < 4; i++) await verify(wrongCode, subject, at(10 + i));

		const second = await send({ subject, now: at(61) }); // past the cooldown
		// New code, new budget: 4 misses are tolerated again...
		for (let i = 0; i < 4; i++) expect(await verify(wrongCode, subject, at(120 + i))).toEqual({ ok: false, reason: 'invalid' });
		// ...and the fresh code verifies.
		expect(await verify(second.code, subject, at(130))).toEqual({ ok: true });
	});

	it('supports tighter lockouts via limit overrides (QA1 hook)', async () => {
		const subject = nextSubject();
		const { code } = await send({ subject, now: at(0), limits: { maxVerifyAttempts: 2 } });
		const wrongCode = code === '000000' ? '111111' : '000000';
		expect(await verify(wrongCode, subject, at(1), { maxVerifyAttempts: 2 })).toEqual({ ok: false, reason: 'invalid' });
		expect(await verify(wrongCode, subject, at(2), { maxVerifyAttempts: 2 })).toEqual({ ok: false, reason: 'locked' });
	});
});

describe('requestOtp — expiry', () => {
	it('accepts a code at the last second of its TTL and frees the subject after', async () => {
		const subject = nextSubject();
		const first = await send({ subject, now: at(0) });
		expect(await verify(first.code, subject, at(599))).toEqual({ ok: true }); // last good second
		expect(await verify(first.code, subject, at(600))).toEqual({ ok: false, reason: 'invalid' }); // consumed above

		const second = await send({ subject, now: at(601) });
		expect(second.code).not.toBe(first.code); // expired row was replaced
		expect(await verify(second.code, subject, at(1201 - 1))).toEqual({ ok: true });
	});

	it('reports expiry (not invalid) so the client can prompt for a fresh code', async () => {
		const subject = nextSubject();
		const { code } = await send({ subject, now: at(0) });
		expect(await verify(code, subject, at(600))).toEqual({ ok: false, reason: 'expired' }); // expiry instant
		// The stale pending is gone after being reported expired.
		expect(await verify(code, subject, at(601))).toEqual({ ok: false, reason: 'invalid' });
	});
});

describe('requestOtp — per-subject cooldown and send cap', () => {
	it('enforces a 60s cooldown between sends', async () => {
		const subject = nextSubject();
		await send({ subject, now: at(0) });
		const early = await requestOtp({
			db: env.DB, purpose: 'artist', subject, deliverTo: subject, pepper: PEPPER,
			mailer: captureMailer(), ip: nextIp(), now: at(30)
		});
		expect(early).toEqual({ ok: false, reason: 'cooldown', retryAfterSeconds: 30 });
		await send({ subject, now: at(61) }); // exactly past the cooldown is fine
	});

	it('caps a pending at 3 sends, then defers to expiry before a new cycle', async () => {
		const subject = nextSubject();
		await send({ subject, now: at(0) });
		await send({ subject, now: at(61) });
		await send({ subject, now: at(121) });

		const exhausted = await requestOtp({
			db: env.DB, purpose: 'artist', subject, deliverTo: subject, pepper: PEPPER,
			mailer: captureMailer(), ip: nextIp(), now: at(181)
		});
		// TTL 600s from the last send at t=121 -> expires at 721 -> 540s remain at 181.
		expect(exhausted).toEqual({ ok: false, reason: 'pending-exhausted', retryAfterSeconds: 540 });

		// After expiry the cycle restarts cleanly.
		await send({ subject, now: at(721 + 1) });
	});

	it('replaces the code on resend: the old code stops working', async () => {
		const subject = nextSubject();
		const first = await send({ subject, now: at(0) });
		const second = await send({ subject, now: at(61) });
		expect(await verify(first.code, subject, at(70))).toEqual({ ok: false, reason: 'invalid' });
		expect(await verify(second.code, subject, at(71))).toEqual({ ok: true });
	});
});

describe('requestOtp — per-IP fixed windows', () => {
	it('blocks the 6th send from one IP inside a 10-minute window', async () => {
		const ip = nextIp();
		for (let i = 0; i < 5; i++) await send({ subject: nextSubject(), ip, now: at(i) });
		const blocked = await requestOtp({
			db: env.DB, purpose: 'artist', subject: nextSubject(), deliverTo: nextSubject(), pepper: PEPPER,
			mailer: captureMailer(), ip, now: at(5)
		});
		expect(blocked.ok).toBe(false);
		if (!blocked.ok && blocked.reason === 'ip-rate-limited') {
			// Window started at this test's base; next window is 600s in -> 595s away at t=5s.
			expect(blocked.retryAfterSeconds).toBe(595);
		}
	});

	it('other IPs are unaffected (per-IP, not global)', async () => {
		const abusive = nextIp();
		for (let i = 0; i < 5; i++) await send({ subject: nextSubject(), ip: abusive, now: at(i) });
		await send({ subject: nextSubject(), ip: nextIp(), now: at(5) }); // different IP: fine
	});

	it('caps an IP at 20 sends per UTC day across short windows', async () => {
		const ip = nextIp();
		// 4 short windows x 5 sends = 20 (subjects are unique, so no subject caps bite).
		for (let window = 0; window < 4; window++) {
			for (let i = 0; i < 5; i++) await send({ subject: nextSubject(), ip, now: at(window * 601 + i) });
		}
		const blocked = await requestOtp({
			db: env.DB, purpose: 'artist', subject: nextSubject(), deliverTo: nextSubject(), pepper: PEPPER,
			mailer: captureMailer(), ip, now: at(4 * 601)
		});
		expect(blocked.ok).toBe(false);
		if (!blocked.ok && blocked.reason === 'ip-rate-limited') {
			// Blocked inside the day window (not the short one): the retry must
			// point past the whole day, not just the 10-minute slot.
			expect(blocked.retryAfterSeconds).toBeGreaterThan(601);
		}

		// The next UTC day is a clean slate for the same IP.
		await send({ subject: nextSubject(), ip, now: at(24 * 3600 + 1) });
	});

	it('counts blocked traffic against the blocker (attempt quota, not send budget)', async () => {
		const ip = nextIp();
		for (let i = 0; i < 5; i++) await send({ subject: nextSubject(), ip, now: at(i) });
		// Two more attempts in-window: both refused, both consumed short-window slots.
		for (let i = 0; i < 2; i++) {
			const result = await requestOtp({
				db: env.DB, purpose: 'artist', subject: nextSubject(), deliverTo: nextSubject(), pepper: PEPPER,
				mailer: captureMailer(), ip, now: at(5)
			});
			expect(result.ok).toBe(false);
		}
		const counter = await env.DB.prepare('SELECT sends FROM otp_rate_counters WHERE scope = ?1 AND window_start = ?2')
			.bind(`ip10m:${ip}`, toSqlUtc(windowStart(at(0), 10 * 60 * 1000)))
			.first<{ sends: number }>();
		expect(counter!.sends).toBe(7);
	});

	it('keeps short and daily IP windows separate when they share a start (UTC midnight)', async () => {
		const ip = nextIp();
		// The 10-minute window beginning exactly at this test's UTC midnight has
		// the same window_start as the daily one — the scopes must keep them apart
		// or every send double-counts (regression: this once collapsed the caps).
		const midnight = windowStart(at(0), 24 * 3600 * 1000);
		const atMidnight = (second: number) => new Date(midnight.getTime() + second * 1000);
		for (let i = 0; i < 5; i++) await send({ subject: nextSubject(), ip, now: atMidnight(i) });
		const sixth = await requestOtp({
			db: env.DB, purpose: 'artist', subject: nextSubject(), deliverTo: nextSubject(), pepper: PEPPER,
			mailer: captureMailer(), ip, now: atMidnight(5)
		});
		expect(sixth.ok).toBe(false);
		if (!sixth.ok && sixth.reason === 'ip-rate-limited') {
			expect(sixth.retryAfterSeconds).toBe(595);
		}
		const read = async (scope: string) =>
			(await env.DB.prepare('SELECT sends FROM otp_rate_counters WHERE scope = ?1 AND window_start = ?2')
				.bind(scope, toSqlUtc(midnight))
				.first<{ sends: number }>())?.sends;
		// The blocked attempt consumed a short-window slot but no daily slot.
		expect(await read(`ip10m:${ip}`)).toBe(6);
		expect(await read(`ip1d:${ip}`)).toBe(5);
	});
});

describe('requestOtp — global daily cap (provider budget)', () => {
	it('refuses the send after the global window fills, even from fresh IPs', async () => {
		const limits = { globalDailySends: 3 };
		for (let i = 0; i < 3; i++) await send({ subject: nextSubject(), ip: nextIp(), now: at(i), limits });
		const blocked = await requestOtp({
			db: env.DB, purpose: 'artist', subject: nextSubject(), deliverTo: nextSubject(), pepper: PEPPER,
			mailer: captureMailer(), ip: nextIp(), now: at(3), limits
		});
		expect(blocked.ok).toBe(false);
		if (!blocked.ok && blocked.reason === 'global-cap') {
			// Retry points at the end of this test's UTC-midnight-aligned daily
			// window (which depends on the per-test clock base), computed the same
			// way the implementation computes it.
			const dayMs = 24 * 3600 * 1000;
			const dayEnd = windowStart(at(0), dayMs).getTime() + dayMs;
			expect(blocked.retryAfterSeconds).toBe(Math.ceil((dayEnd - at(3).getTime()) / 1000));
		}
		// Unblocked in the next UTC day window.
		await send({ subject: nextSubject(), ip: nextIp(), now: at(24 * 3600 + 1), limits });
	});

	it('is independent of any single IP: many IPs can fill it together', async () => {
		const limits = { globalDailySends: 2, ipWindowSends: 5, ipDailySends: 5 };
		await send({ subject: nextSubject(), ip: '203.0.113.10', now: at(0), limits });
		await send({ subject: nextSubject(), ip: '203.0.113.11', now: at(0), limits });
		const result = await requestOtp({
			db: env.DB, purpose: 'artist', subject: nextSubject(), deliverTo: nextSubject(), pepper: PEPPER,
			mailer: captureMailer(), ip: '203.0.113.12', now: at(0), limits
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('global-cap');
	});
});

describe('requestOtp — mailer failures', () => {
	it('reports send-failed without throwing, leaving a retriable subject', async () => {
		const subject = nextSubject();
		const failing: Mailer = {
			driver: 'console',
			async sendOtp() {
				throw new Error('SMTP imaginary outage');
			}
		};
		const result = await requestOtp({
			db: env.DB, purpose: 'artist', subject, deliverTo: subject, pepper: PEPPER,
			mailer: failing, ip: nextIp(), now: at(0)
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('send-failed');
			expect(String((result as { cause?: unknown }).cause)).toContain('outage');
		}
		// Stored-but-undelivered: retrying after the cooldown issues a fresh code.
		const retried = await send({ subject, now: at(61) });
		expect(retried.ok).toBe(true);
	});
});

describe('otp_pendings — dual-purpose shape (BE4 contract)', () => {
	it('keeps artist and fan subjects in separate rows under the same purpose key', async () => {
		const email = nextSubject();
		const fanHash = 'deadbeef'.repeat(8); // stand-in for BE4's HMAC subject
		await send({ subject: email, now: at(0) });
		await requestOtp({
			db: env.DB, purpose: 'fan', subject: fanHash, deliverTo: email, pepper: PEPPER,
			mailer: captureMailer(), ip: nextIp(), now: at(0)
		});
		const { results } = await env.DB.prepare('SELECT purpose, subject FROM otp_pendings WHERE subject IN (?1, ?2)')
			.bind(email, fanHash)
			.all<{ purpose: string; subject: string }>();
		expect((results ?? []).length).toBe(2);
	});
});
