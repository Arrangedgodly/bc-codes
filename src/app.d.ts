// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			/**
			 * Cloudflare bindings from wrangler.jsonc (emulated in dev/preview via the
			 * adapter's platformProxy, backed by .wrangler/state).
			 *
			 * Bindings: DB (D1 — all state), ART (R2 artwork cache, reserved for BE8).
				 * Secrets (from .dev.vars locally, `wrangler secret put` in production):
				 * SESSION_SECRET (signs BOTH artist and fan session cookies —
				 * purpose-separated HMAC labels make the two never validate each
				 * other, see src/lib/server/crypto.ts), EMAIL_PEPPER (fan email
				 * HMAC — hash-only fan PII at rest), OTP_PEPPER (OTP code hashing).
				 *
				 * Mailer (BE3, per committed R2 — docs/ultron/research/R2-email-provider.md):
				 * all optional so dev/tests run without them; createMailer() falls back to
				 * the console driver when no provider key is present. RESEND_API_KEY /
				 * BREVO_API_KEY are secrets (`wrangler secret put`, OP1); MAILER_DRIVER and
				 * MAIL_FROM are plain `vars` (wrangler.jsonc) or .dev.vars entries.
				 */
				env: {
					DB: D1Database;
					ART: R2Bucket;
					SESSION_SECRET: string;
					EMAIL_PEPPER: string;
					OTP_PEPPER: string;
					/** Explicit driver override: 'console' | 'resend' | 'brevo'. */
					MAILER_DRIVER?: string;
					/** Envelope sender for real drivers, e.g. 'bc-codes <noreply@send.example.com>'. */
					MAIL_FROM?: string;
					/** Resend API key (sending_access, domain-restricted) — production driver. */
					RESEND_API_KEY?: string;
					/** Brevo API key — R2's prepared fallback driver. */
					BREVO_API_KEY?: string;
				};
		}
	}
}

export {};
