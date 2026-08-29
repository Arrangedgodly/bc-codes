/**
 * Dispense engine tests (BE5) — the three hard invariants against the real D1
 * binding (vitest inside workerd; migrations applied by tests/setup.ts):
 *
 *   1. CONCURRENT: N parallel claims on a smaller pool → exactly pool-size
 *      unique dispenses, the rest typed `drained`, ZERO duplicate code
 *      strings, zero double-claims (this is QA1's canonical burst, sized
 *      50-on-30 per plan.md's M1 slice of it).
 *   2. ONE-PER-FAN: the same fan — sequential AND fully concurrent — always
 *      gets the same code back and holds exactly one claims row, including
 *      when the winner's commit EMPTIES the pool (V-BE5 regression: the
 *      loser's INSERT…SELECT is a silent no-op, and only the batch's own
 *      code-UPDATE RETURNING may label the response fresh).
 *   3. NO-DISPENSE STATES: paused / drained (by status AND by empty pool) /
 *      missing / draft projects dispense nothing, with typed outcomes.
 *
 * Plus claim metadata (claimed_at/ip_hash/source), the drained auto-flip,
 * availability counting, and the revisit-after-pause re-show.
 *
 * Storage persists across tests in a file (see tests/otp.test.ts), so every
 * project slug and fan hash here is unique per test.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dispenseCode, hashIp, projectAvailability, type DispenseResult } from '../src/lib/server/dispense';
import { hmacHex } from '../src/lib/server/crypto';
import { toSqlUtc } from '../src/lib/server/time';

const NOW = new Date('2026-08-28T12:00:00Z');

/** Throws on a non-ok outcome so assertions can focus on the payload. */
function expectOk(result: DispenseResult): Extract<DispenseResult, { ok: true }> {
	if (!result.ok) throw new Error(`expected a dispense, got: ${JSON.stringify(result)}`);
	return result;
}

let seq = 0;

/** Artist + project + batch + N codes, via direct SQL (no engine under test). */
async function seedProject(opts: { codeCount: number; status?: string; slug?: string }) {
	const n = ++seq;
	const slug = opts.slug ?? `proj-${n}`;
	const db = env.DB;
	const artistId = (await db.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id').bind(`artist-${n}@example.test`).first<{ id: number }>())!.id;
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
	// Unique 4-4 codes derived from the per-seed counter (dddd-dddd shape).
	const prefix = `t${String(n % 1000).padStart(3, '0')}`;
	const codes = Array.from({ length: opts.codeCount }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
	// Chunked multi-row inserts stay under D1's 100 bound-params per statement.
	for (let i = 0; i < codes.length; i += 30) {
		const chunk = codes.slice(i, i + 30);
		const values = chunk.map((_, j) => `(?${j * 3 + 1}, ?${j * 3 + 2}, ?${j * 3 + 3})`).join(', ');
		await db.prepare(`INSERT INTO codes (project_id, batch_id, code) VALUES ${values}`)
			.bind(...chunk.flatMap((code) => [projectId, batchId, code]))
			.run();
	}
	return { projectId, slug, codes };
}

/** COUNT(*) AS n as a number (0 for no rows). */
async function count(sql: string, ...params: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql).bind(...params).first<{ n: number }>();
	return row?.n ?? 0;
}

async function projectStatus(projectId: number): Promise<string> {
	return (await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind(projectId).first<{ status: string }>())!.status;
}

describe('dispense — invariant 1: concurrent claims never double-dispense', () => {
	it('50 fans race 30 codes: exactly 30 unique dispenses, 20 typed drained, zero dupes', async () => {
		const { projectId, codes } = await seedProject({ codeCount: 30 });
		const fans = Array.from({ length: 50 }, (_, i) => `fan-${projectId}-${i}`);

		const results = await Promise.all(fans.map((fanHash) => dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW })));

		const dispensed = results.filter((r): r is Extract<DispenseResult, { ok: true }> => r.ok);
		const refused = results.filter((r): r is Extract<DispenseResult, { ok: false }> => !r.ok);
		expect(dispensed).toHaveLength(30);
		expect(refused).toHaveLength(20);
		// Every refusal is the typed drained outcome — nothing else leaked out.
		expect(refused.every((r) => r.reason === 'drained')).toBe(true);
		expect(dispensed.every((r) => r.reused === false)).toBe(true);

		// ZERO duplicate code strings — and they are exactly the seeded pool.
		const dispensedCodes = dispensed.map((r) => r.claim.code);
		expect(new Set(dispensedCodes).size).toBe(30);
		expect([...new Set(dispensedCodes)].sort()).toEqual([...codes].sort());

		// DB audit: 30 claims, no code referenced by two claims, pool fully consumed.
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', projectId)).toBe(30);
		expect(
			await count(
				'SELECT COUNT(*) AS n FROM (SELECT code_id FROM claims WHERE project_id = ?1 GROUP BY code_id HAVING COUNT(*) > 1)',
				projectId
			)
		).toBe(0);
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 30, available: 0, claimed: 30, reported: 0 });
		// The drained auto-flip fired atomically with the last dispense.
		expect(await projectStatus(projectId)).toBe('drained');
	});
});

describe('dispense — invariant 2: one code per project per fan', () => {
	it('same fan twice (by slug, then by id): same code, one claims row, second is reused', async () => {
		const { projectId, slug, codes } = await seedProject({ codeCount: 5 });
		const fanHash = `fan-returning-${projectId}`;

		const first = expectOk(await dispenseCode({ db: env.DB, project: slug, fanHash, now: NOW }));
		const second = expectOk(
			await dispenseCode({ db: env.DB, project: projectId, fanHash, now: new Date(NOW.getTime() + 3_600_000) })
		);

		expect(codes).toContain(first.claim.code);
		expect(second.claim.code).toBe(first.claim.code); // same code re-shown
		expect(second.claim.claimId).toBe(first.claim.claimId);
		expect(second.reused).toBe(true);
		expect(first.reused).toBe(false);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		// The revisit dispensed nothing extra: exactly one code consumed.
		expect((await projectAvailability(env.DB, projectId))!.available).toBe(4);
	});

	it('same fan, 10 fully concurrent tabs: one dispense, every tab re-shown the same code', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `fan-racer-${projectId}`;

		const racers = await Promise.all(
			Array.from({ length: 10 }, () => dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }))
		);

		expect(racers.every((r) => r.ok)).toBe(true);
		const codes = racers.map((r) => expectOk(r).claim.code);
		expect(new Set(codes).size).toBe(1); // one code, ten tabs
		// Exactly one winner (fresh dispense); the other nine re-read the
		// winner's claim — via the UNIQUE-violation rollback path or the
		// pre-read, both of which return reused=true.
		expect(racers.filter((r) => expectOk(r).reused === false)).toHaveLength(1);

		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		expect((await projectAvailability(env.DB, projectId))!.available).toBe(4); // exactly one code consumed
		// One identity row backs the FK no matter how many tabs raced.
		expect(await count('SELECT COUNT(*) AS n FROM fan_identities WHERE email_hash = ?1', fanHash)).toBe(1);
	});

	it('V-BE5 regression: same fan races a pool the winner empties — losers honestly reused, never phantom-fresh', async () => {
		// When the winner's commit takes the LAST code, each loser's claim
		// INSERT…SELECT has nothing to pick: a silent no-op, NOT a UNIQUE
		// violation — so the loser's read-back returns the WINNER's claim.
		// Under the V-BE5 bug that path reported reused=false (a fresh
		// dispense that never happened); freshness must come from what the
		// batch itself wrote (the code-UPDATE's RETURNING), which is exactly
		// what this test pins down.
		const POOL = 1;
		const { projectId } = await seedProject({ codeCount: POOL });
		const fanHash = `fan-exhaust-${projectId}`;

		const racers = await Promise.all(
			Array.from({ length: 10 }, () => dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }))
		);

		// Every tab leaves with the single code; every non-winner says reused.
		expect(racers.every((r) => r.ok)).toBe(true);
		const oks = racers.map(expectOk);
		expect(new Set(oks.map((r) => r.claim.code)).size).toBe(1);
		const fresh = oks.filter((r) => r.reused === false);
		const reused = oks.filter((r) => r.reused === true);
		expect(fresh).toHaveLength(1); // exactly one tab dispensed
		expect(reused).toHaveLength(9); // the other nine re-show the winner's claim
		expect(fresh.length).toBeLessThanOrEqual(POOL); // fresh dispenses can never exceed the pool

		// DB audit: exactly 1 claims row for the fan, the pool fully consumed
		// by that one dispense, no second code, one identity row.
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 1, available: 0, claimed: 1, reported: 0 });
		expect(await projectStatus(projectId)).toBe('drained');
		expect(await count('SELECT COUNT(*) AS n FROM fan_identities WHERE email_hash = ?1', fanHash)).toBe(1);
	});
});

describe('dispense — invariant 3: paused/drained/missing dispense nothing', () => {
	it('paused project: typed paused outcome, zero dispense', async () => {
		const { projectId } = await seedProject({ codeCount: 5, status: 'paused' });
		const result = await dispenseCode({ db: env.DB, project: projectId, fanHash: `fan-paused-${projectId}`, now: NOW });
		expect(result).toEqual({ ok: false, reason: 'paused' });
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', projectId)).toBe(0);
		expect((await projectAvailability(env.DB, projectId))!.available).toBe(5);
	});

	it('drained by status AND drained by empty pool: typed drained outcome, zero dispense', async () => {
		const byStatus = await seedProject({ codeCount: 5, status: 'drained' });
		expect(await dispenseCode({ db: env.DB, project: byStatus.projectId, fanHash: 'fan-drained-status', now: NOW })).toEqual({ ok: false, reason: 'drained' });

		const byPool = await seedProject({ codeCount: 0, status: 'active' });
		expect(await dispenseCode({ db: env.DB, project: byPool.projectId, fanHash: 'fan-drained-pool', now: NOW })).toEqual({ ok: false, reason: 'drained' });

		for (const projectId of [byStatus.projectId, byPool.projectId]) {
			expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', projectId)).toBe(0);
		}
	});

	it('nonexistent project (slug or id) and draft project: not-found, zero dispense', async () => {
		expect(await dispenseCode({ db: env.DB, project: 'no-such-slug', fanHash: 'fan-ghost', now: NOW })).toEqual({ ok: false, reason: 'not-found' });
		expect(await dispenseCode({ db: env.DB, project: 99_999_999, fanHash: 'fan-ghost', now: NOW })).toEqual({ ok: false, reason: 'not-found' });

		const draft = await seedProject({ codeCount: 5, status: 'draft' });
		expect(await dispenseCode({ db: env.DB, project: draft.slug, fanHash: 'fan-draft', now: NOW })).toEqual({ ok: false, reason: 'not-found' });
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', draft.projectId)).toBe(0);
	});

	it('revisit after pause still re-shows the held code (the claim outlives the state change)', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `fan-holdout-${projectId}`;
		const first = expectOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));

		await env.DB.prepare(`UPDATE projects SET status = 'paused' WHERE id = ?1`).bind(projectId).run();
		const revisit = expectOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));

		expect(revisit.claim.code).toBe(first.claim.code);
		expect(revisit.reused).toBe(true);
		// Pausing did not free or consume anything.
		expect((await projectAvailability(env.DB, projectId))!.available).toBe(4);
	});
});

describe('dispense — claim metadata + helpers', () => {
	it('records claimed_at/ip_hash/source; omitted metadata lands as NULL', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const ipHash = await hashIp('203.0.113.7', 'test-email-pepper');
		expect(ipHash).toBe(await hmacHex('203.0.113.7', 'test-email-pepper')); // documented EMAIL_PEPPER reuse

		const result = expectOk(
			await dispenseCode({ db: env.DB, project: projectId, fanHash: `fan-meta-${projectId}`, ipHash, source: 'web', now: NOW })
		);
		expect(result.claim.kind).toBe('original');
		expect(result.claim.claimedAt).toBe(toSqlUtc(NOW));
		expect(result.claim.ipHash).toBe(ipHash);
		expect(result.claim.source).toBe('web');

		const row = await env.DB.prepare('SELECT ip_hash, source FROM claims WHERE id = ?1')
			.bind(result.claim.claimId)
			.first<{ ip_hash: string | null; source: string | null }>();
		expect(row).toEqual({ ip_hash: ipHash, source: 'web' });
		// The dispensed code row itself carries claimed_at (artist-facing audit).
		const codeRow = await env.DB.prepare('SELECT claimed_at FROM codes WHERE id = ?1')
			.bind(result.claim.codeId)
			.first<{ claimed_at: string | null }>();
		expect(codeRow!.claimed_at).toBe(toSqlUtc(NOW));

		// No ip/source passed -> NULLs, not empty strings.
		const bare = await seedProject({ codeCount: 5 });
		const bareResult = expectOk(await dispenseCode({ db: env.DB, project: bare.projectId, fanHash: `fan-bare-${bare.projectId}`, now: NOW }));
		expect(bareResult.claim.ipHash).toBeNull();
		expect(bareResult.claim.source).toBeNull();
	});

	it('projectAvailability counts every status, resolves slug and id, null for missing', async () => {
		const { projectId, slug } = await seedProject({ codeCount: 4 });
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 4, available: 4, claimed: 0, reported: 0 });
		expect(await projectAvailability(env.DB, slug)).toEqual({ total: 4, available: 4, claimed: 0, reported: 0 });

		await dispenseCode({ db: env.DB, project: projectId, fanHash: `fan-avail-${projectId}`, now: NOW });
		await env.DB
			.prepare(`UPDATE codes SET status = 'reported', reported_at = ?2 WHERE project_id = ?1 AND status = 'available'`)
			.bind(projectId, toSqlUtc(NOW))
			.run();

		// 1 claimed by the fan; the other 3 marked reported directly (BE6 lane).
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 4, available: 0, claimed: 1, reported: 3 });
		expect(await projectAvailability(env.DB, 'missing-slug-xyz')).toBeNull();
	});

	it('rejects an empty fan hash loudly instead of dispensing (wiring-bug guard)', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		await expect(dispenseCode({ db: env.DB, project: projectId, fanHash: '', now: NOW })).rejects.toThrow(TypeError);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', projectId)).toBe(0);
	});
});
