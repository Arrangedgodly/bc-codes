/**
 * Fan sessions (BE4) — the "verify once per browser" credential.
 *
 * Mirrors artist-session.ts (same `token.signature` envelope, token never at
 * rest — only its SHA-256; server-side `expires_at` authoritative; sign-out
 * revokes the row) with three deliberate differences:
 *
 *   1. Cookie name `bc_fan_session` (distinct from `bc_artist_session`).
 *   2. Signing purpose label `fan-session` — both cookies are signed with the
 *      ONE SESSION_SECRET, but the purpose-separated HMAC label
 *      (hmacBase64UrlPurpose, crypto.ts) means an artist token never validates
 *      as a fan token and vice versa. One secret to provision/rotate; zero
 *      cross-population confusion.
 *   3. TTL 180 days with a SLIDING window: fans verify once per browser and
 *      should never be asked again while active. Each read past the session's
 *      half-life advances `expires_at` to now + TTL (at most one write per 90
 *      days per active session — not a write per request), and the refreshed
 *      flag tells the caller to re-set the cookie so the browser's maxAge
 *      follows the server's expiry:
 *
 *        const session = await getFanFromCookies({ db, cookies: event.cookies,
 *          secret: env.SESSION_SECRET, now: new Date() });
 *        if (session?.refreshed) {
 *          event.cookies.set(FAN_SESSION_COOKIE,
 *            event.cookies.get(FAN_SESSION_COOKIE)!, fanSessionCookieOptions(secure));
 *        }
 *
 * Rows live in fan_sessions purely so a session is REVOCABLE server-side
 * (sign-out, incident response) — the signature alone grants nothing, exactly
 * like artist sessions.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { hmacBase64UrlPurpose, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import { fromSqlUtc, toSqlUtc } from './time';

export const FAN_SESSION_COOKIE = 'bc_fan_session';

/** 180 days — the fan bargain is "verify once per browser" (plan.md scope). */
export const FAN_SESSION_TTL_SECONDS = 180 * 24 * 60 * 60;

/** Purpose label — see the module header and hmacBase64UrlPurpose (crypto.ts). */
const SIGNING_PURPOSE = 'fan-session';

/** Cookie options for SvelteKit's `cookies.set`/`delete`. */
export function fanSessionCookieOptions(secure: boolean) {
	return {
		path: '/',
		// HttpOnly: JS cannot read the session token (XSS hardening).
		httpOnly: true,
		sameSite: 'lax' as const,
		// Secure except on plain-http local dev (`vite dev`), where browsers
		// would otherwise drop the cookie entirely.
		secure,
		maxAge: FAN_SESSION_TTL_SECONDS
	};
}

/** A freshly issued session: cookie value to set + server-side expiry. */
export interface IssuedFanSession {
	/** Complete cookie value (`token.signature`) — set via cookies.set. */
	cookieValue: string;
	/** Server-side expiry moment (also the cookie's maxAge basis). */
	expiresAt: Date;
}

async function signToken(token: string, secret: string): Promise<string> {
	return hmacBase64UrlPurpose(SIGNING_PURPOSE, token, secret);
}

/**
 * Create a session row + signed cookie value for a fan identity. Expired
 * sessions for that fan are lazily removed in the same call (a fan with many
 * stale browsers does not accumulate dead rows).
 */
export async function issueFanSession(
	deps: { db: D1Database; fanId: number; secret: string; now: Date },
	ttlSeconds: number = FAN_SESSION_TTL_SECONDS
): Promise<IssuedFanSession> {
	const { db, fanId, secret, now } = deps;
	const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

	await db.prepare('DELETE FROM fan_sessions WHERE fan_id = ?1 AND expires_at <= ?2').bind(fanId, toSqlUtc(now)).run();

	const token = randomToken(32);
	await db
		.prepare('INSERT INTO fan_sessions (fan_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
		.bind(fanId, await sha256Hex(token), toSqlUtc(expiresAt), toSqlUtc(now))
		.run();

	return { cookieValue: `${token}.${await signToken(token, secret)}`, expiresAt };
}

/** Split + signature-check a cookie value; returns the token or null. */
async function extractVerifiedToken(cookieValue: string | undefined | null, secret: string): Promise<string | null> {
	if (!cookieValue) return null;
	const separator = cookieValue.lastIndexOf('.');
	if (separator <= 0) return null;
	const token = cookieValue.slice(0, separator);
	const signature = cookieValue.slice(separator + 1);
	if (token.length === 0 || signature.length === 0) return null;
	const expected = await signToken(token, secret);
	return timingSafeEqual(signature, expected) ? token : null;
}

/** The validated fan identity, for authorizing fan endpoints (FE3/FE4). */
export interface FanSession {
	fanId: number;
	/** The canonical email HMAC — the key dispenseCode (BE5) and listFanClaims (FE4) consume. */
	fanHash: string;
	/** Server-side expiry as of THIS read — after any sliding refresh it performed. */
	expiresAt: Date;
	/**
	 * True when this read advanced the sliding window: re-set the cookie (same
	 * value, fresh maxAge) so the browser credential follows the server row —
	 * see the module header for the exact recipe.
	 */
	refreshed: boolean;
}

/**
 * Validate a cookie value end-to-end: signature (fan-session purpose) ->
 * token hash -> live session row joined to its identity. Returns null for
 * anything short of a fully valid, unexpired session. A session past its
 * half-life is slid forward (`expires_at` = now + TTL) and reported with
 * `refreshed: true`; sessions in the first half of their window are read
 * write-free.
 */
export async function readFanSession(
	deps: {
		db: D1Database;
		cookieValue: string | undefined | null;
		secret: string;
		now: Date;
		/** Sliding-window basis; must match the issuing TTL (default: the production 180 d). */
		ttlSeconds?: number;
	}
): Promise<FanSession | null> {
	const { db, secret, now } = deps;
	const ttlSeconds = deps.ttlSeconds ?? FAN_SESSION_TTL_SECONDS;
	const token = await extractVerifiedToken(deps.cookieValue, secret);
	if (!token) return null;
	const tokenHash = await sha256Hex(token);

	const row = await db
		.prepare(
			`SELECT s.fan_id AS fan_id, f.email_hash AS email_hash, s.expires_at AS expires_at
			 FROM fan_sessions s JOIN fan_identities f ON f.id = s.fan_id
			 WHERE s.token_hash = ?1`
		)
		.bind(tokenHash)
		.first<{ fan_id: number; email_hash: string; expires_at: string }>();
	if (!row) return null;

	const nowMs = now.getTime();
	const expiresMs = fromSqlUtc(row.expires_at);
	if (expiresMs <= nowMs) return null;

	// Sliding refresh once past the half-life: remaining < TTL/2.
	if (expiresMs - nowMs < (ttlSeconds * 1000) / 2) {
		const expiresAt = new Date(nowMs + ttlSeconds * 1000);
		await db.prepare('UPDATE fan_sessions SET expires_at = ?1 WHERE token_hash = ?2').bind(toSqlUtc(expiresAt), tokenHash).run();
		return { fanId: row.fan_id, fanHash: row.email_hash, expiresAt, refreshed: true };
	}
	return { fanId: row.fan_id, fanHash: row.email_hash, expiresAt: new Date(expiresMs), refreshed: false };
}

/**
 * Cookie-reading convenience for request handlers: pull the fan from
 * `event.cookies` and run `readFanSession`. FE3 (claim flow) and FE4 (my
 * codes) authorize with exactly this; on `refreshed`, re-set the cookie per
 * the module-header recipe.
 */
export async function getFanFromCookies(deps: {
	db: D1Database;
	cookies: { get(name: string): string | undefined };
	secret: string;
	now: Date;
	ttlSeconds?: number;
}): Promise<FanSession | null> {
	return readFanSession({ ...deps, cookieValue: deps.cookies.get(FAN_SESSION_COOKIE) });
}

/**
 * Sign-out: delete the session row behind a valid cookie (signature verified
 * first so a garbage cookie cannot delete rows by guessing hashes). The caller
 * also deletes the cookie client-side.
 */
export async function revokeFanSession(deps: {
	db: D1Database;
	cookieValue: string | undefined | null;
	secret: string;
}): Promise<void> {
	const token = await extractVerifiedToken(deps.cookieValue, deps.secret);
	if (!token) return;
	await deps.db.prepare('DELETE FROM fan_sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
}
