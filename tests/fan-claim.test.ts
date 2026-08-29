/**
 * Fan claim endpoint tests (FE3) — POST /api/fan/claim against the real D1
 * binding (vitest inside workerd; migrations applied by tests/setup.ts), plus
 * fanClaimForProject (the SSR load's revisit read).
 *
 * Mirrors tests/fan-auth.test.ts: hand-rolled RequestEvent + cookie-recording
 * jar; sessions issued directly via issueFanSession (the OTP flow itself is
 * covered by the fan-auth suite).
 *
 * Coverage contract (plan.md FE3):
 *   - auth: no session / garbage cookie → 401, nothing dispensed;
 *   - fresh claim: 200 outcome=claimed reused=false, code flipped, pool honest;
 *   - revisit (the 1+1 limit-hit state): 200 outcome=revisit reused=true with
 *     the SAME code — never a dead end, never a second code;
 *   - ownership: the response only ever contains the session fan's claim;
 *   - body grammar: exactly one of projectId/slug, malformed rejected (400);
 *   - honest states: paused 409, drained 409, unknown/draft 404 — and the
 *     last-code dispense flips the project drained while still succeeding;
 *   - sliding-window cookie recipe: a past-half-life session is re-set.
 *
 * Storage persists across test files (fresh emails/slugs per test; other
 * files' projects may exist but are never referenced here).
 */

import { env as bindings } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { POST as fanClaimHandler } from '../src/routes/api/fan/claim/+server';
import { ensureFanIdentity, fanClaimForProject, hashFanEmail } from '../src/lib/server/fan-identity';
import { FAN_SESSION_COOKIE, issueFanSession } from '../src/lib/server/fan-session';
import { toSqlUtc } from '../src/lib/server/time';

const SESSION_SECRET = 'test-session-secret';
const EMAIL_PEPPER = 'test-email-pepper';

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
const uniqueEmail = () => `claim-fan-${++counter}@example.test`;

interface SeededFan {
	jar: CookieJar;
	fanHash: string;
}

/** A fan identity + live session cookie, without the OTP detour (covered elsewhere). */
async function seedFan(): Promise<SeededFan> {
	const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
	const identity = await ensureFanIdentity({ db: bindings.DB, fanHash, now: new Date() });
	const issued = await issueFanSession({ db: bindings.DB, fanId: identity.fanId, secret: SESSION_SECRET, now: new Date() });
	const jar = new CookieJar();
	jar.written.set(FAN_SESSION_COOKIE, { value: issued.cookieValue, options: {} });
	return { jar, fanHash };
}

let projectSeq = 0;

interface SeededProject {
	projectId: number;
	slug: string;
	codes: string[];
	status: 'active' | 'paused' | 'drained' | 'draft';
}

/** Artist + project + codes at the requested status, via direct SQL. */
async function seedProject(opts: { codeCount: number; status?: SeededProject['status'] }): Promise<SeededProject> {
	const n = ++projectSeq;
	const db = bindings.DB;
	const artistId = (await db.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id').bind(`claim-artist-${n}@example.test`).first<{ id: number }>())!.id;
	const slug = `claim-drop-${n}`;
	const status = opts.status ?? 'active';
	const projectId = (await db
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`
		)
		.bind(artistId, `Claim Album ${n}`, `Claim Artist ${n}`, `https://claim${n}.bandcamp.com/album/a-${n}`, slug, `https://claim${n}.bandcamp.com/yum`, status)
		.first<{ id: number }>())!.id;
	const batchId = (await db.prepare('INSERT INTO code_batches (project_id, filename, code_count) VALUES (?1, ?2, ?3) RETURNING id')
		.bind(projectId, `${slug}.csv`, opts.codeCount)
		.first<{ id: number }>())!.id;
	const prefix = `c${String(n % 1000).padStart(3, '0')}`;
	const codes = Array.from({ length: opts.codeCount }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
	for (let i = 0; i < codes.length; i += 30) {
		const chunk = codes.slice(i, i + 30);
		const values = chunk.map((_, j) => `(?${j * 3 + 1}, ?${j * 3 + 2}, ?${j * 3 + 3})`).join(', ');
		await db.prepare(`INSERT INTO codes (project_id, batch_id, code) VALUES ${values}`)
			.bind(...chunk.flatMap((code) => [projectId, batchId, code]))
			.run();
	}
	return { projectId, slug, codes, status };
}

function makeEvent(body: unknown, jar: CookieJar): RequestEvent {
	return {
		request: new Request('http://app.test/api/fan/claim', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://app.test/api/fan/claim'),
		cookies: jar.cookies,
		getClientAddress: () => '203.0.113.99',
		platform: {
			env: {
				DB: bindings.DB,
				ART: null,
				SESSION_SECRET,
				EMAIL_PEPPER,
				OTP_PEPPER: 'test-otp-pepper',
				MAILER_DRIVER: 'console'
			}
		}
	} as unknown as RequestEvent;
}

interface ClaimResponse {
	ok?: boolean;
	outcome?: 'claimed' | 'revisit';
	reused?: boolean;
	claim?: {
		claimId: number;
		projectId: number;
		slug: string;
		title: string;
		artistName: string;
		code: string;
		kind: 'original' | 'reissue';
		codeStatus: 'claimed' | 'reported';
		claimedAt: string;
		reissuedAt: string | null;
	};
	error?: string;
}

async function postClaim(body: unknown, jar?: CookieJar) {
	// The route handler's generated RouteId type doesn't match the hand-rolled
	// event; collapse to one callable shape (same discipline as fan-auth tests).
	const handler = fanClaimHandler as unknown as (event: RequestEvent) => Promise<Response>;
	const response = await handler(makeEvent(body, jar ?? new CookieJar()));
	return [response, (await response.json().catch(() => null)) as ClaimResponse | null] as const;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
	const row = await bindings.DB.prepare(sql).bind(...params).first<{ n: number }>();
	return row?.n ?? 0;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('POST /api/fan/claim — auth', () => {
	it('refuses without a session cookie: 401, nothing dispensed', async () => {
		const project = await seedProject({ codeCount: 2 });
		const [response, body] = await postClaim({ slug: project.slug });
		expect(response.status).toBe(401);
		expect(body).toEqual({ error: 'unauthorized' });
		expect(await count("SELECT COUNT(*) AS n FROM codes WHERE status = 'claimed' AND project_id = ?1", project.projectId)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', project.projectId)).toBe(0);
	});

	it('refuses a garbage cookie identically', async () => {
		const project = await seedProject({ codeCount: 2 });
		const jar = new CookieJar();
		jar.written.set(FAN_SESSION_COOKIE, { value: 'garbage.notasignature', options: {} });
		const [response] = await postClaim({ slug: project.slug }, jar);
		expect(response.status).toBe(401);
	});
});

describe('POST /api/fan/claim — fresh claim + revisit', () => {
	it('dispenses one available code: outcome=claimed, honest pool after', async () => {
		const project = await seedProject({ codeCount: 3 });
		const fan = await seedFan();
		const [response, body] = await postClaim({ slug: project.slug }, fan.jar);
		expect(response.status).toBe(200);
		expect(body?.ok).toBe(true);
		expect(body?.outcome).toBe('claimed');
		expect(body?.reused).toBe(false);
		// The code is one of this project's, now claimed in the codes table.
		expect(project.codes).toContain(body?.claim?.code);
		expect(body?.claim).toMatchObject({
			projectId: project.projectId,
			slug: project.slug,
			kind: 'original',
			codeStatus: 'claimed',
			reissuedAt: null
		});
		expect(await count("SELECT COUNT(*) AS n FROM codes WHERE status = 'claimed' AND project_id = ?1", project.projectId)).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM codes WHERE status = 'available' AND project_id = ?1", project.projectId)).toBe(2);
	});

	it('accepts projectId as the reference too', async () => {
		const project = await seedProject({ codeCount: 2 });
		const fan = await seedFan();
		const [response, body] = await postClaim({ projectId: project.projectId }, fan.jar);
		expect(response.status).toBe(200);
		expect(project.codes).toContain(body?.claim?.code);
	});

	it('revisit / limit-hit re-shows the SAME code: outcome=revisit, no second claim', async () => {
		const project = await seedProject({ codeCount: 4 });
		const fan = await seedFan();
		const [, first] = await postClaim({ slug: project.slug }, fan.jar);
		const [second, secondBody] = await postClaim({ slug: project.slug }, fan.jar);
		expect(second.status).toBe(200);
		expect(secondBody?.outcome).toBe('revisit');
		expect(secondBody?.reused).toBe(true);
		expect(secondBody?.claim?.code).toBe(first?.claim?.code); // same code, re-shown
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', project.projectId)).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM codes WHERE status = 'claimed' AND project_id = ?1", project.projectId)).toBe(1);
	});

	it('a second fan gets a DIFFERENT code; neither response ever holds the other claim', async () => {
		const project = await seedProject({ codeCount: 2 });
		const fanA = await seedFan();
		const fanB = await seedFan();
		const [, a] = await postClaim({ slug: project.slug }, fanA.jar);
		const [, b] = await postClaim({ slug: project.slug }, fanB.jar);
		expect(a?.claim?.code).not.toBe(b?.claim?.code);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', project.projectId)).toBe(2);
		// Owner-only reads: fanClaimForProject (the SSR load's query) keys by hash.
		const aRead = await fanClaimForProject(bindings.DB, fanA.fanHash, project.slug);
		const bRead = await fanClaimForProject(bindings.DB, fanB.fanHash, project.slug);
		expect(aRead?.code).toBe(a?.claim?.code);
		expect(bRead?.code).toBe(b?.claim?.code);
		const stranger = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		expect(await fanClaimForProject(bindings.DB, stranger, project.slug)).toBeNull();
	});

	it('the last code flips the project drained while still dispensing', async () => {
		const project = await seedProject({ codeCount: 1 });
		const fan = await seedFan();
		const [response, body] = await postClaim({ slug: project.slug }, fan.jar);
		expect(response.status).toBe(200);
		expect(body?.claim?.code).toBe(project.codes[0]);
		const status = await bindings.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind(project.projectId).first<{ status: string }>();
		expect(status?.status).toBe('drained');
		// And the honest follow-on: the next fan is told drained, not strung along.
		const other = await seedFan();
		const [next, nextBody] = await postClaim({ slug: project.slug }, other.jar);
		expect(next.status).toBe(409);
		expect(nextBody).toEqual({ error: 'drained' });
	});
});

describe('POST /api/fan/claim — honest states + body grammar', () => {
	it('paused projects dispense nothing: 409 paused', async () => {
		const project = await seedProject({ codeCount: 3, status: 'paused' });
		const fan = await seedFan();
		const [response, body] = await postClaim({ slug: project.slug }, fan.jar);
		expect(response.status).toBe(409);
		expect(body).toEqual({ error: 'paused' });
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', project.projectId)).toBe(0);
	});

	it('drained projects: 409 drained', async () => {
		const project = await seedProject({ codeCount: 2, status: 'drained' });
		// At status drained nothing is 'available' even though rows exist.
		await bindings.DB
			.prepare("UPDATE codes SET status = 'claimed' WHERE project_id = ?1")
			.bind(project.projectId)
			.run();
		const fan = await seedFan();
		const [response, body] = await postClaim({ slug: project.slug }, fan.jar);
		expect(response.status).toBe(409);
		expect(body).toEqual({ error: 'drained' });
	});

	it('unknown and draft slugs are indistinguishable: 404', async () => {
		const fan = await seedFan();
		const draft = await seedProject({ codeCount: 2, status: 'draft' });
		const [unknown] = await postClaim({ slug: 'no-such-claim-slug' }, fan.jar);
		expect(unknown.status).toBe(404);
		const [draftResponse] = await postClaim({ slug: draft.slug }, fan.jar);
		expect(draftResponse.status).toBe(404);
	});

	it('rejects malformed bodies: neither, both, or wrong types', async () => {
		const project = await seedProject({ codeCount: 2 });
		const fan = await seedFan();
		for (const bad of [{}, { slug: '', projectId: project.projectId }, { slug: project.slug, projectId: project.projectId }, { projectId: 'x' }, { slug: 7 }, { projectId: 0 }, { projectId: -1 }]) {
			const [response, body] = await postClaim(bad, fan.jar);
			expect(response.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_request' });
		}
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', project.projectId)).toBe(0);
	});
});

describe('POST /api/fan/claim — session sliding-window recipe', () => {
	it('re-sets the cookie when the session passed its half-life', async () => {
		const project = await seedProject({ codeCount: 2 });
		const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const identity = await ensureFanIdentity({ db: bindings.DB, fanHash, now: new Date() });
		// Short-issue so the endpoint's read (default 180d TTL) is already past
		// half-life: remaining (~100s) < 180d/2 → slide + refreshed=true.
		const issued = await issueFanSession({ db: bindings.DB, fanId: identity.fanId, secret: SESSION_SECRET, now: new Date() }, 100);
		const jar = new CookieJar();
		jar.written.set(FAN_SESSION_COOKIE, { value: issued.cookieValue, options: {} });
		const [response, body] = await postClaim({ slug: project.slug }, jar);
		expect(response.status).toBe(200);
		expect(body?.ok).toBe(true);
		// The recipe re-set the cookie (same value, fresh maxAge)…
		const reset = jar.written.get(FAN_SESSION_COOKIE);
		expect(reset?.value).toBe(issued.cookieValue);
		expect(reset?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
		// …and the server row was slid forward to ~now + 180d.
		const row = await bindings.DB.prepare('SELECT expires_at FROM fan_sessions WHERE fan_id = ?1 ORDER BY id DESC LIMIT 1')
			.bind(identity.fanId)
			.first<{ expires_at: string }>();
		const slidMs = Date.parse(`${row!.expires_at.replace(' ', 'T')}Z`);
		const nowText = toSqlUtc(new Date());
		expect(slidMs - Date.parse(`${nowText.replace(' ', 'T')}Z`)).toBeGreaterThan(100 * 24 * 60 * 60);
	});
});

describe('fanClaimForProject — the SSR revisit read', () => {
	it('resolves by slug AND by id, and shapes the slab payload', async () => {
		const project = await seedProject({ codeCount: 2 });
		const fan = await seedFan();
		await postClaim({ slug: project.slug }, fan.jar);
		const bySlug = await fanClaimForProject(bindings.DB, fan.fanHash, project.slug);
		const byId = await fanClaimForProject(bindings.DB, fan.fanHash, project.projectId);
		expect(bySlug).not.toBeNull();
		expect(byId?.code).toBe(bySlug?.code);
		expect(Object.keys(bySlug!).sort()).toEqual(
			[
				'artistName',
				'claimId',
				'claimedAt',
				'code',
				'codeId',
				'codeStatus',
				'kind',
				'projectId',
				'reissuedAt',
				'slug',
				'title'
			].sort()
		);
	});

	it('returns null for a fan with no claim on the project', async () => {
		const project = await seedProject({ codeCount: 1 });
		const other = await seedProject({ codeCount: 1 });
		const fan = await seedFan();
		await postClaim({ slug: project.slug }, fan.jar);
		expect(await fanClaimForProject(bindings.DB, fan.fanHash, other.slug)).toBeNull();
	});
});
