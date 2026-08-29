/**
 * /my-codes route load tests (FE4) — the archive page's LOAD against the real
 * D1 binding (vitest inside workerd; migrations applied by tests/setup.ts),
 * driven by a hand-rolled load event (console-routes.test.ts pattern). The
 * query helper (listFanClaims) is already pinned row-by-row in fan-auth and
 * report suites; THIS file pins the route contract on top of it:
 *
 *   - no session / garbage cookie / expired session → the entry state
 *     (fanHasSession: false, claims: null) — and other fans' claims never
 *     leak into an anonymous visit;
 *   - session → exactly the session fan's claims across multiple projects,
 *     newest first, with the render fields (slug, artist/title, code, yum
 *     base, artwork tri-state) and no fan_hash in the payload;
 *   - session with zero claims → claims: [] (the honest empty state's basis);
 *   - honest statuses through the route: one reissued claim (BE6) renders
 *     kind='reissue' + the CURRENT code, a drained report stays
 *     reported/original, another fan's claims on the same project are absent.
 *
 * Storage persists across test files (fresh emails/slugs per test).
 */

import { env as bindings } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Cookies, ServerLoadEvent } from '@sveltejs/kit';
import * as myCodes from '../src/routes/my-codes/+page.server';
import { ensureFanIdentity, hashFanEmail } from '../src/lib/server/fan-identity';
import { FAN_SESSION_COOKIE, issueFanSession } from '../src/lib/server/fan-session';
import { dispenseCode } from '../src/lib/server/dispense';
import { reportClaim } from '../src/lib/server/report';
import { toSqlUtc } from '../src/lib/server/time';

const SESSION_SECRET = 'test-session-secret';
const EMAIL_PEPPER = 'test-email-pepper';

/** Records cookie reads/writes (the load only reads). */
class CookieJar {
	written = new Map<string, { value: string; options: Record<string, unknown> }>();

	get cookies(): Cookies {
		const jar = this;
		return {
			get: (name: string) => jar.written.get(name)?.value,
			set: (name: string, value: string, options: Record<string, unknown>) => {
				jar.written.set(name, { value, options });
			},
			delete: (name: string) => {
				jar.written.delete(name);
			}
		} as unknown as Cookies;
	}
}

function makeLoadEvent(jar?: CookieJar): ServerLoadEvent {
	return {
		url: new URL('http://app.test/my-codes'),
		params: {},
		cookies: (jar ?? new CookieJar()).cookies,
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
	} as unknown as ServerLoadEvent;
}

/** Typed loads demand their exact route's event shape; tests hand-roll one
 *  generic event — the established loose-handler pattern (console-routes.test.ts). */
type AnyLoad = (event: ServerLoadEvent) => Promise<unknown>;
const loadMyCodes = myCodes.load as unknown as AnyLoad;

let seq = 0;
const uniqueEmail = () => `fe4-fan-${++seq}@example.test`;

/** A fan identity + live session cookie, without the OTP detour (covered elsewhere). */
	async function seedFan(): Promise<{ jar: CookieJar; fanHash: string }> {
		const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const identity = await ensureFanIdentity({ db: bindings.DB, fanHash, now: new Date() });
		const issued = await issueFanSession({ db: bindings.DB, fanId: identity.fanId, secret: SESSION_SECRET, now: new Date() });
		const jar = new CookieJar();
		jar.written.set(FAN_SESSION_COOKIE, { value: issued.cookieValue, options: {} });
		return { jar, fanHash };
	}

interface SeededProject {
	projectId: number;
	slug: string;
	title: string;
	artistName: string;
	yumUrl: string;
}

/** Artist + active project + one available code, via direct SQL. */
async function seedProject(): Promise<SeededProject> {
	const n = ++seq;
	const db = bindings.DB;
	const artistId = (await db.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id').bind(`fe4-artist-${n}@example.test`).first<{ id: number }>())!.id;
	const slug = `fe4-drop-${n}`;
	const title = `FE4 Album ${n}`;
	const artistName = `FE4 Artist ${n}`;
	const yumUrl = `https://fe4${n}.bandcamp.com/yum`;
	const projectId = (await db
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active') RETURNING id`
		)
		.bind(artistId, title, artistName, `https://fe4${n}.bandcamp.com/album/a-${n}`, slug, yumUrl)
		.first<{ id: number }>())!.id;
	const batchId = (await db.prepare('INSERT INTO code_batches (project_id, filename, code_count) VALUES (?1, ?2, 1) RETURNING id')
		.bind(projectId, `${slug}.csv`)
		.first<{ id: number }>())!.id;
	await db
		.prepare('INSERT INTO codes (project_id, batch_id, code) VALUES (?1, ?2, ?3)')
		.bind(projectId, batchId, `fe4${String(n % 1000).padStart(3, '0')}-${String(n).padStart(4, '0')}`)
		.run();
	return { projectId, slug, title, artistName, yumUrl };
}

/** SeedProject with several codes (report→reissue needs a spare in the pool). */
async function seedProjectWithSpares(spares: number): Promise<SeededProject> {
	const project = await seedProject();
	for (let i = 0; i < spares; i++) {
		await bindings.DB
			.prepare('INSERT INTO codes (project_id, batch_id, code) VALUES (?1, (SELECT id FROM code_batches WHERE project_id = ?1 LIMIT 1), ?2)')
			.bind(project.projectId, `spare-${project.projectId}-${i}`)
			.run();
	}
	return project;
}

interface ClaimView {
	claimId: number;
	projectId: number;
	slug: string;
	title: string;
	artistName: string;
	yumUrl: string;
	code: string;
	kind: 'original' | 'reissue';
	codeStatus: 'claimed' | 'reported';
	claimedAt: string;
	reissuedAt: string | null;
}

interface MyCodesData {
	fanHasSession: boolean;
	claims: ClaimView[] | null;
}

/** Unwrap a dispense result; the returned claim's own type carries its fields. */
function expectDispenseOk(result: Awaited<ReturnType<typeof dispenseCode>>) {
	if (!result.ok) throw new Error(`dispense failed: ${JSON.stringify(result)}`);
	return result.claim;
}

describe('/my-codes load (FE4)', () => {
	it('no session → the entry state, with other fans’ claims never leaking in', async () => {
		// A claimed project exists — an anonymous visit still sees no codes.
		const project = await seedProjectWithSpares(0);
		const otherHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		expectDispenseOk(await dispenseCode({ db: bindings.DB, project: project.slug, fanHash: otherHash, now: new Date() }));

		const data = (await loadMyCodes(makeLoadEvent())) as MyCodesData;
		expect(data).toEqual({ fanHasSession: false, claims: null });
	});

	it('a garbage cookie and an expired session read as signed-out', async () => {
		const garbage = new CookieJar();
		garbage.written.set(FAN_SESSION_COOKIE, { value: 'garbage.notasignature', options: {} });
		expect(await loadMyCodes(makeLoadEvent(garbage))).toEqual({ fanHasSession: false, claims: null });

		// Expired: issued with a negative TTL, so the server row is already past.
		const fanHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const identity = await ensureFanIdentity({ db: bindings.DB, fanHash, now: new Date() });
		const expired = await issueFanSession({ db: bindings.DB, fanId: identity.fanId, secret: SESSION_SECRET, now: new Date() }, -60);
		const jar = new CookieJar();
		jar.written.set(FAN_SESSION_COOKIE, { value: expired.cookieValue, options: {} });
		expect(await loadMyCodes(makeLoadEvent(jar))).toEqual({ fanHasSession: false, claims: null });
	});

	it('session → exactly this fan’s claims across projects, newest first, render fields intact', async () => {
		const { jar, fanHash } = await seedFan();
		const a = await seedProjectWithSpares(1); // two fans claim A: one code each, never shared
		const b = await seedProject();
		const t1 = new Date('2026-09-01T12:00:00Z');
		const t2 = new Date('2026-09-02T12:00:00Z');
		const claimA = expectDispenseOk(await dispenseCode({ db: bindings.DB, project: a.slug, fanHash, now: t1 }));
		const claimB = expectDispenseOk(await dispenseCode({ db: bindings.DB, project: b.slug, fanHash, now: t2 }));

		// Another fan claims A too — their code must never appear in this archive.
		const otherHash = await hashFanEmail(uniqueEmail(), EMAIL_PEPPER);
		const otherClaim = expectDispenseOk(await dispenseCode({ db: bindings.DB, project: a.slug, fanHash: otherHash, now: t2 }));

		const data = (await loadMyCodes(makeLoadEvent(jar))) as MyCodesData;
		expect(data.fanHasSession).toBe(true);
		expect(data.claims?.map((c) => c.claimId)).toEqual([claimB.claimId, claimA.claimId]); // newest first
		expect(data.claims?.[0]).toMatchObject({
			projectId: b.projectId,
			slug: b.slug,
			title: b.title,
			artistName: b.artistName,
			yumUrl: b.yumUrl,
			code: claimB.code,
			kind: 'original',
			codeStatus: 'claimed',
			claimedAt: toSqlUtc(t2),
			reissuedAt: null
		});
		const codes = data.claims?.map((c) => c.code) ?? [];
		expect(codes).not.toContain(otherClaim.code);
		// The payload never carries the fan hash (or anyone's).
		expect(JSON.stringify(data)).not.toContain(fanHash);
		expect(JSON.stringify(data)).not.toContain(otherHash);
	});

	it('session with zero claims → the honest empty list', async () => {
		const { jar } = await seedFan();
		const data = (await loadMyCodes(makeLoadEvent(jar))) as MyCodesData;
		expect(data).toEqual({ fanHasSession: true, claims: [] });
	});

	it('statuses stay honest through the route: one reissue shows the CURRENT code; a drained report stays dead', async () => {
		const { jar, fanHash } = await seedFan();
		const withSpare = await seedProjectWithSpares(1); // report → reissue succeeds
		const singleCode = await seedProjectWithSpares(0); // report → reissue_drained
		const t1 = new Date('2026-09-01T12:00:00Z');
		const later = new Date('2026-09-03T12:00:00Z');

		const original = expectDispenseOk(await dispenseCode({ db: bindings.DB, project: withSpare.slug, fanHash, now: t1 }));
		const doomed = expectDispenseOk(await dispenseCode({ db: bindings.DB, project: singleCode.slug, fanHash, now: t1 }));

		const report = await reportClaim({ db: bindings.DB, fanHash, project: withSpare.projectId, reason: 'already redeemed', now: later });
		expect(report.ok && report.outcome).toBe('reissued');
		const drained = await reportClaim({ db: bindings.DB, fanHash, project: singleCode.projectId, reason: 'already redeemed', now: later });
		expect(drained.ok && drained.outcome).toBe('reissue-drained');

		const data = (await loadMyCodes(makeLoadEvent(jar))) as MyCodesData;
		expect(data.claims).toHaveLength(2);
		const reissued = data.claims!.find((c) => c.slug === withSpare.slug)!;
		const dead = data.claims!.find((c) => c.slug === singleCode.slug)!;
		// Reissued: the replacement code is the one shown, history dated.
		expect(reissued.kind).toBe('reissue');
		expect(reissued.codeStatus).toBe('claimed');
		expect(reissued.code).not.toBe(original.code);
		expect(reissued.reissuedAt).toBe(toSqlUtc(later));
		// Drained report: the dead original is kept, honestly.
		expect(dead.kind).toBe('original');
		expect(dead.codeStatus).toBe('reported');
		expect(dead.code).toBe(doomed.code);
		expect(dead.reissuedAt).toBeNull();
	});
});
