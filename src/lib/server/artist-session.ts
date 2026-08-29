/**
 * Artist sessions (BE3) — issue/validate/revoke via a signed HttpOnly cookie.
 *
 * Cookie value: `<token>.<hmac>` where token is 32 random bytes (base64url)
 * and hmac = HMAC-SHA256(`artist-session:${token}`, SESSION_SECRET)
 * (base64url — purpose-labeled so the same secret also signs fan cookies
 * (BE4) without the two ever validating each other). The signature
 * lets the server reject forged/tampered cookies without touching the
 * database; the token is then matched by SHA-256 hash against
 * `artist_sessions.token_hash` (the raw token is never stored — a DB leak
 * yields unusable hashes).
 *
 * Server-side expiry (`expires_at`) is authoritative — a signed cookie alone
 * grants nothing after its session row expires or is revoked (sign-out).
 *
 * BE4's fan-session.ts mirrors this module with a distinct cookie name,
 * signing purpose, and a long sliding TTL.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { hmacBase64UrlPurpose, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import { fromSqlUtc, toSqlUtc } from './time';

export const ARTIST_SESSION_COOKIE = 'bc_artist_session';

/** 7 days — artists return to manage drops, not daily. */
export const ARTIST_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Cookie options for SvelteKit's `cookies.set`/`delete`. */
export function artistSessionCookieOptions(secure: boolean) {
	return {
		path: '/',
		// HttpOnly: JS cannot read the session token (XSS hardening).
		httpOnly: true,
		sameSite: 'lax' as const,
		// Secure except on plain-http local dev (`vite dev`), where browsers
		// would otherwise drop the cookie entirely.
		secure,
		maxAge: ARTIST_SESSION_TTL_SECONDS
	};
}

/** A freshly issued session: cookie value to set + server-side expiry. */
export interface IssuedArtistSession {
	/** Complete cookie value (`token.signature`) — set via cookies.set. */
	cookieValue: string;
	/** Server-side expiry moment (also the cookie's maxAge basis). */
	expiresAt: Date;
}

/**
 * Purpose label for this cookie's signature — see hmacBase64UrlPurpose
 * (crypto.ts): the artist and fan session cookies share SESSION_SECRET but can
 * never validate each other's tokens.
 */
const SIGNING_PURPOSE = 'artist-session';

async function signToken(token: string, secret: string): Promise<string> {
	return hmacBase64UrlPurpose(SIGNING_PURPOSE, token, secret);
}

/**
 * Create a session row + signed cookie value for an artist. Any expired
 * sessions for that artist are lazily removed in the same call.
 */
export async function issueArtistSession(
	deps: { db: D1Database; artistId: number; secret: string; now: Date },
	ttlSeconds: number = ARTIST_SESSION_TTL_SECONDS
): Promise<IssuedArtistSession> {
	const { db, artistId, secret, now } = deps;
	const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

	await db.prepare('DELETE FROM artist_sessions WHERE artist_id = ?1 AND expires_at <= ?2').bind(artistId, toSqlUtc(now)).run();

	const token = randomToken(32);
	await db
		.prepare('INSERT INTO artist_sessions (artist_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
		.bind(artistId, await sha256Hex(token), toSqlUtc(expiresAt), toSqlUtc(now))
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

/** The validated artist identity, for authorizing later endpoints (BE7+). */
export interface ArtistSession {
	artistId: number;
	email: string;
}

/**
 * Validate a cookie value end-to-end: signature -> token hash -> live session
 * row joined to its artist. Returns null for anything short of a fully valid,
 * unexpired session (tampered signature, unknown/revoked token, expired row).
 */
export async function readArtistSession(
	deps: { db: D1Database; cookieValue: string | undefined | null; secret: string; now: Date }
): Promise<ArtistSession | null> {
	const { db, secret, now } = deps;
	const token = await extractVerifiedToken(deps.cookieValue, secret);
	if (!token) return null;

	const row = await db
		.prepare(
			`SELECT s.artist_id AS artist_id, a.email AS email, s.expires_at AS expires_at
			 FROM artist_sessions s JOIN artists a ON a.id = s.artist_id
			 WHERE s.token_hash = ?1`
		)
		.bind(await sha256Hex(token))
		.first<{ artist_id: number; email: string; expires_at: string }>();
	if (!row) return null;
	if (fromSqlUtc(row.expires_at) <= now.getTime()) return null;

	return { artistId: row.artist_id, email: row.email };
}

/**
 * Cookie-reading convenience for request handlers: pull the artist from
 * `event.cookies` (SvelteKit decodes/validates the cookie envelope) and run
 * `readArtistSession`. Later tasks (BE7+) authorize with exactly this.
 */
export async function getArtistFromCookies(
	deps: {
		db: D1Database;
		cookies: { get(name: string): string | undefined };
		secret: string;
		now: Date;
	}
): Promise<ArtistSession | null> {
	return readArtistSession({ ...deps, cookieValue: deps.cookies.get(ARTIST_SESSION_COOKIE) });
}

/**
 * Sign-out: delete the session row behind a valid cookie (signature verified
 * first so a garbage cookie cannot delete rows by guessing hashes). The caller
 * also deletes the cookie client-side.
 */
export async function revokeArtistSession(deps: {
	db: D1Database;
	cookieValue: string | undefined | null;
	secret: string;
}): Promise<void> {
	const token = await extractVerifiedToken(deps.cookieValue, deps.secret);
	if (!token) return;
	await deps.db.prepare('DELETE FROM artist_sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
}
