/**
 * Mailer port + drivers (BE3), per committed R2
 * (docs/ultron/research/R2-email-provider.md).
 *
 * One interface, three drivers:
 *   - ConsoleMailer — dev/test default; logs the OTP instead of sending. No
 *     network I/O, so tests never send real mail.
 *   - ResendMailer  — the production adapter (R2 decision): POST
 *     https://api.resend.com/emails with a Bearer key (`sending_access`,
 *     domain-restricted; `wrangler secret put RESEND_API_KEY` at OP1).
 *   - BrevoMailer   — R2's prepared fallback (300/day free vs Resend's
 *     100/day): same interface, swap via MAILER_DRIVER or key presence.
 *
 * Provider specifics never leave this file — it is the only import site for
 * Resend/Brevo (the R2 lock-in hedge). Failures throw `MailSendError` with a
 * `kind`, so callers can distinguish "provider throttled / over quota" from
 * generic errors and surface that honestly (R2 implementation consequence).
 */

/** Everything a driver needs to deliver one OTP email. */
export interface OtpMessage {
	/** Recipient address (plaintext — the send itself requires it). */
	to: string;
	/** Which flow the code belongs to; only affects wording. */
	purpose: 'artist' | 'fan';
	/** The 6-digit code. */
	code: string;
	/** Seconds until the stored pending expires. */
	expiresInSeconds: number;
}

/** Failure classification callers act on. */
export type MailSendErrorKind = 'provider-throttled' | 'provider-error';

/** A send attempt failed; `kind` says whether the provider refused by quota/rate. */
export class MailSendError extends Error {
	readonly kind: MailSendErrorKind;

	constructor(kind: MailSendErrorKind, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'MailSendError';
		this.kind = kind;
	}
}

/** The port. `driver` is exposed for logging/tests. */
export interface Mailer {
	readonly driver: 'console' | 'resend' | 'brevo';
	sendOtp(message: OtpMessage): Promise<void>;
}

function otpText(message: OtpMessage): string {
	const minutes = Math.round(message.expiresInSeconds / 60);
	const what = message.purpose === 'artist' ? 'signing in to bc-codes' : 'verifying your email on bc-codes';
	return [
		`Your bc-codes verification code is ${message.code}.`,
		`It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
		`If you did not request this code (${what}), you can ignore this email.`
	].join('\n');
}

function otpSubject(): string {
	return 'Your bc-codes verification code';
}

/** Minimal fetch shape so adapters are testable with a plain stub (no globals mutated). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Dev/test driver: logs the OTP to the server console. Selected automatically
 * whenever no provider key is configured, so `vite dev` and vitest never send.
 */
export class ConsoleMailer implements Mailer {
	readonly driver = 'console' as const;

	sendOtp(message: OtpMessage): Promise<void> {
		const minutes = Math.round(message.expiresInSeconds / 60);
		// Intentionally prints the code: this is how a developer "receives" it.
		console.log(
			`[mailer:console] OTP for ${message.to} (${message.purpose}): ${message.code} — expires in ${minutes} min`
		);
		return Promise.resolve();
	}
}

/** Map a provider HTTP failure to the MailSendError classification. */
function providerError(provider: string, status: number, body: string): MailSendError {
	const excerpt = body.slice(0, 300).replace(/\s+/g, ' ').trim();
	// 429 = provider rate/quota refusal (Resend: 10 req/s + daily cap; Brevo:
	// daily cap / rate). R2 calls for surfacing this class distinctly.
	if (status === 429) {
		return new MailSendError('provider-throttled', `${provider} throttled or over quota (HTTP 429): ${excerpt}`);
	}
	return new MailSendError('provider-error', `${provider} send failed (HTTP ${status}): ${excerpt}`);
}

/** Parse a JSON error body without trusting its shape. */
async function readBody(response: Response): Promise<string> {
	try {
		return (await response.text()) ?? '';
	} catch {
		return '';
	}
}

/**
 * Resend adapter (production, R2). `fetchImpl` is injectable for tests; the
 * default is the Workers global — from a Worker this is a plain HTTPS call.
 */
export class ResendMailer implements Mailer {
	readonly driver = 'resend' as const;
	private readonly apiKey: string;
	private readonly from: string;
	private readonly fetchImpl: FetchLike;

	constructor(options: { apiKey: string; from: string; fetchImpl?: FetchLike }) {
		this.apiKey = options.apiKey;
		this.from = options.from;
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	}

	async sendOtp(message: OtpMessage): Promise<void> {
		let response: Response;
		try {
			response = await this.fetchImpl('https://api.resend.com/emails', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					from: this.from,
					to: message.to,
					subject: otpSubject(),
					text: otpText(message)
				})
			});
		} catch (cause) {
			throw new MailSendError('provider-error', 'Resend request failed before a response arrived', { cause });
		}
		if (!response.ok) {
			throw providerError('Resend', response.status, await readBody(response));
		}
	}
}

/**
 * Brevo adapter — R2's prepared fallback (same Mailer interface; free tier is
 * 300/day vs Resend's 100/day). Not selected by default; enable via
 * MAILER_DRIVER=brevo + BREVO_API_KEY once Brevo domain auth is in place.
 */
export class BrevoMailer implements Mailer {
	readonly driver = 'brevo' as const;
	private readonly apiKey: string;
	private readonly fromEmail: string;
	private readonly fromName: string;
	private readonly fetchImpl: FetchLike;

	constructor(options: { apiKey: string; from: string; fetchImpl?: FetchLike }) {
		this.apiKey = options.apiKey;
		// Accepts either "Name <a@b.c>" (as RESEND-style MAIL_FROM) or a bare address.
		const match = /^(.*?)\s*<\s*([^>]+)\s*>$/.exec(options.from.trim());
		this.fromName = match?.[1]?.trim() || 'bc-codes';
		this.fromEmail = match?.[2] ?? options.from.trim();
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	}

	async sendOtp(message: OtpMessage): Promise<void> {
		let response: Response;
		try {
			response = await this.fetchImpl('https://api.brevo.com/v3/smtp/email', {
				method: 'POST',
				headers: {
					'api-key': this.apiKey,
					'Content-Type': 'application/json',
					accept: 'application/json'
				},
				body: JSON.stringify({
					sender: { name: this.fromName, email: this.fromEmail },
					to: [{ email: message.to }],
					subject: otpSubject(),
					textContent: otpText(message)
				})
			});
		} catch (cause) {
			throw new MailSendError('provider-error', 'Brevo request failed before a response arrived', { cause });
		}
		if (!response.ok) {
			throw providerError('Brevo', response.status, await readBody(response));
		}
	}
}

/** Subset of the Workers env the factory reads (all optional — see src/app.d.ts). */
export interface MailerEnv {
	/** Explicit driver override: 'console' | 'resend' | 'brevo'. */
	MAILER_DRIVER?: string;
	/** Envelope sender, e.g. 'bc-codes <noreply@send.example.com>'. Required for real drivers. */
	MAIL_FROM?: string;
	RESEND_API_KEY?: string;
	BREVO_API_KEY?: string;
}

function parseFrom(from: string): string {
	const trimmed = from.trim();
	if (trimmed.length === 0) throw new Error('MAIL_FROM must be set, e.g. "bc-codes <noreply@send.example.com>"');
	return trimmed;
}

/**
 * Select the driver by env:
 *   1. explicit MAILER_DRIVER wins (unknown values fail loudly, not silently);
 *   2. otherwise Resend when RESEND_API_KEY is present;
 *   3. otherwise ConsoleMailer — dev and tests can never send real mail.
 * Real drivers additionally require MAIL_FROM and throw without it, so a
 * misconfigured deploy fails visibly instead of mailing from a bogus address.
 */
export function createMailer(env: MailerEnv): Mailer {
	const driver = env.MAILER_DRIVER?.trim().toLowerCase();
	if (driver === 'console') return new ConsoleMailer();
	if (driver === 'resend' || (!driver && env.RESEND_API_KEY)) {
		if (!env.RESEND_API_KEY) {
			throw new Error('MAILER_DRIVER=resend but RESEND_API_KEY is not set (wrangler secret put RESEND_API_KEY)');
		}
		if (!env.MAIL_FROM) {
			throw new Error('MAILER_DRIVER=resend but MAIL_FROM is not set, e.g. "bc-codes <noreply@send.example.com>"');
		}
		return new ResendMailer({ apiKey: env.RESEND_API_KEY, from: parseFrom(env.MAIL_FROM) });
	}
	if (driver === 'brevo' || (!driver && env.BREVO_API_KEY && !env.RESEND_API_KEY)) {
		if (!env.BREVO_API_KEY) {
			throw new Error('MAILER_DRIVER=brevo but BREVO_API_KEY is not set');
		}
		if (!env.MAIL_FROM) {
			throw new Error('MAILER_DRIVER=brevo but MAIL_FROM is not set, e.g. "bc-codes <noreply@send.example.com>"');
		}
		return new BrevoMailer({ apiKey: env.BREVO_API_KEY, from: parseFrom(env.MAIL_FROM) });
	}
	if (driver) {
		throw new Error(`Unknown MAILER_DRIVER "${driver}" (expected console | resend | brevo)`);
	}
	return new ConsoleMailer();
}
