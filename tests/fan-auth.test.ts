/**
 * Fan identity + fan auth flow tests (BE4) — the real +server.ts handlers,
 * session modules, identity helpers, and the FE4 claims lookup, all against
 * the real D1 binding (vitest inside workerd; migrations applied by
 * tests/setup.ts). Mirrors tests/artist-auth.test.ts: hand-rolled
 * RequestEvent + cookie-recording jar; the console mailer captures codes, so
 * no mail ever leaves.
 *
 * Coverage contract (plan.md BE4): hash canonicalization (case/whitespace),
 * purpose-separation (artist token never validates as fan and vice versa),
 * verify-once flow, cookie flags, sliding session expiry refresh, rate-limit
 * reuse (fan + artist share the BE3 matrix/budget), enumeration safety
 * (identical responses whether or not the email has claims), hash never
 * echoed, and the my-codes lookup keyed by fan_hash.
 *
 * Storage persists across tests in a file (see tests/otp.test.ts), so every
 * test uses fresh emails/IPs/slugs; endpoint handlers run on the real clock,
 * which is all these flows need (cooldown/lockout happen immediately after
 * their triggers).
 */

import { env as bindings } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { POST as fanRequestOtpHandler } from '../src/routes/api/fan/request-otp/+server';
import { POST as fanVerifyOtpHandler } from '../src/routes/api/fan/verify-otp/+server';
import { POST as fanSignOutHandler } from '../src/routes/api/fan/sign-out/+server';
import { ensureFanIdentity, hashFanEmail, listFanClaims } from '../src/lib/server/fan-identity';
import {
	FAN_SESSION_COOKIE,
	FAN_SESSION_TTL_SECONDS,
	getFanFromCookies,
	issueFanSession,
	readFanSession
} from '../src/lib/server/fan-session';
import { issueArtistSession, readArtistSession } from '../src/lib/server/artist-session';
import { hmacBase64UrlPurpose, sha256Hex } from '../src/lib/server/crypto';
import { requestOtp, OTP_LIMITS } from '../src/lib/server/otp';
import { dispenseCode, type DispenseResult } from '../src/lib/server/dispense';
import type { Mailer, OtpMessage } from '../src/lib/server/mailer';
import { fromSqlUtc, toSqlUtc, windowStart } from '../src/lib/server/time';

const SESSION_SECRET = 'test-session-secret';
const EMAIL_PEPPER = 'test-email-pepper';
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
const uniqueEmail = () => `fan-${++counter}@example.test`;
/** TEST-NET-3 range — disjoint from the artist suite's TEST-NET-1, belt and braces. */
const uniqueIp = () => `203.0.113.${(counter % 200) + 1}`;

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
				EMAIL_PEPPER,
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
	'/api/fan/request-otp': fanRequestOtpHandler as unknown as AnyHandler,
	'/api/fan/verify-otp': fanVerifyOtpHandler as unknown as AnyHandler,
	'/api/fan/sign-out': fanSignOutHandler as unknown as AnyHandler
};

/** Full request step; returns [response, parsed body]. */
async function post(path: string, body: unknown, jar?: CookieJar, ip?: string) {
	const event = makeEvent(path, body, jar ?? new CookieJar(), ip ?? uniqueIp());
	const response = await HANDLERS[path]!(event);
	return [response, ((await response.json().catch(() => null)) as unknown)] as const;
}

/** Silence the console; collect the logged lines and every 6-digit code in them. */
function spyConsole(): { codes: string[]; lines: string[] } {
	const codes: string[] = [];
	const lines: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		const text = args.join(' ');
		lines.push(text);
		const match = /\b(\d{6})\b/.exec(text);
		if (match) codes.push(match[1]!);
	});
	return { codes, lines };
}

/** Captures messages instead of sending (the Mailer port, no console noise). */
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

/** Throws on a non-ok dispense outcome so assertions can focus on the payload. */
function expectOk(result: DispenseResult): Extract<DispenseResult, { ok: true }> {
	if (!result.ok) throw new Error(`expected a dispense, got: ${JSON.stringify(result)}`);
	return result;
}

/** COUNT(*) AS n as a number (0 for no rows). */
async function count(sql: string, ...params: unknown[]): Promise<number> {
	const row = await bindings.DB.prepare(sql).bind(...params).first<{ n: number }>();
	return row?.n ?? 0;
}

let seq = 0;
/** Artist + project + batch + N codes, via direct SQL (no engine under test). */
async function seedProject(opts: { codeCount: number; slug?: string }) {
	const n = ++seq;
	const db = bindings.DB;
	const slug = opts.slug ?? `fan-proj-${n}`;
	const artistId = (await db.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id').bind(`fan-artist-${n}@example.test`).first<{ id: number }>())!.id;
	const title = `Album ${n}`;
	const artistName = `Artist ${n}`;
	const projectId = (await db
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active') RETURNING id`
		)
		.bind(artistId, title, artistName, `https://artist${n}.bandcamp.com/album/album-${n}`, slug, `https://artist${n}.bandcamp.com/yum`)
		.first<{ id: number }>())!.id;
	const batchId = (await db.prepare('INSERT INTO code_batches (project_id, filename, code_count) VALUES (?1, ?2, ?3) RETURNING id')
		.bind(projectId, `${slug}.csv`, opts.codeCount)
		.first<{ id: number }>())!.id;
	const prefix = `f${String(n % 1000).padStart(3, '0')}`;
	const codes = Array.from({ length: opts.codeCount }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
	for (let i = 0; i < codes.length; i += 30) {
		const chunk = codes.slice(i, i + 30);
		const values = chunk.map((_, j) => `(?${j * 3 + 1}, ?${j * 3 + 2}, ?${j * 3 + 3})`).join(', ');
		await db.prepare(`INSERT INTO codes (project_id, batch_id, code) VALUES ${values}`)
			.bind(...chunk.flatMap((code) => [projectId, batchId, code]))
			.run();
	}
	return { projectId, slug, title, artistName, codes };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fan identity — canonical hash', () => {
	it('canonicalizes case + whitespace: one email, one hash', async () => {
		const canonical = await hashFanEmail('fan@example.test', EMAIL_PEPPER);
		expect(await hashFanEmail('  FAN@Example.TEST  ', EMAIL_PEPPER)).toBe(canonical);
		expect(await hashFanEmail('Fan@Example.Test', EMAIL_PEPPER)).toBe(canonical);
		expect(await hashFanEmail('fan@example.test', EMAIL_PEPPER)).toBe(canonical);
	});

	it('is deterministic, pepper-dependent, and 64-char lowercase hex', async () => {
		const hash = await hashFanEmail('a@b.test', EMAIL_PEPPER);
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]+$/);
		expect(await hashFanEmail('a@b.test', EMAIL_PEPPER)).toBe(hash);
		expect(await hashFanEmail('a@b.test', 'other-pepper')).not.toBe(hash);
		expect(await hashFanEmail('other@b.test', EMAIL_PEPPER)).not.toBe(hash);
	});

	it('ensureFanIdentity is idempotent: same row, created_at preserved, last_seen advanced', async () => {
		const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const t0 = new Date('2026-08-28T12:00:00Z');
		const first = await ensureFanIdentity({ db: bindings.DB, fanHash, now: t0 });
		const later = new Date('2026-08-30T12:00:00Z');
		const second = await ensureFanIdentity({ db: bindings.DB, fanHash, now: later });

		expect(second.fanId).toBe(first.fanId);
		expect(second.fanHash).toBe(fanHash);
		expect(await count('SELECT COUNT(*) AS n FROM fan_identities WHERE email_hash = ?1', fanHash)).toBe(1);
		const row = await bindings.DB.prepare('SELECT created_at, last_seen_at FROM fan_identities WHERE email_hash = ?1')
			.bind(fanHash)
			.first<{ created_at: string; last_seen_at: string | null }>();
		expect(row!.created_at).toBe(toSqlUtc(t0)); // first-seen preserved
		expect(row!.last_seen_at).toBe(toSqlUtc(later)); // audit signal advanced
	});

	it('throws on an empty hash (wiring bug, not a user state)', async () => {
		await expect(ensureFanIdentity({ db: bindings.DB, fanHash: '', now: new Date() })).rejects.toThrow(TypeError);
	});
});

describe('fan OTP — request endpoint', () => {
	it('answers 200 with a generic body and mails via the fan purpose', async () => {
		const spy = spyConsole();
		const [response, body] = await post('/api/fan/request-otp', { email: uniqueEmail() });
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true, expiresInSeconds: 600, resendInSeconds: 60 });
		expect(spy.codes).toHaveLength(1);
		expect(spy.codes[0]).toMatch(/^\d{6}$/);
		expect(spy.lines[0]).toContain('(fan)'); // fan wording, not artist
	});

	it('stores the pending under the HMAC subject — never the email', async () => {
		const email = uniqueEmail();
		await post('/api/fan/request-otp', { email });
		const fanHash = await hashFanEmail(email, EMAIL_PEPPER);
		const row = await bindings.DB.prepare('SELECT subject FROM otp_pendings WHERE purpose = ?1 AND subject = ?2')
			.bind('fan', fanHash)
			.first<{ subject: string }>();
		expect(row?.subject).toBe(fanHash);
		// The plaintext address appears in no fan pending subject.
		expect(await count("SELECT COUNT(*) AS n FROM otp_pendings WHERE purpose = 'fan' AND subject = ?1", email)).toBe(0);
	});

	it('case/whitespace variants share ONE pending (canonical subject → cooldown)', async () => {
		const email = uniqueEmail();
		await post('/api/fan/request-otp', { email });
		const [response, body] = await post('/api/fan/request-otp', { email: `  ${email.toUpperCase()}  ` });
		expect(response.status).toBe(429);
		expect(body).toMatchObject({ error: 'otp_cooldown' });
		// Exactly one pending row for the canonical hash.
		const fanHash = await hashFanEmail(email, EMAIL_PEPPER);
		expect(await count("SELECT COUNT(*) AS n FROM otp_pendings WHERE purpose = 'fan' AND subject = ?1", fanHash)).toBe(1);
	});

	it('rejects malformed emails without touching the OTP table', async () => {
		const before = await count("SELECT COUNT(*) AS n FROM otp_pendings WHERE purpose = 'fan'");
		for (const bad of ['not-an-email', 'a@b', 'a b@c.test', '', 42, null]) {
			const [response, body] = await post('/api/fan/request-otp', { email: bad });
			expect(response.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_email' });
		}
		const [noBody] = await post('/api/fan/request-otp', undefined);
		expect(noBody.status).toBe(400);
		expect(await count("SELECT COUNT(*) AS n FROM otp_pendings WHERE purpose = 'fan'")).toBe(before);
	});

	it('never echoes the hash in any response body', async () => {
		const email = uniqueEmail();
		const [okResponse, okBody] = await post('/api/fan/request-otp', { email });
		const fanHash = await hashFanEmail(email, EMAIL_PEPPER);
		expect(okResponse.status).toBe(200);
		expect(JSON.stringify(okBody)).not.toContain(fanHash);
		const [limitedResponse, limitedBody] = await post('/api/fan/request-otp', { email });
		expect(limitedResponse.status).toBe(429);
		expect(JSON.stringify(limitedBody)).not.toContain(fanHash);
	});
});

describe('fan OTP — rate-limit reuse (the BE3 matrix)', () => {
	it('throttles an immediate resend with the cooldown (429 + retry hint)', async () => {
		const email = uniqueEmail();
		await post('/api/fan/request-otp', { email });
		const [response, body] = await post('/api/fan/request-otp', { email });
		expect(response.status).toBe(429);
		expect(body).toMatchObject({ error: 'otp_cooldown' });
		expect((body as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
		expect((body as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(60);
	});

	it('rate-limits one IP after 5 sends across different fan emails', async () => {
		const ip = uniqueIp();
		for (let i = 0; i < 5; i++) await post('/api/fan/request-otp', { email: uniqueEmail() }, new CookieJar(), ip);
		const [response, body] = await post('/api/fan/request-otp', { email: uniqueEmail() }, new CookieJar(), ip);
		expect(response.status).toBe(429);
		expect(body).toMatchObject({ error: 'rate_limited' });
	});

	it('fan and artist sends share the one global daily budget (otp_rate_counters)', async () => {
		const dayStart = windowStart(new Date(), OTP_LIMITS.dailyWindowMs);
		const readGlobal = async () =>
			(await bindings.DB.prepare('SELECT sends FROM otp_rate_counters WHERE scope = ?1 AND window_start = ?2')
				.bind('global1d', toSqlUtc(dayStart))
				.first<{ sends: number }>())?.sends ?? 0;
		const before = await readGlobal();

		// One fan send through the endpoint, one artist send through the core —
		// different IPs: only the shared global counter can observe both.
		await post('/api/fan/request-otp', { email: uniqueEmail() });
		const artistSubject = `shared-budget-${++counter}@example.test`;
		const result = await requestOtp({
			db: bindings.DB,
			purpose: 'artist',
			subject: artistSubject,
			deliverTo: artistSubject,
			pepper: OTP_PEPPER,
			mailer: captureMailer(),
			ip: uniqueIp(),
			now: new Date()
		});
		expect(result.ok).toBe(true);
		expect(await readGlobal()).toBe(before + 2);
	});
});

describe('fan OTP — verify endpoint (happy path)', () => {
	it('creates the identity + a fully flagged long-lived session cookie', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);

		const [response, body] = await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar);
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });
		expect(JSON.stringify(body)).not.toContain(await hashFanEmail(email, EMAIL_PEPPER));

		// Hash-only identity row; no plaintext fan email anywhere.
		const fanHash = await hashFanEmail(email, EMAIL_PEPPER);
		const identity = await bindings.DB.prepare('SELECT id, email_hash FROM fan_identities WHERE email_hash = ?1')
			.bind(fanHash)
			.first<{ id: number; email_hash: string }>();
		expect(identity?.email_hash).toBe(fanHash);

		// One session row for the identity.
		expect(await count('SELECT COUNT(*) AS n FROM fan_sessions WHERE fan_id = ?1', identity!.id)).toBe(1);

		// The pending is consumed (exactly-once storage).
		expect(await count("SELECT COUNT(*) AS n FROM otp_pendings WHERE purpose = 'fan' AND subject = ?1", fanHash)).toBe(0);

		// Cookie: distinct name from artists, fully flagged, 180-day maxAge.
		const cookie = jar.written.get(FAN_SESSION_COOKIE);
		expect(cookie).toBeDefined();
		expect(jar.written.has('bc_artist_session')).toBe(false);
		expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // token.signature
		expect(cookie!.options).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: false, // http test origin; https flips this on
			maxAge: FAN_SESSION_TTL_SECONDS
		});
		expect(FAN_SESSION_TTL_SECONDS).toBe(180 * 24 * 60 * 60);

		// The authorization helper FE3/FE4 consume, straight from the jar:
		const session = await getFanFromCookies({ db: bindings.DB, cookies: jar.cookies, secret: SESSION_SECRET, now: new Date() });
		expect(session).not.toBeNull();
		expect(session!.fanId).toBe(identity!.id);
		expect(session!.fanHash).toBe(fanHash);
		expect(session!.refreshed).toBe(false); // fresh session: nothing to slide
	});

	it('verify canonicalizes the email too (request lowercase, verify uppercase)', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);
		const [response] = await post('/api/fan/verify-otp', { email: ` ${email.toUpperCase()} `, code: spy.codes[0] }, jar);
		expect(response.status).toBe(200);
		expect(jar.written.has(FAN_SESSION_COOKIE)).toBe(true);
	});

	it('codes are exactly-once: replaying a used code fails and creates nothing', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);
		expect((await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar))[0].status).toBe(200);
		const fanHash = await hashFanEmail(email, EMAIL_PEPPER);
		const sessions = await count('SELECT COUNT(*) AS n FROM fan_sessions');
		const [replay] = await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar);
		expect(replay.status).toBe(400);
		expect(await count('SELECT COUNT(*) AS n FROM fan_sessions')).toBe(sessions); // no second session
		expect(await count('SELECT COUNT(*) AS n FROM fan_identities WHERE email_hash = ?1', fanHash)).toBe(1);
	});

	it('supports multiple browsers for one fan (second session, same identity)', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);
		await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar);
		const first = await getFanFromCookies({ db: bindings.DB, cookies: jar.cookies, secret: SESSION_SECRET, now: new Date() });
		expect(first).not.toBeNull();

		const jar2 = new CookieJar();
		const issued = await issueFanSession({ db: bindings.DB, fanId: first!.fanId, secret: SESSION_SECRET, now: new Date() });
		jar2.written.set(FAN_SESSION_COOKIE, { value: issued.cookieValue, options: {} });
		const second = await getFanFromCookies({ db: bindings.DB, cookies: jar2.cookies, secret: SESSION_SECRET, now: new Date() });
		expect(second?.fanId).toBe(first!.fanId);
		expect(second?.fanHash).toBe(first!.fanHash);
		expect(await count('SELECT COUNT(*) AS n FROM fan_sessions WHERE fan_id = ?1', first!.fanId)).toBe(2);
	});
});

describe('fan OTP — wrong code + lockout', () => {
	it('wrong codes never create an identity or a session', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);

		const wrong = spy.codes[0] === '000000' ? '111111' : '000000';
		const [response, body] = await post('/api/fan/verify-otp', { email, code: wrong }, jar);
		expect(response.status).toBe(400);
		expect(body).toEqual({ error: 'invalid_code' });
		expect(jar.written.has(FAN_SESSION_COOKIE)).toBe(false);
		expect(await count('SELECT COUNT(*) AS n FROM fan_identities WHERE email_hash = ?1', await hashFanEmail(email, EMAIL_PEPPER))).toBe(0);
	});

	it('locks out after 5 wrong attempts and voids the real code', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);
		const wrong = spy.codes[0] === '000000' ? '111111' : '000000';

		for (let i = 0; i < 4; i++) {
			const [response, body] = await post('/api/fan/verify-otp', { email, code: wrong }, jar);
			expect(response.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_code' });
		}
		const [locked, lockedBody] = await post('/api/fan/verify-otp', { email, code: wrong }, jar);
		expect(locked.status).toBe(429);
		expect(lockedBody).toEqual({ error: 'too_many_attempts' });

		// The genuine code is dead after lockout, and still no identity exists.
		const [after] = await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar);
		expect(after.status).toBe(400);
		expect(await count('SELECT COUNT(*) AS n FROM fan_identities WHERE email_hash = ?1', await hashFanEmail(email, EMAIL_PEPPER))).toBe(0);
	});

	it('treats malformed submissions exactly like wrong codes', async () => {
		const email = uniqueEmail();
		await post('/api/fan/request-otp', { email });
		for (const code of ['', 'abc', '12345', 123456, null]) {
			const [response, body] = await post('/api/fan/verify-otp', { email, code });
			expect(response.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_code' });
		}
	});
});

describe('fan auth — enumeration safety', () => {
	it('request-OTP responses are byte-identical whether or not the email has claims', async () => {
		// "Has claims" = a real claim row keyed by this email's hash (via BE5).
		const withClaims = uniqueEmail();
		const fanHash = await hashFanEmail(withClaims, EMAIL_PEPPER);
		const { slug } = await seedProject({ codeCount: 2 });
		expectOk(await dispenseCode({ db: bindings.DB, project: slug, fanHash, now: new Date() }));
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE fan_hash = ?1', fanHash)).toBe(1);

		const [knownResponse, knownBody] = await post('/api/fan/request-otp', { email: withClaims });
		const [unknownResponse, unknownBody] = await post('/api/fan/request-otp', { email: uniqueEmail() });
		expect(knownResponse.status).toBe(unknownResponse.status);
		expect(knownBody).toEqual(unknownBody);
	});

	it('verify-OTP answers no-pending and wrong-code identically', async () => {
		const withPending = uniqueEmail();
		await post('/api/fan/request-otp', { email: withPending });
		const [noPendingResponse, noPendingBody] = await post('/api/fan/verify-otp', { email: uniqueEmail(), code: '123456' });
		const [wrongResponse, wrongBody] = await post('/api/fan/verify-otp', { email: withPending, code: '999999' });
		expect(noPendingResponse.status).toBe(wrongResponse.status);
		expect(noPendingBody).toEqual(wrongBody);
	});
});

describe('fan sessions — purpose separation from artist sessions', () => {
	it('the signing labels produce different signatures for the same token', async () => {
		const token = 'same-token-for-both-purposes';
		const asArtist = await hmacBase64UrlPurpose('artist-session', token, SESSION_SECRET);
		const asFan = await hmacBase64UrlPurpose('fan-session', token, SESSION_SECRET);
		expect(asArtist).not.toBe(asFan);
	});

	it('an artist cookie never validates as a fan session, nor vice versa', async () => {
		const db = bindings.DB;
		const now = new Date();
		const artistId = (await db.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id').bind(`sep-${++counter}@example.test`).first<{ id: number }>())!.id;
		const artistCookie = (await issueArtistSession({ db, artistId, secret: SESSION_SECRET, now })).cookieValue;

		const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const fan = await ensureFanIdentity({ db, fanHash, now });
		const fanCookie = (await issueFanSession({ db, fanId: fan.fanId, secret: SESSION_SECRET, now })).cookieValue;

		// Cross-reads reject — at the SIGNATURE step (fan-session vs
		// artist-session label), before any row lookup could even matter.
		expect(await readFanSession({ db, cookieValue: artistCookie, secret: SESSION_SECRET, now })).toBeNull();
		expect(await readArtistSession({ db, cookieValue: fanCookie, secret: SESSION_SECRET, now })).toBeNull();
		// Each still validates in its own reader (same single secret).
		expect(await readArtistSession({ db, cookieValue: artistCookie, secret: SESSION_SECRET, now })).not.toBeNull();
		expect(await readFanSession({ db, cookieValue: fanCookie, secret: SESSION_SECRET, now })).not.toBeNull();
	});

	it('rejects a tampered signature, a wrong secret, and garbage cookies', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);
		await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar);
		const good = jar.written.get(FAN_SESSION_COOKIE)!.value;

		const db = bindings.DB;
		const now = new Date();
		const tampered = `${good.slice(0, -2)}xx`;
		expect(await readFanSession({ db, cookieValue: tampered, secret: SESSION_SECRET, now })).toBeNull();
		expect(await readFanSession({ db, cookieValue: good, secret: 'wrong-secret', now })).toBeNull();
		expect(await readFanSession({ db, cookieValue: 'garbage', secret: SESSION_SECRET, now })).toBeNull();
		expect(await readFanSession({ db, cookieValue: undefined, secret: SESSION_SECRET, now })).toBeNull();
		expect(await readFanSession({ db, cookieValue: good, secret: SESSION_SECRET, now })).not.toBeNull();
	});
});

describe('fan sessions — 180-day sliding expiry', () => {
	it('slides the window only past the half-life; expiry stays authoritative', async () => {
		const db = bindings.DB;
		const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const t0 = new Date('2026-08-28T12:00:00Z');
		const fan = await ensureFanIdentity({ db, fanHash, now: t0 });
		// Small TTL so the whole lifecycle is deterministic under an injected clock.
		const ttl = 100;
		const issued = await issueFanSession({ db, fanId: fan.fanId, secret: SESSION_SECRET, now: t0 }, ttl);
		const tokenHash = await sha256Hex(issued.cookieValue.slice(0, issued.cookieValue.lastIndexOf('.')));
		const rowExpiry = async () =>
			fromSqlUtc((await db.prepare('SELECT expires_at FROM fan_sessions WHERE token_hash = ?1').bind(tokenHash).first<{ expires_at: string }>())!.expires_at);
		const read = (seconds: number) =>
			readFanSession({ db, cookieValue: issued.cookieValue, secret: SESSION_SECRET, now: new Date(t0.getTime() + seconds * 1000), ttlSeconds: ttl });

		// +10 s: 90 s remaining ≥ ttl/2 — no write, no refresh signal.
		const early = await read(10);
		expect(early?.refreshed).toBe(false);
		expect(early?.expiresAt.getTime()).toBe(t0.getTime() + 100_000);
		expect(await rowExpiry()).toBe(t0.getTime() + 100_000);

		// +60 s: 40 s remaining < ttl/2 — slid to now + ttl.
		const slid = await read(60);
		expect(slid?.refreshed).toBe(true);
		expect(slid?.fanHash).toBe(fanHash);
		expect(slid?.expiresAt.getTime()).toBe(t0.getTime() + 160_000);
		expect(await rowExpiry()).toBe(t0.getTime() + 160_000);

		// +150 s (10 s left after the slide): slides again — activity keeps the browser verified.
		const again = await read(150);
		expect(again?.refreshed).toBe(true);
		expect(again?.expiresAt.getTime()).toBe(t0.getTime() + 250_000);

		// A session that lapses its full TTL is dead regardless of signature.
		const second = await issueFanSession({ db, fanId: fan.fanId, secret: SESSION_SECRET, now: t0 }, ttl);
		expect(
			await readFanSession({ db, cookieValue: second.cookieValue, secret: SESSION_SECRET, now: new Date(t0.getTime() + 101_000), ttlSeconds: ttl })
		).toBeNull();
	});

	it('issues with the production TTL by default (180 days)', async () => {
		const db = bindings.DB;
		const t0 = new Date('2026-08-28T12:00:00Z');
		const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const fan = await ensureFanIdentity({ db, fanHash, now: t0 });
		const issued = await issueFanSession({ db, fanId: fan.fanId, secret: SESSION_SECRET, now: t0 });
		expect(issued.expiresAt.getTime()).toBe(t0.getTime() + FAN_SESSION_TTL_SECONDS * 1000);
	});
});

describe('fan auth — sign-out', () => {
	it('revokes the session row and clears the cookie', async () => {
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);
		await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar);
		const cookieValue = jar.written.get(FAN_SESSION_COOKIE)!.value;
		expect(await readFanSession({ db: bindings.DB, cookieValue, secret: SESSION_SECRET, now: new Date() })).not.toBeNull();

		const [response, body] = await post('/api/fan/sign-out', {}, jar);
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });
		expect(jar.deleted.has(FAN_SESSION_COOKIE)).toBe(true);
		expect(await readFanSession({ db: bindings.DB, cookieValue, secret: SESSION_SECRET, now: new Date() })).toBeNull();
	});

	it('is idempotent without a session cookie', async () => {
		const [response, body] = await post('/api/fan/sign-out', {}, new CookieJar());
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true });
	});
});

describe('my codes — listFanClaims (the FE4 query helper)', () => {
	it('returns exactly this fan\'s claims, newest first, with project + status fields', async () => {
		// Full wiring preview: endpoint verify → session fanHash → BE5 dispense.
		const spy = spyConsole();
		const email = uniqueEmail();
		const jar = new CookieJar();
		await post('/api/fan/request-otp', { email }, jar);
		await post('/api/fan/verify-otp', { email, code: spy.codes[0] }, jar);
		const session = await getFanFromCookies({ db: bindings.DB, cookies: jar.cookies, secret: SESSION_SECRET, now: new Date() });
		expect(session).not.toBeNull();
		const fanHash = session!.fanHash;

		const a = await seedProject({ codeCount: 3 });
		const b = await seedProject({ codeCount: 3 });
		const t1 = new Date('2026-09-01T12:00:00Z');
		const t2 = new Date('2026-09-02T12:00:00Z');
		const claimA = expectOk(await dispenseCode({ db: bindings.DB, project: a.slug, fanHash, now: t1 }));
		const claimB = expectOk(await dispenseCode({ db: bindings.DB, project: b.slug, fanHash, now: t2 }));

		// Another fan's claim on project A — must never appear.
		const otherHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		expectOk(await dispenseCode({ db: bindings.DB, project: a.slug, fanHash: otherHash, now: t2 }));

		// This fan reports their project-A code (the BE6 row state, previewed).
		await bindings.DB.prepare("UPDATE codes SET status = 'reported' WHERE id = ?1").bind(claimA.claim.codeId).run();

		const claims = await listFanClaims(bindings.DB, fanHash);
		expect(claims).toHaveLength(2);
		expect(claims[0]).toMatchObject({
			claimId: claimB.claim.claimId,
			projectId: b.projectId,
			slug: b.slug,
			title: b.title,
			artistName: b.artistName,
			codeId: claimB.claim.codeId,
			code: claimB.claim.code,
			kind: 'original',
			codeStatus: 'claimed'
		});
		expect(claims[0]!.claimedAt).toBe(toSqlUtc(t2));
		expect(claims[0]!.reissuedAt).toBeNull();
		expect(claims[1]).toMatchObject({
			claimId: claimA.claim.claimId,
			slug: a.slug,
			code: claimA.claim.code,
			codeStatus: 'reported'
		});
		// The view never leaks the fan hash.
		expect(JSON.stringify(claims)).not.toContain(fanHash);

		// verify-here + dispense-there both upserted the identity: still ONE row.
		expect(await count('SELECT COUNT(*) AS n FROM fan_identities WHERE email_hash = ?1', fanHash)).toBe(1);

		// An email with no claims gets the honest empty list.
		expect(await listFanClaims(bindings.DB, await hashFanEmail(uniqueEmail(), EMAIL_PEPPER))).toEqual([]);
	});
});
