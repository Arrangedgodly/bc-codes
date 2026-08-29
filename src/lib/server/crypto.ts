/**
 * Web Crypto helpers shared by the OTP core and session cookies (BE3+).
 *
 * Everything runs on the standard Workers/global `crypto.subtle` — no Node
 * crypto, so the same code paths execute in `vite dev`, on Workers, and inside
 * the workerd test runtime. Secrets always arrive as arguments (from
 * `platform.env`), never from module state, so callers stay testable.
 */

const encoder = new TextEncoder();

/** Lowercase hex — the storage/compare format for OTP and token hashes. */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/** URL-safe base64 (no padding) — cookie-safe token/signature encoding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmacBytes(value: string, secret: string, algorithm: 'SHA-256' = 'SHA-256'): Promise<ArrayBuffer> {
	const key = encoder.encode(secret);
	return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: algorithm }, false, ['sign']).then((cryptoKey) =>
		crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value))
	);
}

/** HMAC-SHA256(value, secret) as lowercase hex. Used for OTP code hashing (OTP_PEPPER). */
export async function hmacHex(value: string, secret: string): Promise<string> {
	return bytesToHex(new Uint8Array(await hmacBytes(value, secret)));
}

/** HMAC-SHA256(value, secret) as base64url. Used for session cookie signatures (SESSION_SECRET). */
export async function hmacBase64Url(value: string, secret: string): Promise<string> {
	return bytesToBase64Url(new Uint8Array(await hmacBytes(value, secret)));
}

/**
 * Purpose-separated HMAC-SHA256(`${purpose}:${value}`, secret) as base64url.
 *
 * Session cookie signing (BE4): artist and fan cookies are both signed with
 * the ONE SESSION_SECRET, distinguished by a fixed prefix label — cryptographic
 * domain separation. A label prefix is as safe as two independent secrets for
 * cross-purpose confusion (no `value` can make `artist-session:${a}` equal
 * `fan-session:${b}` — the labels differ before the first separator), while
 * ops keeps a single secret to provision/rotate (`wrangler secret put
 * SESSION_SECRET`) instead of a per-purpose sprawl. `:` cannot appear in the
 * labels, and ambiguity between `(purpose, value)` pairs is impossible because
 * the prefix up to the FIRST separator is fixed per purpose. Fans and artists
 * therefore can never replay each other's cookies even under the same secret.
 */
export async function hmacBase64UrlPurpose(purpose: string, value: string, secret: string): Promise<string> {
	return bytesToBase64Url(new Uint8Array(await hmacBytes(`${purpose}:${value}`, secret)));
}

/** Plain SHA-256(value) as hex — session tokens are random, so no pepper is needed. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
	return bytesToHex(new Uint8Array(digest));
}

/** Cryptographically random bytes (Web Crypto, available in workerd + Node 18+). */
export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

/** Opaque random token, base64url-encoded (`length` random bytes). */
export function randomToken(length = 32): string {
	return bytesToBase64Url(randomBytes(length));
}

/**
 * Constant-time string equality (XOR accumulator). Both compared values are
 * fixed-format hex/base64url of the same length in this codebase; the early
 * length exit only leaks lengths, which are public anyway.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
