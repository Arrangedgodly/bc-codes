/**
 * Mailer port tests (BE3, per committed R2). All HTTP adapters run against an
 * injected fetch stub — no request ever leaves the process (the "no real
 * sends in tests/dev" rule), and the stub records exactly what would go on
 * the wire so the provider-specific request shapes are pinned.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BrevoMailer,
	ConsoleMailer,
	MailSendError,
	ResendMailer,
	createMailer,
	type MailerEnv
} from '../src/lib/server/mailer';

type Captured = { url: string; init: RequestInit };

/** fetch stub: records the request, returns the given status/body. */
function stubFetch(status: number, body: string = '{}'): { captured: () => Captured[]; fetch: typeof fetch } {
	const seen: Captured[] = [];
	return {
		captured: () => seen,
		fetch: (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response(body, { status, headers: { 'content-type': 'application/json' } });
		}) as typeof fetch
	};
}

const message = { to: 'artist@example.test', purpose: 'artist' as const, code: '123456', expiresInSeconds: 600 };

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ConsoleMailer — dev driver', () => {
	it('logs the recipient and the OTP (that is the dev delivery channel)', async () => {
		const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
		await new ConsoleMailer().sendOtp(message);
		expect(logged).toHaveBeenCalledTimes(1);
		const line = logged.mock.calls[0]!.join(' ');
		expect(line).toContain('artist@example.test');
		expect(line).toContain('123456');
		expect(line).toContain('10 min');
	});
});

describe('ResendMailer — R2 production adapter', () => {
	it('POSTs the documented Resend shape with a Bearer key', async () => {
		const stub = stubFetch(200);
		await new ResendMailer({ apiKey: 're_test_key', from: 'bc-codes <noreply@send.example.test>', fetchImpl: stub.fetch })
			.sendOtp(message);

		expect(stub.captured()).toHaveLength(1);
		const [call] = stub.captured();
		expect(call.url).toBe('https://api.resend.com/emails');
		expect(call.init.method).toBe('POST');
		expect((call.init.headers as Record<string, string>)['Authorization']).toBe('Bearer re_test_key');
		const body = JSON.parse(String(call.init.body));
		expect(body.from).toBe('bc-codes <noreply@send.example.test>');
		expect(body.to).toBe('artist@example.test');
		expect(body.subject).toContain('verification code');
		expect(body.text).toContain('123456');
		expect(body.text).toContain('10 minutes');
	});

	it('classifies 429 as provider-throttled (R2: distinct failure class)', async () => {
		const stub = stubFetch(429, '{"message":"Rate limit exceeded"}');
		const attempt = new ResendMailer({ apiKey: 'k', from: 'a@b.test', fetchImpl: stub.fetch }).sendOtp(message);
		await expect(attempt).rejects.toBeInstanceOf(MailSendError);
		await expect(attempt).rejects.toMatchObject({ kind: 'provider-throttled' });
	});

	it('classifies other non-2xx as provider-error with the status in the message', async () => {
		const stub = stubFetch(500, '{"message":"boom"}');
		const attempt = new ResendMailer({ apiKey: 'k', from: 'a@b.test', fetchImpl: stub.fetch }).sendOtp(message);
		await expect(attempt).rejects.toMatchObject({ kind: 'provider-error' });
		await expect(attempt).rejects.toThrow(/500/);
	});

	it('wraps transport failures as provider-error with the cause attached', async () => {
		const transportFailure = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		const attempt = new ResendMailer({ apiKey: 'k', from: 'a@b.test', fetchImpl: transportFailure }).sendOtp(message);
		await expect(attempt).rejects.toMatchObject({ kind: 'provider-error' });
	});
});

describe('BrevoMailer — R2 prepared fallback adapter', () => {
	it('POSTs the documented Brevo shape with the api-key header', async () => {
		const stub = stubFetch(201);
		await new BrevoMailer({ apiKey: 'xkeysib-test', from: 'bc-codes <noreply@send.example.test>', fetchImpl: stub.fetch })
			.sendOtp(message);

		const [call] = stub.captured();
		expect(call.url).toBe('https://api.brevo.com/v3/smtp/email');
		expect((call.init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
		const body = JSON.parse(String(call.init.body));
		expect(body.sender).toEqual({ name: 'bc-codes', email: 'noreply@send.example.test' });
		expect(body.to).toEqual([{ email: 'artist@example.test' }]);
		expect(body.textContent).toContain('123456');
	});

	it('accepts a bare address as MAIL_FROM and classifies 429 as throttled', async () => {
		const stub = stubFetch(429, '{"message":"Daily quota exceeded"}');
		const attempt = new BrevoMailer({ apiKey: 'k', from: 'noreply@send.example.test', fetchImpl: stub.fetch }).sendOtp(message);
		await expect(attempt).rejects.toMatchObject({ kind: 'provider-throttled' });
	});
});

describe('createMailer — env-based selection', () => {
	it('defaults to the console driver when no provider key is configured', () => {
		expect(createMailer({}).driver).toBe('console');
	});

	it('selects Resend when only RESEND_API_KEY is present (OP1 minimal setup)', () => {
		const mailer = createMailer({ RESEND_API_KEY: 're_k', MAIL_FROM: 'bc-codes <noreply@send.example.test>' });
		expect(mailer.driver).toBe('resend');
	});

	it('an explicit console driver wins even when a Resend key exists', () => {
		expect(createMailer({ MAILER_DRIVER: 'console', RESEND_API_KEY: 're_k' }).driver).toBe('console');
	});

	it('fails loudly on resend without a key (never silently not-sending)', () => {
		expect(() => createMailer({ MAILER_DRIVER: 'resend' })).toThrow(/RESEND_API_KEY/);
	});

	it('fails loudly on resend without MAIL_FROM', () => {
		expect(() => createMailer({ MAILER_DRIVER: 'resend', RESEND_API_KEY: 're_k' })).toThrow(/MAIL_FROM/);
	});

	it('selects brevo explicitly, and fails without its key', () => {
		const env: MailerEnv = {
			MAILER_DRIVER: 'brevo',
			BREVO_API_KEY: 'xkeysib-k',
			MAIL_FROM: 'bc-codes <noreply@send.example.test>'
		};
		expect(createMailer(env).driver).toBe('brevo');
		expect(() => createMailer({ MAILER_DRIVER: 'brevo', MAIL_FROM: 'a@b.test' })).toThrow(/BREVO_API_KEY/);
	});

	it('rejects an unknown driver name', () => {
		expect(() => createMailer({ MAILER_DRIVER: 'sendgrid' })).toThrow(/MAILER_DRIVER/);
	});
});
