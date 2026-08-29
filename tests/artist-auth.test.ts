/**
 * Artist auth flow tests (BE3) — the real +server.ts handlers against the real
 * D1 binding, driven by a hand-rolled RequestEvent (request/cookies/platform/
 * getClientAddress are all the handlers touch). The mailer is the console
 * driver, so the OTP is captured from the console log — no mail ever leaves.
 *
 * Storage persists across tests in a file (see tests/otp.test.ts), so every
 * test uses fresh emails/IPs; endpoint handlers run on the real clock, which
 * is all these flows need (cooldown/lockout happen immediately after their
 * triggers).
 */

import { env as bindings } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { POST as requestOtpHandler } from '../src/routes/api/artist/request-otp/+server';
import { POST as verifyOtpHandler } from '../src/routes/api/artist/verify-otp/+server';
import { POST as signOutHandler } from '../src/routes/api/artist/sign-out/+server';
import {
	ARTIST_SESSION_COOKIE,
	ARTIST_SESSION_TTL_SECONDS,
	getArtistFromCookies,
	issueArtistSession,
	readArtistSession
} from '../src/lib/server/artist-session';

const SESSION_SECRET = 'test-session-secret';
const OTP_PEPPER = 'test-otp-pepper';

/** Records cookie writes so flags/values can be asserted without a browser. */
class CookieJar {
	written = new Map<string, { value: string; options: Record<string, unknown> }>();
	deleted = new Set<string>();

	get cookies(): Cookies {
		const jar = this;
		return {
			get: (name: string) => jar.written.get(name)?.value,
			set: (name: string, value: string, options: Record<string, unknown>) => {
				jar.written.set(name, { value, options });
				jar.deleted.delete(name);
			},
			delete: (name: string) => {
				jar.deleted.add(name);
				jar.written.delete(name);
			}
		} as unknown as Cookies;
	}
}

let counter = 0;
const uniqueEmail = () => `artist-${++counter}@example.test`;
const uniqueIp = () => `192.0.2.${(counter % 200) + 1}`;

function makeEvent(path: string, body: unknown, jar: CookieJar, ip: string): RequestEvent {
	return {
		request: new Request(`http://app.test${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL(`http://app.test${path}`),
		cookies: jar.cookies,
		getClientAddress: () => ip,
		platform: {
			env: {
				DB: bindings.DB,
				ART: null,
				SESSION_SECRET,
				EMAIL_PEPPER: 'test-email-pepper',
				OTP_PEPPER,
				MAILER_DRIVER: 'console'
			}
		}
	} as unknown as RequestEvent;
}

// Each route's RequestHandler carries its own RouteId type; collapse them to
// one callable shape (the handlers only use the shared RequestEvent surface).
type AnyHandler = (event: RequestEvent) => Promise<Response>;
const HANDLERS: Record<string, AnyHandler> = {
	'/api/artist/request-otp': requestOtpHandler as unknown as AnyHandler,
	'/api/artist/verify-otp': verifyOtpHandler as unknown as AnyHandler,
	'/api/artist/sign-out': signOutHandler as unknown as AnyHandler
};

/** Full request step; returns [response, parsed body]. */
async function post(path: string, body: unknown, jar?: CookieJar, ip?: string) {
	const event = makeEvent(path, body, jar ?? new CookieJar(), ip ?? uniqueIp());
	const response = await HANDLERS[path]!(event);
	return [response, ((await response.json().catch(() => null)) as unknown)] as const;
}

/** Silence the console and collect every 6-digit code the console mailer logs. */
function spyConsoleCodes(): string[] {
	const codes: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		const match = /\b(\d{6})\b/.exec(args.join(' '));
		if (match) codes.push(match[1]!);
	});
	return codes;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('artist auth — request-OTP', () => {
	it('answers 200 with a generic, account-independent body', async () => {
		const codes = spyConsoleCodes();
		const [response, body] = await post('/api/artist/request-otp', { email: uniqueEmail() });
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true, expiresInSeconds: 600, resendInSeconds: 60 });
		expect(codes).toHaveLength(1);
		expect(codes[0]).toMatch(/^\d{6}$/);
	});

	it('normalizes the email (case/whitespace) before storing the pending', async () => {
		const email = uniqueEmail();
		await post('/api/artist/request-otp', { email: `  ${email.toUpperCase()}  ` });
		const row = await bindings.DB.prepare('SELECT subject FROM otp_pendings WHERE purpose = ?1 AND subject = ?2')
			.bind('artist', email)
			.first<{ subject: string }>();
		expect(row?.subject).toBe(email);
	});

	it('rejects malformed emails without touching the OTP table', async () => {
		const before = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM otp_pendings WHERE purpose = ?1').bind('artist').first<{ n: number }>();
		for (const bad of ['not-an-email', 'a@b', 'a b@c.test', '', 42, null]) {
			const [response, body] = await post('/api/artist/request-otp', { email: bad });
			expect(response.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_email' });
		}
		const [noBody] = await post('/api/artist/request-otp', undefined);
		expect(noBody.status).toBe(400);

		const after = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM otp_pendings WHERE purpose = ?1').bind('artist').first<{ n: number }>();
		expect(after!.n).toBe(before!.n);
	});

	it('throttles an immediate resend with the cooldown (429 + retry hint)', async () => {
		const email = uniqueEmail();
		await post('/api/artist/request-otp', { email });
		const [response, body] = await post('/api/artist/request-otp', { email });
		expect(response.status).toBe(429);
		expect(body).toMatchObject({ error: 'otp_cooldown' });
		expect((body as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
		expect((body as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(60);
	});

	it('rate-limits one IP after 5 sends across different emails', async () => {
		const ip = uniqueIp();
		for (let i = 0; i < 5; i++) await post('/api/artist/request-otp', { email: uniqueEmail() }, new CookieJar(), ip);
		const [response, body] = await post('/api/artist/request-otp', { email: uniqueEmail() }, new CookieJar(), ip);
		expect(response.status).toBe(429);
		expect(body).toMatchObject({ error: 'rate_limited' });
	});
});

describe('artist auth — verify-OTP (happy path)', () => {
	it('creates the artist on first login and sets a fully flagged session cookie', async () => {
		const codes = spyConsoleCodes();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/artist/request-otp', { email }, jar);

		const [response, body] = await post('/api/artist/verify-otp', { email, code: codes[0] }, jar);
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });

		const artist = await bindings.DB.prepare('SELECT id, email, last_login_at FROM artists WHERE email = ?1')
			.bind(email)
			.first<{ id: number; email: string; last_login_at: string | null }>();
		expect(artist?.email).toBe(email);
		expect(artist?.last_login_at).toBeTruthy();

		const sessions = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM artist_sessions WHERE artist_id = ?1')
			.bind(artist!.id)
			.first<{ n: number }>();
		expect(sessions!.n).toBe(1);

		const cookie = jar.written.get(ARTIST_SESSION_COOKIE);
		expect(cookie).toBeDefined();
		expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // token.signature
		expect(cookie!.options).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: false, // http test origin; https flips this on
			maxAge: ARTIST_SESSION_TTL_SECONDS
		});

		// The session-validation helper later tasks authorize with:
		const again = await getArtistFromCookies({ db: bindings.DB, cookies: jar.cookies, secret: SESSION_SECRET, now: new Date() });
		expect(again).toEqual({ artistId: artist!.id, email });
	});

	it('codes are exactly-once: replaying a used code fails', async () => {
		const codes = spyConsoleCodes();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/artist/request-otp', { email }, jar);
		expect((await post('/api/artist/verify-otp', { email, code: codes[0] }, jar))[0].status).toBe(200);
		expect((await post('/api/artist/verify-otp', { email, code: codes[0] }, jar))[0].status).toBe(400);
	});

	it('supports multiple concurrent sessions for one artist (second browser)', async () => {
		const codes = spyConsoleCodes();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/artist/request-otp', { email }, jar);
		await post('/api/artist/verify-otp', { email, code: codes[0] }, jar);
		const first = await getArtistFromCookies({ db: bindings.DB, cookies: jar.cookies, secret: SESSION_SECRET, now: new Date() });
		expect(first).not.toBeNull();

		const jar2 = new CookieJar();
		const issued = await issueArtistSession({ db: bindings.DB, artistId: first!.artistId, secret: SESSION_SECRET, now: new Date() });
		jar2.written.set(ARTIST_SESSION_COOKIE, { value: issued.cookieValue, options: {} });
		const second = await getArtistFromCookies({ db: bindings.DB, cookies: jar2.cookies, secret: SESSION_SECRET, now: new Date() });
		expect(second?.artistId).toBe(first!.artistId);

		const sessions = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM artist_sessions WHERE artist_id = ?1')
			.bind(first!.artistId)
			.first<{ n: number }>();
		expect(sessions!.n).toBe(2);
	});
});

describe('artist auth — wrong code + lockout', () => {
	it('wrong codes never create an artist or a session', async () => {
		const codes = spyConsoleCodes();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/artist/request-otp', { email }, jar);

		const [response, body] = await post('/api/artist/verify-otp', { email, code: codes[0] === '000000' ? '111111' : '000000' }, jar);
		expect(response.status).toBe(400);
		expect(body).toEqual({ error: 'invalid_code' });
		expect(jar.written.has(ARTIST_SESSION_COOKIE)).toBe(false);
		const artist = await bindings.DB.prepare('SELECT id FROM artists WHERE email = ?1').bind(email).first();
		expect(artist).toBeNull();
	});

	it('locks out after 5 wrong attempts and voids the real code', async () => {
		const codes = spyConsoleCodes();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/artist/request-otp', { email }, jar);
		const wrong = codes[0] === '000000' ? '111111' : '000000';

		for (let i = 0; i < 4; i++) {
			const [response, body] = await post('/api/artist/verify-otp', { email, code: wrong }, jar);
			expect(response.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_code' });
		}
		const [locked, lockedBody] = await post('/api/artist/verify-otp', { email, code: wrong }, jar);
		expect(locked.status).toBe(429);
		expect(lockedBody).toEqual({ error: 'too_many_attempts' });

		// The genuine code is dead after lockout, and still no artist exists.
		const [after] = await post('/api/artist/verify-otp', { email, code: codes[0] }, jar);
		expect(after.status).toBe(400);
		expect(await bindings.DB.prepare('SELECT id FROM artists WHERE email = ?1').bind(email).first()).toBeNull();
	});

	it('treats malformed submissions exactly like wrong codes', async () => {
		const email = uniqueEmail();
		await post('/api/artist/request-otp', { email });
		for (const code of ['', 'abc', '12345', 123456, null]) {
			const [response, body] = await post('/api/artist/verify-otp', { email, code });
			expect(response.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_code' });
		}
	});
});

describe('artist auth — enumeration safety', () => {
	it('request-OTP responses are byte-identical for known vs unknown addresses', async () => {
		// "Known" = an artist row exists. Created directly so neither address has
		// a live pending/cooldown — the only difference is account existence.
		const known = uniqueEmail();
		await bindings.DB.prepare('INSERT INTO artists (email) VALUES (?1)').bind(known).run();

		const [knownResponse, knownBody] = await post('/api/artist/request-otp', { email: known });
		const [unknownResponse, unknownBody] = await post('/api/artist/request-otp', { email: uniqueEmail() });
		expect(knownResponse.status).toBe(unknownResponse.status);
		expect(knownBody).toEqual(unknownBody);
	});

	it('verify-OTP answers no-pending and wrong-code identically', async () => {
		const withPending = uniqueEmail();
		await post('/api/artist/request-otp', { email: withPending });
		const [noPendingResponse, noPendingBody] = await post('/api/artist/verify-otp', { email: uniqueEmail(), code: '123456' });
		const [wrongResponse, wrongBody] = await post('/api/artist/verify-otp', { email: withPending, code: '999999' });
		expect(noPendingResponse.status).toBe(wrongResponse.status);
		expect(noPendingBody).toEqual(wrongBody);
	});
});

describe('artist sessions — validation helper (for later tasks)', () => {
	it('rejects a tampered signature, a wrong secret, and garbage cookies', async () => {
		const codes = spyConsoleCodes();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/artist/request-otp', { email }, jar);
		await post('/api/artist/verify-otp', { email, code: codes[0] }, jar);
		const good = jar.written.get(ARTIST_SESSION_COOKIE)!.value;

		const now = new Date();
		const db = bindings.DB;
		const tampered = `${good.slice(0, -2)}xx`;
		expect(await readArtistSession({ db, cookieValue: tampered, secret: SESSION_SECRET, now })).toBeNull();
		expect(await readArtistSession({ db, cookieValue: good, secret: 'wrong-secret', now })).toBeNull();
		expect(await readArtistSession({ db, cookieValue: 'garbage', secret: SESSION_SECRET, now })).toBeNull();
		expect(await readArtistSession({ db, cookieValue: undefined, secret: SESSION_SECRET, now })).toBeNull();
		expect(await readArtistSession({ db, cookieValue: good, secret: SESSION_SECRET, now })).not.toBeNull();
	});

	it('rejects an expired session row even though the signature is valid', async () => {
		const email = uniqueEmail();
		const artist = await bindings.DB.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id')
			.bind(email)
			.first<{ id: number }>();
		const db = bindings.DB;
		// Short-lived session (60s) issued at t0: valid at t0+59, dead at t0+61 —
		// server-side expiry is authoritative, signature notwithstanding.
		const t0 = new Date();
		const issued = await issueArtistSession({ db, artistId: artist!.id, secret: SESSION_SECRET, now: t0 }, 60);
		expect(await readArtistSession({ db, cookieValue: issued.cookieValue, secret: SESSION_SECRET, now: new Date(t0.getTime() + 59_000) })).not.toBeNull();
		expect(await readArtistSession({ db, cookieValue: issued.cookieValue, secret: SESSION_SECRET, now: new Date(t0.getTime() + 61_000) })).toBeNull();
	});
});

describe('artist auth — sign-out', () => {
	it('revokes the session row and clears the cookie', async () => {
		const codes = spyConsoleCodes();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/artist/request-otp', { email }, jar);
		await post('/api/artist/verify-otp', { email, code: codes[0] }, jar);
		const cookieValue = jar.written.get(ARTIST_SESSION_COOKIE)!.value;
		expect(await readArtistSession({ db: bindings.DB, cookieValue, secret: SESSION_SECRET, now: new Date() })).not.toBeNull();

		const [response, body] = await post('/api/artist/sign-out', {}, jar);
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });
		expect(jar.deleted.has(ARTIST_SESSION_COOKIE)).toBe(true);
		expect(await readArtistSession({ db: bindings.DB, cookieValue, secret: SESSION_SECRET, now: new Date() })).toBeNull();
	});

	it('is idempotent without a session cookie', async () => {
		const [response, body] = await post('/api/artist/sign-out', {}, new CookieJar());
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });
	});
});
