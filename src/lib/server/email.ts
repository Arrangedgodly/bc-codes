/**
 * Email normalization + pragmatic validation (BE3).
 *
 * Not RFC-complete by design: an OTP mailed to a malformed address simply
 * never arrives, and the request response is identical either way
 * (enumeration-safe). What matters is that the stored subject is normalized
 * (lowercase, trimmed) so `A@x.com` and `a@x.com` share one OTP identity, and
 * that the shape is sane enough to hand to a mailer.
 */

/** Max total length of an email address (RFC 5321 practical limit). */
const MAX_EMAIL_LENGTH = 254;

/** One @, a dot-separated domain of non-empty labels, no whitespace. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export interface NormalizedEmail {
	/** Lowercased, trimmed address — the canonical form for storage + delivery. */
	email: string;
}

/** Normalize + validate; `null` when the input cannot be an email address. */
export function normalizeEmail(input: unknown): NormalizedEmail | null {
	if (typeof input !== 'string') return null;
	const email = input.trim().toLowerCase();
	if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
	if (!EMAIL_PATTERN.test(email)) return null;
	return { email };
}
