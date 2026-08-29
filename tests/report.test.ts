/**
 * Report + reissue tests (BE6) — the dead-code flow against the real D1
 * binding (vitest inside workerd; migrations applied by tests/setup.ts):
 *
 *   1. OWNER-ONLY: a fan with no claim on the project (never claimed, or
 *      claimed a DIFFERENT project) gets typed `no-claim` and writes nothing.
 *   2. FIRST REPORT: dead code flips to 'reported' (artist-visible), the SAME
 *      claims row is re-pointed to a fresh atomically-dispensed code, the
 *      fan holds exactly ONE live code afterwards, the report row carries
 *      reason/timestamp/claim_id — and the reported code is never
 *      re-dispensed to anyone (codes.status excludes it from BE5's pick).
 *   3. DRAINED REISSUE: pool empty at report time → `reissue-drained`: report
 *      recorded, NO new code, claim honestly unchanged — and still no
 *      further reissue even after the artist refills the pool.
 *   4. ALREADY-REISSUED: a second report returns the current claim state and
 *      consumes nothing (one reports row, availability unchanged).
 *   5. RACE: concurrent double-reports collapse to exactly one reissue + one
 *      report row (reports.claim_id UNIQUE + whole-batch rollback).
 *   6. ARTIST VISIBILITY: projectReports() count + reported-codes list.
 *   7. ENDPOINT: POST /api/fan/report auth/body/outcome mapping.
 *
 * Storage persists across tests in a file, so slugs and fan hashes are
 * unique per seed (mirrors tests/dispense.test.ts).
 */

import { env } from 'cloudflare:test';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { dispenseCode, projectAvailability, type DispenseResult } from '../src/lib/server/dispense';
import { ensureFanIdentity, listFanClaims } from '../src/lib/server/fan-identity';
import { FAN_SESSION_COOKIE, issueFanSession } from '../src/lib/server/fan-session';
import { projectReports, reportClaim, type ReportResult } from '../src/lib/server/report';
import { POST as fanReportHandler } from '../src/routes/api/fan/report/+server';
import { toSqlUtc } from '../src/lib/server/time';

const NOW = new Date('2026-08-28T12:00:00Z');
const LATER = new Date('2026-08-28T14:30:00Z');
const SESSION_SECRET = 'test-session-secret';

/** Throws on a non-ok outcome so assertions can focus on the payload. */
function expectDispenseOk(result: DispenseResult): Extract<DispenseResult, { ok: true }> {
	if (!result.ok) throw new Error(`expected a dispense, got: ${JSON.stringify(result)}`);
	return result;
}

function expectReportOk(result: ReportResult): Extract<ReportResult, { ok: true }> {
	if (!result.ok) throw new Error(`expected a report ok, got: ${JSON.stringify(result)}`);
	return result;
}

/** ok outcomes that carry a reportedCode (everything but already-reissued). */
function expectReportReplaced(
	result: ReportResult
): Extract<ReportResult, { ok: true; outcome: 'reissued' | 'reissue-drained' }> {
	if (!result.ok || result.outcome === 'already-reissued') {
		throw new Error(`expected a replacement-bearing report, got: ${JSON.stringify(result)}`);
	}
	return result;
}

let seq = 0;

/** Artist + project + batch + N codes, via direct SQL (no engine under test). */
async function seedProject(opts: { codeCount: number; status?: string; slug?: string }) {
	const n = ++seq;
	const slug = opts.slug ?? `report-proj-${n}`;
	const db = env.DB;
	const artistId = (await db.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id').bind(`report-artist-${n}@example.test`).first<{ id: number }>())!.id;
	const projectId = (await db
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`
		)
		.bind(artistId, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/album-${n}`, slug, `https://artist${n}.bandcamp.com/yum`, opts.status ?? 'active')
		.first<{ id: number }>())!.id;
	const batchId = (await db
		.prepare('INSERT INTO code_batches (project_id, filename, code_count) VALUES (?1, ?2, ?3) RETURNING id')
		.bind(projectId, `${slug}.csv`, opts.codeCount)
		.first<{ id: number }>())!.id;
	const prefix = `r${String(n % 1000).padStart(3, '0')}`;
	const codes = Array.from({ length: opts.codeCount }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
	for (let i = 0; i < codes.length; i += 30) {
		const chunk = codes.slice(i, i + 30);
		const values = chunk.map((_, j) => `(?${j * 3 + 1}, ?${j * 3 + 2}, ?${j * 3 + 3})`).join(', ');
		await db.prepare(`INSERT INTO codes (project_id, batch_id, code) VALUES ${values}`)
			.bind(...chunk.flatMap((code) => [projectId, batchId, code]))
			.run();
	}
	return { projectId, slug, batchId, codes };
}

/** COUNT(*) AS n as a number (0 for no rows). */
async function count(sql: string, ...params: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql).bind(...params).first<{ n: number }>();
	return row?.n ?? 0;
}

/** Reports rows for one project (scoped: projects are unique per seed). */
async function reportCount(projectId: number): Promise<number> {
	return count(
		'SELECT COUNT(*) AS n FROM reports r JOIN claims cl ON cl.id = r.claim_id WHERE cl.project_id = ?1',
		projectId
	);
}

async function codeRow(codeId: number) {
	return env.DB
		.prepare('SELECT code, status, claimed_at, reported_at FROM codes WHERE id = ?1')
		.bind(codeId)
		.first<{ code: string; status: string; claimed_at: string | null; reported_at: string | null }>();
}

describe('report — owner-only enforcement', () => {
	it('a fan with no claim on the project cannot report it: typed no-claim, zero side effects', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const owner = `report-owner-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash: owner, now: NOW }));

		const intruder = `report-intruder-${projectId}`;
		const result = await reportClaim({ db: env.DB, fanHash: intruder, project: projectId, reason: 'dead', now: LATER });
		expect(result).toEqual({ ok: false, reason: 'no-claim' });

		// Zero side effects: no report, the owner's claim untouched, code still live.
		expect(await reportCount(projectId)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, owner)).toBe(1);
		expect((await codeRow(held.claim.codeId))!.status).toBe('claimed');
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 5, available: 4, claimed: 1, reported: 0 });
	});

	it('a fan claimed on a DIFFERENT project cannot report this one (per-project keying)', async () => {
		const first = await seedProject({ codeCount: 3 });
		const second = await seedProject({ codeCount: 3 });
		const fanHash = `report-cross-${second.projectId}`;
		expectDispenseOk(await dispenseCode({ db: env.DB, project: first.projectId, fanHash, now: NOW }));

		expect(await reportClaim({ db: env.DB, fanHash, project: second.projectId, now: LATER })).toEqual({
			ok: false,
			reason: 'no-claim'
		});
		expect(await reportCount(second.projectId)).toBe(0);
		expect(await reportCount(first.projectId)).toBe(0);
	});

	it('rejects an empty fan hash loudly instead of reporting (wiring-bug guard)', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		await expect(reportClaim({ db: env.DB, fanHash: '', project: projectId, now: LATER })).rejects.toThrow(TypeError);
	});

	it('unknown or draft project: not-found (unpublished is invisible)', async () => {
		expect(await reportClaim({ db: env.DB, fanHash: 'report-ghost', project: 'no-such-report-slug', now: LATER })).toEqual({
			ok: false,
			reason: 'not-found'
		});
		const draft = await seedProject({ codeCount: 5, status: 'draft' });
		expect(await reportClaim({ db: env.DB, fanHash: 'report-ghost-2', project: draft.projectId, now: LATER })).toEqual({
			ok: false,
			reason: 'not-found'
		});
	});
});

describe('report — first report re-points the SAME claim to a fresh code', () => {
	it('dead code marked reported, claim re-pointed, exactly ONE live code held, report row written', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `report-first-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		const deadCode = held.claim.code;

		const report = expectReportReplaced(
			await reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'already redeemed', now: LATER }
			)
		);
		expect(report.outcome).toBe('reissued');
		expect(report.reportedCode).toBe(deadCode);

		// The SAME claims row was re-pointed (never a second claim).
		expect(report.claim.claimId).toBe(held.claim.claimId);
		expect(report.claim.code).not.toBe(deadCode);
		expect(report.claim.kind).toBe('reissue');
		expect(report.claim.codeStatus).toBe('claimed');
		expect(report.claim.reissuedAt).toBe(toSqlUtc(LATER));

		// Dead code row: artist-visible reported + timestamp.
		expect(await codeRow(held.claim.codeId)).toEqual({
			code: deadCode,
			status: 'reported',
			claimed_at: toSqlUtc(NOW),
			reported_at: toSqlUtc(LATER)
		});
		// Replacement row: claimed by THIS batch.
		const replacement = await codeRow(report.claim.codeId);
		expect(replacement!.status).toBe('claimed');
		expect(replacement!.claimed_at).toBe(toSqlUtc(LATER));
		expect(replacement!.reported_at).toBeNull();

		// Exactly one claims row for (project, fan), pointing at the replacement.
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		expect(
			await count('SELECT COUNT(*) AS n FROM claims WHERE id = ?1 AND code_id = ?2', report.claim.claimId, report.claim.codeId)
		).toBe(1);

		// Reports row: claim_id + dead code_id + reason + timestamp.
		const reportRow = await env.DB
			.prepare('SELECT claim_id, code_id, reason, created_at FROM reports WHERE claim_id = ?1')
			.bind(report.claim.claimId)
			.first<{ claim_id: number; code_id: number; reason: string | null; created_at: string }>();
		expect(reportRow).toEqual({
			claim_id: report.claim.claimId,
			code_id: held.claim.codeId,
			reason: 'already redeemed',
			created_at: toSqlUtc(LATER)
		});

		// Availability: original became reported, replacement claimed, 3 still available.
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 5, available: 3, claimed: 1, reported: 1 });

		// FE4's read: the fan holds exactly ONE live code (no second live code anywhere).
		const claims = await listFanClaims(env.DB, fanHash);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({
			claimId: report.claim.claimId,
			code: report.claim.code,
			kind: 'reissue',
			codeStatus: 'claimed',
			reissuedAt: toSqlUtc(LATER)
		});
	});

	it('reason is optional: omitted and empty reasons land as NULL', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `report-noreason-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));

		const report = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, now: LATER }));
		expect(report.outcome).toBe('reissued');
		const row = await env.DB
			.prepare('SELECT reason FROM reports WHERE claim_id = ?1')
			.bind(report.claim.claimId)
			.first<{ reason: string | null }>();
		expect(row!.reason).toBeNull();
	});

	it('the reported code is never re-dispensed to anyone (codes.status excludes it from the pick)', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanA = `report-noredispense-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash: fanA, now: NOW }));
		const deadCode = held.claim.code;
		const report = expectReportOk(
			await reportClaim({ db: env.DB, fanHash: fanA, project: projectId, reason: 'dead', now: LATER })
		);
		expect(report.outcome).toBe('reissued');

		// Drain the remaining pool with other fans — none may receive the dead
		// code (or the fan's replacement).
		const others = Array.from({ length: 3 }, (_, i) => `report-drainer-${projectId}-${i}`);
		const dispensed = await Promise.all(
			others.map((fanHash) => dispenseCode({ db: env.DB, project: projectId, fanHash, now: LATER }))
		);
		expect(dispensed.every((r) => r.ok)).toBe(true);
		const codes = dispensed.map((r) => expectDispenseOk(r).claim.code);
		expect(new Set(codes).size).toBe(3); // distinct codes
		expect(codes).not.toContain(deadCode); // never the reported code
		expect(codes).not.toContain(report.claim.code); // never someone else's live code

		// Pool exhausted; a fifth fan gets the typed drained outcome.
		const fifth = await dispenseCode({ db: env.DB, project: projectId, fanHash: `report-fifth-${projectId}`, now: LATER });
		expect(fifth).toEqual({ ok: false, reason: 'drained' });

		// Final ledger: 1 reported (the dead one), 4 claimed, 0 available.
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 5, available: 0, claimed: 4, reported: 1 });
		expect((await codeRow(held.claim.codeId))!.status).toBe('reported');
	});
});

describe('report — reissue when the pool is empty', () => {
	it('reissue-drained: report recorded, NO new code, claim honestly unchanged, project flipped drained', async () => {
		const { projectId } = await seedProject({ codeCount: 1 });
		const fanHash = `report-drained-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		// BE5 already auto-flipped the project drained (pool of one, now empty).

		const report = expectReportReplaced(await reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'dead', now: LATER }));
		expect(report.outcome).toBe('reissue-drained');
		expect(report.reportedCode).toBe(held.claim.code);

		// Honest claim state: SAME code, kind still original, no reissue stamp.
		expect(report.claim.claimId).toBe(held.claim.claimId);
		expect(report.claim.codeId).toBe(held.claim.codeId);
		expect(report.claim.code).toBe(held.claim.code);
		expect(report.claim.kind).toBe('original');
		expect(report.claim.reissuedAt).toBeNull();
		expect(report.claim.codeStatus).toBe('reported');

		// The report itself WAS recorded (artist-visible) and the code marked dead.
		expect(await reportCount(projectId)).toBe(1);
		expect((await codeRow(held.claim.codeId))!.status).toBe('reported');
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 1, available: 0, claimed: 0, reported: 1 });

		// FE4 read agrees: one claim, reported status, never reissued.
		const claims = await listFanClaims(env.DB, fanHash);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ codeStatus: 'reported', kind: 'original', reissuedAt: null });
	});

	it('after a drained report, no further reissue — even once the artist refills the pool', async () => {
		const { projectId, batchId } = await seedProject({ codeCount: 1 });
		const fanHash = `report-refill-${projectId}`;
		expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		const first = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, now: LATER }));
		expect(first.outcome).toBe('reissue-drained');

		// Artist refills (BE7's upload lane, direct SQL here).
		await env.DB
			.prepare('INSERT INTO codes (project_id, batch_id, code) VALUES (?1, ?2, ?3)')
			.bind(projectId, batchId, 'refil-0001')
			.run();

		const second = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, now: LATER }));
		expect(second.outcome).toBe('already-reissued');
		// The refilled code stays available — the budget was spent by report #1.
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 2, available: 1, claimed: 0, reported: 1 });
		expect(await reportCount(projectId)).toBe(1);
	});
});

describe('report — second report after a reissue', () => {
	it('already-reissued returns the current claim state and consumes nothing', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `report-second-${projectId}`;
		expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		const first = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'dead', now: LATER }));
		expect(first.outcome).toBe('reissued');
		const afterFirst = await projectAvailability(env.DB, projectId);

		const second = expectReportOk(
			await reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'also dead', now: new Date(LATER.getTime() + 60_000) })
		);
		expect(second.outcome).toBe('already-reissued');
		expect(second.claim.claimId).toBe(first.claim.claimId);
		expect(second.claim.code).toBe(first.claim.code); // the current (replacement) code
		expect(second.claim.kind).toBe('reissue');
		expect(second.claim.codeStatus).toBe('claimed');

		// Nothing further was written or dispensed.
		expect(await reportCount(projectId)).toBe(1);
		expect(await projectAvailability(env.DB, projectId)).toEqual(afterFirst);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
	});
});

describe('report — concurrent double-report race', () => {
	it('8 concurrent reports: exactly one reissue, one report row, one claim row (UNIQUE + batch rollback)', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `report-racer-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));

		const racers = await Promise.all(
			Array.from({ length: 8 }, () => reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'dead', now: LATER }))
		);

		const reissued = racers.filter((r) => r.ok && r.outcome === 'reissued');
		const already = racers.filter((r) => r.ok && r.outcome === 'already-reissued');
		expect(reissued).toHaveLength(1);
		expect(already).toHaveLength(7);
		expect(reissued[0]!.claim.code).not.toBe(held.claim.code);

		// Exactly one reports row; the claim is a single reissued row.
		expect(await reportCount(projectId)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		expect(
			await count(`SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2 AND kind = 'reissue'`, projectId, fanHash)
		).toBe(1);

		// Original reported + exactly one replacement claimed; 3 codes untouched.
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 5, available: 3, claimed: 1, reported: 1 });
	});
});

describe('report — artist visibility helper', () => {
	it('projectReports: count + reported-codes list per project (reissued and drained variants)', async () => {
		const reissued = await seedProject({ codeCount: 5, slug: 'reports-reissued-proj' });
		const fanA = `report-artist-a-${reissued.projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: reissued.projectId, fanHash: fanA, now: NOW }));
		const reportA = expectReportOk(
			await reportClaim({ db: env.DB, fanHash: fanA, project: reissued.projectId, reason: 'already used', now: LATER })
		);
		expect(reportA.outcome).toBe('reissued');

		const view = await projectReports(env.DB, reissued.projectId);
		expect(view!.projectId).toBe(reissued.projectId);
		expect(view!.reportCount).toBe(1);
		expect(view!.reports).toHaveLength(1);
		expect(view!.reports[0]).toMatchObject({
			claimId: held.claim.claimId,
			codeId: held.claim.codeId,
			code: held.claim.code,
			reason: 'already used',
			reportedAt: toSqlUtc(LATER),
			reissued: true,
			reissuedAt: toSqlUtc(LATER)
		});

		// Slug resolution + the drained variant (reissued=false, reissuedAt=null).
		const drained = await seedProject({ codeCount: 1, slug: 'reports-drained-proj' });
		const fanB = `report-artist-b-${drained.projectId}`;
		const heldB = expectDispenseOk(await dispenseCode({ db: env.DB, project: drained.projectId, fanHash: fanB, now: NOW }));
		const reportB = expectReportOk(await reportClaim({ db: env.DB, fanHash: fanB, project: drained.projectId, now: LATER }));
		expect(reportB.outcome).toBe('reissue-drained');

		const drainedView = await projectReports(env.DB, 'reports-drained-proj');
		expect(drainedView!.reportCount).toBe(1);
		expect(drainedView!.reports[0]).toMatchObject({
			code: heldB.claim.code,
			reason: null,
			reissued: false,
			reissuedAt: null
		});

		// A project with no reports: honest empty list; missing project: null.
		const quiet = await seedProject({ codeCount: 2 });
		expect(await projectReports(env.DB, quiet.projectId)).toEqual({ projectId: quiet.projectId, reportCount: 0, reports: [] });
		expect(await projectReports(env.DB, 'no-such-reports-slug')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Endpoint: POST /api/fan/report (real +server.ts handler).
// ---------------------------------------------------------------------------

/** Records cookie writes so a session cookie can be planted (fan-auth harness). */
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

function makeEvent(path: string, body: unknown, jar: CookieJar): RequestEvent {
	return {
		request: new Request(`http://app.test${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL(`http://app.test${path}`),
		cookies: jar.cookies,
		getClientAddress: () => '203.0.113.99',
		platform: {
			env: {
				DB: env.DB,
				ART: null,
				SESSION_SECRET,
				EMAIL_PEPPER: 'test-email-pepper',
				OTP_PEPPER: 'test-otp-pepper',
				MAILER_DRIVER: 'console'
			}
		}
	} as unknown as RequestEvent;
}

/** POST with a REAL fan session cookie for fanHash (BE4 machinery). */
async function postAsFan(path: string, body: unknown, fanHash: string) {
	const identity = await ensureFanIdentity({ db: env.DB, fanHash, now: NOW });
	const session = await issueFanSession({ db: env.DB, fanId: identity.fanId, secret: SESSION_SECRET, now: NOW });
	const jar = new CookieJar();
	jar.cookies.set(FAN_SESSION_COOKIE, session.cookieValue, { path: '/' });
	const response = await (fanReportHandler as unknown as (event: RequestEvent) => Promise<Response>)(makeEvent(path, body, jar));
	return [response, ((await response.json().catch(() => null)) as unknown)] as const;
}

describe('report — POST /api/fan/report', () => {
	it('no session cookie: 401, nothing written', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const response = await (fanReportHandler as unknown as (event: RequestEvent) => Promise<Response>)(
			makeEvent('/api/fan/report', { projectId }, new CookieJar())
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'unauthorized' });
		expect(await reportCount(projectId)).toBe(0);
	});

	it('invalid bodies: 400 (no project ref, both refs, wrong types)', async () => {
		const fanHash = 'report-endpoint-400';
		for (const body of [{}, { projectId: 'five', slug: 'x' }, { projectId: 5, slug: 'x' }, { note: 'hi' }]) {
			const [response, parsed] = await postAsFan('/api/fan/report', body, fanHash);
			expect(response.status).toBe(400);
			expect(parsed).toEqual({ error: 'invalid_request' });
		}
	});

	it('happy path by slug: reissued outcome with the replacement, dead code, and no internal metadata', async () => {
		const { projectId, slug } = await seedProject({ codeCount: 5 });
		const fanHash = `report-endpoint-happy-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));

		const [response, parsed] = await postAsFan('/api/fan/report', { slug, note: 'already redeemed' }, fanHash);
		expect(response.status).toBe(200);
		const body = parsed as { ok: boolean; outcome: string; reportedCode: string; claim: Record<string, unknown> };
		expect(body.ok).toBe(true);
		expect(body.outcome).toBe('reissued');
		expect(body.reportedCode).toBe(held.claim.code);
		expect(body.claim['code']).not.toBe(held.claim.code);
		expect(body.claim['kind']).toBe('reissue');
		expect(body.claim['codeStatus']).toBe('claimed');
		expect(typeof body.claim['reissuedAt']).toBe('string');
		// Internal metadata (ip_hash/source/fan identity) never crosses the wire.
		expect('ipHash' in body.claim).toBe(false);
		expect('source' in body.claim).toBe(false);
		expect(JSON.stringify(body)).not.toContain(fanHash);
		expect(await reportCount(projectId)).toBe(1);
	});

	it('fan without a claim: 409 no_claim; unknown project: 404; second report: 200 already_reissued', async () => {
		const { projectId, slug } = await seedProject({ codeCount: 5 });
		const fanHash = `report-endpoint-states-${projectId}`;
		expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));

		const stranger = `report-endpoint-stranger-${projectId}`;
		const [noClaimRes, noClaimBody] = await postAsFan('/api/fan/report', { projectId }, stranger);
		expect(noClaimRes.status).toBe(409);
		expect(noClaimBody).toEqual({ error: 'no_claim' });

		const [notFoundRes, notFoundBody] = await postAsFan('/api/fan/report', { slug: 'ghost-report-slug' }, fanHash);
		expect(notFoundRes.status).toBe(404);
		expect(notFoundBody).toEqual({ error: 'not_found' });

		const [firstRes, firstBody] = await postAsFan('/api/fan/report', { slug }, fanHash);
		expect(firstRes.status).toBe(200);
		expect((firstBody as { outcome: string }).outcome).toBe('reissued');

		// Second report — by projectId this time: the current claim re-shows.
		const [secondRes, secondBody] = await postAsFan('/api/fan/report', { projectId }, fanHash);
		expect(secondRes.status).toBe(200);
		const parsed = secondBody as { outcome: string; claim: { code: string; codeStatus: string } };
		expect(parsed.outcome).toBe('already_reissued');
		expect(parsed.claim.code).toBe((firstBody as { claim: { code: string } }).claim.code);
		expect(parsed.claim.codeStatus).toBe('claimed');
		expect(await reportCount(projectId)).toBe(1);
	});
});
