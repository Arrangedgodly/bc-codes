/**
 * QA3 security hardening tests — the gaps the BE3/BE4/QA1 suites left open,
 * each pinned ENDPOINT-LEVEL (real +server.ts handlers against the real D1
 * binding, mirroring tests/artist-auth.test.ts's hand-rolled RequestEvent
 * pattern):
 *
 *   1. OTP_LIMITS pins the documented BE3 rate-limit matrix — the doc table
 *      and the enforced numbers can never drift apart silently.
 *   2. Cookie flags IN PRODUCTION SHAPE: over an https origin the verify
 *      endpoints set Secure + HttpOnly + SameSite=Lax + Path=/ + Max-Age,
 *      for BOTH populations (artist + fan); sign-out deletes with the same
 *      secure posture. (The http-origin flag cases are already pinned in
 *      artist-auth/fan-auth; these are the production-side twins.)
 *   3. Endpoint wiring of the matrix's rarer refusals (the fast paths —
 *      cooldown, per-IP short window, verify lockout — are already pinned
 *      endpoint-level in artist-auth/fan-auth/invariants): pending-exhausted
 *      (429 otp_pending_exhausted), per-IP daily cap (429 rate_limited),
 *      global daily cap (503 email_throttled).
 *   4. Production mailers never log codes: ResendMailer/BrevoMailer deliver
 *      the code to the provider (the send itself) but produce ZERO console
 *      output containing it — success and failure paths both. The dev
 *      ConsoleMailer is the only driver that prints codes (pinned in
 *      mailer.test.ts), and createMailer can only select it when no
 *      provider key exists or it is set explicitly.
 *
 * Constant-time compares (no timing oracle) are a code-review property, not
 * a testable timing assertion here: every secret comparison in the tree
 * (otp.ts verifyOtp, artist-session/fan-session extractVerifiedToken) goes
 * through crypto.ts timingSafeEqual — a full-length XOR accumulator with no
 * data-dependent branch (the early length exit leaks only public lengths).
 */

import { env as bindings } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { POST as artistRequestOtpHandler } from '../src/routes/api/artist/request-otp/+server';
import { POST as artistVerifyOtpHandler } from '../src/routes/api/artist/verify-otp/+server';
import { POST as artistSignOutHandler } from '../src/routes/api/artist/sign-out/+server';
import { POST as fanRequestOtpHandler } from '../src/routes/api/fan/request-otp/+server';
import { POST as fanVerifyOtpHandler } from '../src/routes/api/fan/verify-otp/+server';
import { POST as fanSignOutHandler } from '../src/routes/api/fan/sign-out/+server';
import { OTP_LIMITS } from '../src/lib/server/otp';
import { BrevoMailer, MailSendError, ResendMailer } from '../src/lib/server/mailer';
import { toSqlUtc, windowStart } from '../src/lib/server/time';

const SESSION_SECRET = 'test-session-secret';
const EMAIL_PEPPER = 'test-email-pepper';
const OTP_PEPPER = 'test-otp-pepper';

/**
 * Cookie jar that records DELETE options too (the BE3/BE4 jars only record
 * the name; the secure flag on sign-out deletion is exactly what QA3 pins).
 */
class CookieJar {
	written = new Map<string, { value: string; options: Record<string, unknown> }>();
	deleted = new Map<string, Record<string, unknown>>();

	get cookies(): Cookies {
		const jar = this;
		return {
			get: (name: string) => jar.written.get(name)?.value,
			set: (name: string, value: string, options: Record<string, unknown>) => {
				jar.written.set(name, { value, options });
				jar.deleted.delete(name);
			},
			delete: (name: string, options?: Record<string, unknown>) => {
				jar.deleted.set(name, options ?? {});
				jar.written.delete(name);
			}
		} as unknown as Cookies;
	}
}

let counter = 0;
const uniqueEmail = (kind: string) => `qa3-${kind}-${++counter}@example.test`;
const uniqueIp = () => `198.51.100.${(counter % 200) + 1}`;

function makeEvent(path: string, body: unknown, jar: CookieJar, ip: string, origin: string): RequestEvent {
	return {
		request: new Request(`${origin}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL(`${origin}${path}`),
		cookies: jar.cookies,
		getClientAddress: () => ip,
		platform: {
			env: {
				DB: bindings.DB,
				ART: null,
				SESSION_SECRET,
				EMAIL_PEPPER,
				OTP_PEPPER,
				MAILER_DRIVER: 'console'
			}
		}
	} as unknown as RequestEvent;
}

type AnyHandler = (event: RequestEvent) => Promise<Response>;
const HANDLERS: Record<string, AnyHandler> = {
	'/api/artist/request-otp': artistRequestOtpHandler as unknown as AnyHandler,
	'/api/artist/verify-otp': artistVerifyOtpHandler as unknown as AnyHandler,
	'/api/artist/sign-out': artistSignOutHandler as unknown as AnyHandler,
	'/api/fan/request-otp': fanRequestOtpHandler as unknown as AnyHandler,
	'/api/fan/verify-otp': fanVerifyOtpHandler as unknown as AnyHandler,
	'/api/fan/sign-out': fanSignOutHandler as unknown as AnyHandler
};

async function post(path: string, body: unknown, jar: CookieJar, ip: string, origin = 'https://app.test') {
	const response = await HANDLERS[path]!(makeEvent(path, body, jar, ip, origin));
	return [response, ((await response.json().catch(() => null)) as unknown)] as const;
}

/** Capture every console line + every 6-digit run inside them (all levels). */
function spyAllConsole(): { lines: string[] } {
	const lines: string[] = [];
	for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
		});
	}
	return { lines };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('QA3 — the OTP rate-limit matrix is what BE3 documented', () => {
	it('OTP_LIMITS equals the doc table exactly (doc and code cannot drift)', () => {
		expect(OTP_LIMITS).toEqual({
			ttlSeconds: 600, // OTP lifetime: 10 minutes
			resendCooldownSeconds: 60, // resend cooldown: 60 s per subject
			maxSendsPerPending: 3, // initial + 2 resends per pending cycle
			maxVerifyAttempts: 5, // 5 guesses, then the pending is invalidated
			ipWindowSends: 5, // 5 sends / 10 min per IP
			ipWindowMs: 10 * 60 * 1000,
			ipDailySends: 20, // 20 sends / 24 h per IP
			dailyWindowMs: 24 * 60 * 60 * 1000,
			globalDailySends: 80 // whole-app: under Resend's 100/day free cap
		});
	});
});

describe('QA3 — production cookie flags (https origin)', () => {
	it('artist verify-otp sets Secure + HttpOnly + SameSite=Lax + Path=/ + Max-Age over https', async () => {
		const codes: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			const match = /\b(\d{6})\b/.exec(args.join(' '));
			if (match) codes.push(match[1]!);
		});
		const email = uniqueEmail('artist-https');
		const jar = new CookieJar();
		const ip = uniqueIp();
		await post('/api/artist/request-otp', { email }, jar, ip);
		const [response, body] = await post('/api/artist/verify-otp', { email, code: codes[0] }, jar, ip);
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });

		const cookie = jar.written.get('bc_artist_session');
		expect(cookie).toBeDefined();
		expect(cookie!.options).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: true, // https origin — the production posture
			maxAge: 7 * 24 * 60 * 60
		});
	});

	it('fan verify-otp sets the same production flag set over https (180-day Max-Age)', async () => {
		const codes: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			const match = /\b(\d{6})\b/.exec(args.join(' '));
			if (match) codes.push(match[1]!);
		});
		const email = uniqueEmail('fan-https');
		const jar = new CookieJar();
		const ip = uniqueIp();
		await post('/api/fan/request-otp', { email }, jar, ip);
		const [response, body] = await post('/api/fan/verify-otp', { email, code: codes[0] }, jar, ip);
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });

		const cookie = jar.written.get('bc_fan_session');
		expect(cookie).toBeDefined();
		expect(cookie!.options).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: true,
			maxAge: 180 * 24 * 60 * 60
		});
	});

	it('both sign-outs delete their cookie with Secure over https (and still revoke server-side)', async () => {
		const codes: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			const match = /\b(\d{6})\b/.exec(args.join(' '));
			if (match) codes.push(match[1]!);
		});

		const artistJar = new CookieJar();
		const artistEmail = uniqueEmail('artist-out');
		const ipA = uniqueIp();
		await post('/api/artist/request-otp', { email: artistEmail }, artistJar, ipA);
		await post('/api/artist/verify-otp', { email: artistEmail, code: codes[0] }, artistJar, ipA);
		const artistCookie = artistJar.written.get('bc_artist_session')!.value;
		const [artistOut] = await post('/api/artist/sign-out', {}, artistJar, ipA);
		expect(artistOut.status).toBe(200);
		expect(artistJar.deleted.get('bc_artist_session')).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: true });
		// Server-side revocation: the exact cookie value no longer validates.
		artistJar.written.set('bc_artist_session', { value: artistCookie, options: {} });
		const { readArtistSession } = await import('../src/lib/server/artist-session');
		expect(
			await readArtistSession({ db: bindings.DB, cookieValue: artistCookie, secret: SESSION_SECRET, now: new Date() })
		).toBeNull();

		codes.length = 0;
		const fanJar = new CookieJar();
		const fanEmail = uniqueEmail('fan-out');
		const ipF = uniqueIp();
		await post('/api/fan/request-otp', { email: fanEmail }, fanJar, ipF);
		await post('/api/fan/verify-otp', { email: fanEmail, code: codes[0] }, fanJar, ipF);
		const fanCookie = fanJar.written.get('bc_fan_session')!.value;
		const [fanOut] = await post('/api/fan/sign-out', {}, fanJar, ipF);
		expect(fanOut.status).toBe(200);
		expect(fanJar.deleted.get('bc_fan_session')).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: true });
		const { readFanSession } = await import('../src/lib/server/fan-session');
		expect(await readFanSession({ db: bindings.DB, cookieValue: fanCookie, secret: SESSION_SECRET, now: new Date() })).toBeNull();
	});
});

describe('QA3 — endpoint wiring of the matrix\'s rarer refusals (fan endpoint)', () => {
	it('pending-exhausted: a 3-send pending answers 429 otp_pending_exhausted', async () => {
		const email = uniqueEmail('exhausted');
		const jar = new CookieJar();
		const ip = uniqueIp();
		const [first] = await post('/api/fan/request-otp', { email }, jar, ip);
		expect(first.status).toBe(200);

		// Simulate the two consumed resends + an aged last send (past cooldown)
		// by writing the pending's cycle state directly — the endpoint under
		// test still runs the full real gate ladder on the next request. The
		// fan pending's subject is the canonical email HMAC (BE4), never the
		// address itself.
		const { hashFanEmail } = await import('../src/lib/server/fan-identity');
		const subject = await hashFanEmail(email, EMAIL_PEPPER);
		await bindings.DB
			.prepare("UPDATE otp_pendings SET send_count = 3, last_sent_at = ?2 WHERE purpose = 'fan' AND subject = ?1")
			.bind(subject, toSqlUtc(new Date(Date.now() - 120_000)))
			.run();

		const [response, body] = await post('/api/fan/request-otp', { email }, new CookieJar(), uniqueIp());
		expect(response.status).toBe(429);
		expect(body).toMatchObject({ error: 'otp_pending_exhausted' });
	});

	it('per-IP daily cap: 20 sends in the window → 429 rate_limited', async () => {
		const ip = uniqueIp();
		const dayStart = windowStart(new Date(), OTP_LIMITS.dailyWindowMs);
		await bindings.DB
			.prepare(
				`INSERT INTO otp_rate_counters (scope, window_start, sends) VALUES (?1, ?2, ?3)
				 ON CONFLICT (scope, window_start) DO UPDATE SET sends = excluded.sends`
			)
			.bind(`ip1d:${ip}`, toSqlUtc(dayStart), OTP_LIMITS.ipDailySends)
			.run();

		const [response, body] = await post('/api/fan/request-otp', { email: uniqueEmail('ip-day') }, new CookieJar(), ip);
		expect(response.status).toBe(429);
		expect(body).toMatchObject({ error: 'rate_limited' });
	});

	it('global daily cap: 80 sends → 503 email_throttled (the provider budget class)', async () => {
		const dayStart = windowStart(new Date(), OTP_LIMITS.dailyWindowMs);
		await bindings.DB
			.prepare(
				`INSERT INTO otp_rate_counters (scope, window_start, sends) VALUES (?1, ?2, ?3)
				 ON CONFLICT (scope, window_start) DO UPDATE SET sends = excluded.sends`
			)
			.bind('global1d', toSqlUtc(dayStart), OTP_LIMITS.globalDailySends)
			.run();

		const [response, body] = await post('/api/fan/request-otp', { email: uniqueEmail('global') }, new CookieJar(), uniqueIp());
		expect(response.status).toBe(503);
		expect(body).toMatchObject({ error: 'email_throttled' });
	});
});

describe('QA3 — production mailers never log codes', () => {
	const message = { to: 'someone@example.test', purpose: 'artist' as const, code: '482913', expiresInSeconds: 600 };

	it('ResendMailer: success path is console-silent; the code reaches ONLY the provider request', async () => {
		const { lines } = spyAllConsole();
		let deliveredBody = '';
		const mailer = new ResendMailer({
			apiKey: 're_test_key',
			from: 'bc-codes <noreply@send.example.com>',
			fetchImpl: async (_input, init) => {
				deliveredBody = String(init.body);
				return new Response('{"id":"x"}', { status: 200 });
			}
		});
		await mailer.sendOtp(message);
		expect(deliveredBody).toContain('482913'); // the delivery itself
		expect(lines).toEqual([]); // and zero console output
	});

	it('ResendMailer: failure path throws MailSendError whose message carries no code, logs nothing', async () => {
		const { lines } = spyAllConsole();
		const mailer = new ResendMailer({
			apiKey: 're_test_key',
			from: 'bc-codes <noreply@send.example.com>',
			fetchImpl: async () => new Response('provider exploded', { status: 500 })
		});
		const error = await mailer.sendOtp(message).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(MailSendError);
		expect(String((error as Error).message)).not.toContain('482913');
		expect(lines).toEqual([]);
	});

	it('BrevoMailer: failure path is equally code-silent', async () => {
		const { lines } = spyAllConsole();
		const mailer = new BrevoMailer({
			apiKey: 'xkeysib-test',
			from: 'bc-codes <noreply@send.example.com>',
			fetchImpl: async () => new Response('{"code":"failure"}', { status: 429 })
		});
		const error = await mailer.sendOtp(message).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(MailSendError);
		expect(String((error as Error).message)).not.toContain('482913');
		expect(lines).toEqual([]);
	});
});
