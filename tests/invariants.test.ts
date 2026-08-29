/**
 * QA1 — the independent invariant suite (plan.md QA1 / town-hall "Hard
 * invariants"). This file asserts the CONTRACT at system level; it does not
 * re-run the unit suites (dispense/report/otp/fan-auth/artist-auth — 185
 * tests) but exercises the engines together, at production spike scale,
 * with internal repetition and seeded variability so race windows are
 * actually crossed rather than lucked into.
 *
 * Invariant → test traceability:
 *
 * | Invariant (town-hall)                     | Tests below                                     |
 * |-------------------------------------------|-------------------------------------------------|
 * | 1. A code is never dispensed twice, even  | "canonical 250-on-200 burst",                   |
 * |    under simultaneous claims              | "burst interleaved with pause mid-flight",      |
 * |                                          | "burst with a same-fan duplicate storm"          |
 * | 2. A verified email cannot exceed 1 code  | "claim → report → reissue lifecycle",           |
 * |    + 1 reissue per project                | "cross-project: one email, three projects",     |
 * |                                          | "duplicate-claim storm on a reissued claim"      |
 * | 3. Paused/drained projects dispense       | "paused and drained projects refuse dispense",  |
 * |    nothing                                | "existing holders keep their right", plus the   |
 * |                                          | two INTENDED-SEMANTICS pins (see below)          |
 * | OTP rate-limit matrix (plan QA1 row)      | "full refusal ladder on the injected clock",    |
 * |                                          | "endpoint smoke: cooldown + per-IP + lockout"    |
 *
 * Flagged items from earlier tasks, resolved here as EXPLICIT tests:
 *
 * - BE6's pause-bypass reissue (V-BE6 accepted deviation 2) — pinned by
 *   "INTENDED SEMANTICS: pause does not freeze an existing holder's reissue".
 * - Drained-report-consumes-budget (V-BE6 accepted deviation 1) — pinned by
 *   "INTENDED SEMANTICS: a drained-pool report consumes the one-reissue
 *   budget" (report recorded, no replacement, budget spent even after a
 *   refill).
 * - BE3's rate-limit injectability ("overridable per call for QA1") — pinned
 *   by the ladder test driving every refusal class off an injected `now` +
 *   injected `limits` (the endpoints themselves are real-clock by design;
 *   they are smoke-tested at their own level).
 *
 * R1 follow-up (re-run the burst against a persistent local D1): NOT
 * FEASIBLE with the current harness, measured 2026-08-28 —
 * @cloudflare/vitest-plugin 1.1.2 hardcodes the top-level Miniflare options
 * (log handlers only; source-verified in the plugin's dist
 * buildProjectMiniflareOptions) and merges user `miniflare` keys into the
 * runner WORKER options, where miniflare v4's `resourcePersistencePath` is
 * not a valid key: a probe config passing it under `miniflare:` was silently
 * ignored (no persistence directory ever created; a marker row reset to its
 * initial value on every run). Cross-file storage isolation was also
 * confirmed by probe (file B never sees file A's rows, either execution
 * order), and wrangler d1 execute cannot express the engine's single-batch
 * semantics — so platformProxy's persistent store (.wrangler/state) is
 * unreachable from the vitest harness. The production-D1 burst re-run stays
 * in OP1's smoke checklist (as plan.md QA1 already notes for the deployed
 * database; the D1 database itself does not exist until OP1 provisions it).
 *
 * Harness notes honored from the production log (T-BE2/T-BE3): the suite
 * runs via `cloudflareTest()` in vitest.config.ts (the 1.x plugin API — the
 * old defineWorkersConfig no longer exists); migrations are applied per file
 * by tests/setup.ts; D1 storage persists WITHIN a file (unique slugs/hashes
 * per test and per burst iteration here) but is isolated BETWEEN files.
 */

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { dispenseCode, projectAvailability, type DispenseResult } from '../src/lib/server/dispense';
import { listFanClaims } from '../src/lib/server/fan-identity';
import { reportClaim, type ReportResult } from '../src/lib/server/report';
import { requestOtp, verifyOtp, type OtpLimits } from '../src/lib/server/otp';
import type { Mailer, OtpMessage } from '../src/lib/server/mailer';
import { POST as fanRequestOtpHandler } from '../src/routes/api/fan/request-otp/+server';
import { POST as fanVerifyOtpHandler } from '../src/routes/api/fan/verify-otp/+server';

const NOW = new Date('2026-08-28T12:00:00Z');
const SESSION_SECRET = 'test-session-secret';
const EMAIL_PEPPER = 'test-email-pepper';
const OTP_PEPPER = 'test-otp-pepper';

// ---------------------------------------------------------------------------
// Harness: seeding, counting, seeded variability.
// ---------------------------------------------------------------------------

let seq = 0;

/** Artist + project + batch + N codes, via direct SQL (no engine under test). */
async function seedProject(opts: { codeCount: number; status?: string }) {
	const n = ++seq;
	const slug = `qa1-proj-${n}`;
	const db = env.DB;
	const artistId = (await db
		.prepare('INSERT INTO artists (email) VALUES (?1) RETURNING id')
		.bind(`qa1-artist-${n}@example.test`)
		.first<{ id: number }>())!.id;
	const projectId = (await db
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`
		)
		.bind(artistId, `QA1 Album ${n}`, `QA1 Artist ${n}`, `https://qa1artist${n}.bandcamp.com/album/x`, slug, `https://qa1artist${n}.bandcamp.com/yum`, opts.status ?? 'active')
		.first<{ id: number }>())!.id;
	const batchId = (await db
		.prepare('INSERT INTO code_batches (project_id, filename, code_count) VALUES (?1, ?2, ?3) RETURNING id')
		.bind(projectId, `${slug}.csv`, opts.codeCount)
		.first<{ id: number }>())!.id;
	// Globally-unique dddd-dddd codes derived from the seed counter.
	const prefix = `q${String(n % 1000).padStart(3, '0')}`;
	const codes = Array.from({ length: opts.codeCount }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
	for (let i = 0; i < codes.length; i += 30) {
		const chunk = codes.slice(i, i + 30);
		const values = chunk.map((_, j) => `(?${j * 3 + 1}, ?${j * 3 + 2}, ?${j * 3 + 3})`).join(', ');
		await db
			.prepare(`INSERT INTO codes (project_id, batch_id, code) VALUES ${values}`)
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

async function projectStatus(projectId: number): Promise<string> {
	return (await env.DB.prepare('SELECT status FROM projects WHERE id = ?1').bind(projectId).first<{ status: string }>())!.status;
}

/**
 * The post-burst ledger audit shared by every invariant-1 scenario: zero
 * orphan codes (claimed without a claim row), zero orphan claims (a claim row
 * whose held code is not 'claimed'), zero claim rows without their
 * fan_identities FK row, zero code_ids referenced by two claims, zero
 * duplicate dispensed code strings at the DB level. (Identity-row COUNTS are
 * deliberately NOT audited: a typed-drained refusal short-circuits before
 * the batch, so whether a losing fan ever got an identity row is interleaving
 * — the invariant is that every CLAIM has one.)
 */
async function auditLedger(projectId: number) {
	const orphanCodes = await count(
		`SELECT COUNT(*) AS n FROM codes cd
		 WHERE cd.project_id = ?1 AND cd.status = 'claimed'
		   AND NOT EXISTS (SELECT 1 FROM claims cl WHERE cl.code_id = cd.id)`,
		projectId
	);
	const orphanClaims = await count(
		`SELECT COUNT(*) AS n FROM claims cl JOIN codes cd ON cd.id = cl.code_id
		 WHERE cl.project_id = ?1 AND cd.status <> 'claimed'`,
		projectId
	);
	const orphanClaimIdentities = await count(
		`SELECT COUNT(*) AS n FROM claims cl
		 WHERE cl.project_id = ?1
		   AND NOT EXISTS (SELECT 1 FROM fan_identities fi WHERE fi.email_hash = cl.fan_hash)`,
		projectId
	);
	const dupCodeRefs = await count(
		`SELECT COUNT(*) AS n FROM (SELECT code_id FROM claims WHERE project_id = ?1 GROUP BY code_id HAVING COUNT(*) > 1)`,
		projectId
	);
	const dupCodeStrings = await count(
		`SELECT COUNT(*) AS n FROM (SELECT cd.code FROM claims cl JOIN codes cd ON cd.id = cl.code_id
		 WHERE cl.project_id = ?1 GROUP BY cd.code HAVING COUNT(*) > 1)`,
		projectId
	);
	return { orphanCodes, orphanClaims, orphanClaimIdentities, dupCodeRefs, dupCodeStrings };
}

/** Throws on a non-ok outcome so assertions can focus on the payload. */
function expectDispenseOk(result: DispenseResult): Extract<DispenseResult, { ok: true }> {
	if (!result.ok) throw new Error(`expected a dispense, got: ${JSON.stringify(result)}`);
	return result;
}

/** Throws on a failed report so assertions can focus on the outcome. */
function expectReportOk(result: ReportResult): Extract<ReportResult, { ok: true }> {
	if (!result.ok) throw new Error(`expected a report ok, got: ${JSON.stringify(result)}`);
	return result;
}

/** Throws unless the report outcome carries a reportedCode (everything but already-reissued). */
function expectReportReplaced(
	result: ReportResult
): Extract<ReportResult, { ok: true; outcome: 'reissued' | 'reissue-drained' }> {
	if (!result.ok || result.outcome === 'already-reissued') {
		throw new Error(`expected a replacement-bearing report, got: ${JSON.stringify(result)}`);
	}
	return result;
}

// --- Seeded variability (mulberry32): every race test draws its shuffles,
// staggers and pause offsets from a seeded PRNG and prints the seed, so a
// failure names the exact interleaving family that broke. The per-run root
// seed mixes Date.now() so the 5-consecutive-run gate explores different
// interleavings across runs; each internal iteration keeps drawing from the
// same stream, so its shuffles differ iteration-to-iteration.

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ROOT_SEED = (0x51a1 ^ Date.now()) >>> 0;
let raceTestIndex = 0;

function seededRng(): () => number {
	const seed = (ROOT_SEED + ++raceTestIndex * 0x9e3779b9) >>> 0;
	console.log(`qa1 race seed: 0x${seed.toString(16)} (root 0x${ROOT_SEED.toString(16)})`);
	return mulberry32(seed);
}

/** In-place Fisher-Yates off the seeded PRNG. */
function shuffle<T>(items: T[], rng: () => number): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[items[i], items[j]] = [items[j]!, items[i]!];
	}
	return items;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fire N concurrent claims with seeded per-racer start offsets (0..staggerMs)
 * so the burst genuinely interleaves rather than racing from one synchronous
 * tick. Promise.all preserves input order, so results[i] belongs to fans[i].
 */
async function burstClaims(fans: string[], projectId: number, rng: () => number, staggerMs = 4): Promise<DispenseResult[]> {
	const racers = fans.map((fanHash) => {
		const offset = Math.floor(rng() * (staggerMs + 1));
		const attempt = () => dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW });
		return offset > 0 ? delay(offset).then(attempt) : attempt();
	});
	return Promise.all(racers);
}

/** The production-scale shape: R1's spike — 250 concurrent claims on 200 codes. */
const BURST_FANS = 250;
const BURST_CODES = 200;
/** Every race scenario repeats internally (plan QA1 flake-hardening). */
const ITERATIONS = 3;

// ---------------------------------------------------------------------------
// Invariant 1 — a code is never dispensed twice, even under simultaneous
// claims (production-scale burst, R1's 250-on-200 spike scale).
// ---------------------------------------------------------------------------

describe('QA1 invariant 1 — no double dispense under the production-scale burst', () => {
	it(`canonical burst: ${BURST_FANS} concurrent claims on ${BURST_CODES} codes, x${ITERATIONS} seeded iterations`, async () => {
		const rng = seededRng();
		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			const tag = `i${iteration}`;
			const { projectId, codes } = await seedProject({ codeCount: BURST_CODES });
			const fans = shuffle(
				Array.from({ length: BURST_FANS }, (_, i) => `qa1-burst-${tag}-${projectId}-${i}`),
				rng
			);

			const results = await burstClaims(fans, projectId, rng);

			const dispensed = results.filter((r): r is Extract<DispenseResult, { ok: true }> => r.ok);
			const refused = results.filter((r): r is Extract<DispenseResult, { ok: false }> => !r.ok);
			expect(dispensed.length, `${tag}: ok outcomes`).toBe(BURST_CODES);
			expect(refused.length, `${tag}: refusals`).toBe(BURST_FANS - BURST_CODES);
			// Every refusal is the typed drained outcome — nothing else leaked.
			expect(refused.every((r) => r.reason === 'drained'), `${tag}: typed drained refusals`).toBe(true);
			expect(dispensed.every((r) => r.reused === false), `${tag}: distinct fans are never re-shows`).toBe(true);

			// Exactly 200 unique code strings — and they ARE the seeded pool.
			const dispensedCodes = dispensed.map((r) => r.claim.code);
			expect(new Set(dispensedCodes).size, `${tag}: zero duplicate dispensed strings`).toBe(BURST_CODES);
			expect([...new Set(dispensedCodes)].sort(), `${tag}: dispensed set equals the pool`).toEqual([...codes].sort());

			// DB ledger: one claims row per dispense, zero orphans either way.
			expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', projectId)).toBe(BURST_CODES);
			expect(await auditLedger(projectId), `${tag}: ledger audit`).toEqual({
				orphanCodes: 0,
				orphanClaims: 0,
				orphanClaimIdentities: 0,
				dupCodeRefs: 0,
				dupCodeStrings: 0
			});

			expect(await projectAvailability(env.DB, projectId)).toEqual({ total: BURST_CODES, available: 0, claimed: BURST_CODES, reported: 0 });
			expect(await projectStatus(projectId)).toBe('drained');
		}
	});

	it(`burst interleaved with pause mid-flight, x${ITERATIONS} seeded iterations: typed outcomes only, ledger exact`, async () => {
		const rng = seededRng();
		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			const tag = `i${iteration}`;
			const { projectId } = await seedProject({ codeCount: BURST_CODES });
			const fans = shuffle(
				Array.from({ length: BURST_FANS }, (_, i) => `qa1-pause-${tag}-${projectId}-${i}`),
				rng
			);

			// The pause commits at a seeded offset inside the burst window —
			// some racers' pre-checks and batches land before it, some after.
			const pauseAfterMs = 1 + Math.floor(rng() * 12);
			const paused = delay(pauseAfterMs).then(() =>
				env.DB.prepare(`UPDATE projects SET status = 'paused' WHERE id = ?1`).bind(projectId).run()
			);
			const [results] = await Promise.all([burstClaims(fans, projectId, rng), paused]);

			// No lying outcomes: every response is a dispense or a typed refusal.
			const dispensed = results.filter((r): r is Extract<DispenseResult, { ok: true }> => r.ok);
			const refused = results.filter((r): r is Extract<DispenseResult, { ok: false }> => !r.ok);
			expect(refused.every((r) => r.reason === 'paused' || r.reason === 'drained'), `${tag}: typed refusals only`).toBe(true);
			expect(dispensed.every((r) => r.reused === false), `${tag}: distinct fans are never re-shows`).toBe(true);

			// Zero duplicate strings across ALL responses; claims rows match the
			// dispenses exactly; zero orphans either way.
			const dispensedCodes = dispensed.map((r) => r.claim.code);
			expect(new Set(dispensedCodes).size, `${tag}: zero duplicate dispensed strings`).toBe(dispensed.length);
			expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', projectId)).toBe(dispensed.length);
			expect(await auditLedger(projectId), `${tag}: ledger audit`).toEqual({
				orphanCodes: 0,
				orphanClaims: 0,
				orphanClaimIdentities: 0,
				dupCodeRefs: 0,
				dupCodeStrings: 0
			});

			// Availability consumed exactly by the dispenses; final status is
			// paused (the pause won) or drained (the pool emptied before it).
			const availability = await projectAvailability(env.DB, projectId);
			expect(availability!.total).toBe(BURST_CODES);
			expect(availability!.claimed).toBe(dispensed.length);
			expect(availability!.available).toBe(BURST_CODES - dispensed.length);
			const status = await projectStatus(projectId);
			expect(['paused', 'drained'], `${tag}: final status`).toContain(status);
			if (status === 'drained') {
				expect(dispensed.length).toBe(BURST_CODES);
				expect(refused.every((r) => r.reason === 'drained')).toBe(true);
			}

			// After the pause has committed, a fresh fan is typed-paused — but a
			// pre-pause holder still re-shows (existing-holder right).
			expect(await dispenseCode({ db: env.DB, project: projectId, fanHash: `qa1-post-pause-${tag}-${projectId}`, now: NOW })).toEqual({
				ok: false,
				reason: 'paused'
			});
			if (dispensed.length > 0) {
				const holder = dispensed[0]!;
				const fanIndex = results.indexOf(holder);
				const revisit = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash: fans[fanIndex]!, now: NOW }));
				expect(revisit.reused).toBe(true);
				expect(revisit.claim.code).toBe(holder.claim.code);
			}
		}
	});

	it(`burst with a same-fan duplicate storm woven in, x${ITERATIONS} seeded iterations: one code per fan, ever`, async () => {
		const rng = seededRng();
		const DISTINCT_FANS = 220;
		const STORM_FANS = 10;
		const STORM_TABS_EACH = 3; // 10 fans x 3 extra tabs = 30 duplicate entries
		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			const tag = `i${iteration}`;
			const { projectId } = await seedProject({ codeCount: BURST_CODES });
			const distinct = Array.from({ length: DISTINCT_FANS }, (_, i) => `qa1-storm-${tag}-${projectId}-${i}`);
			const stormFans = shuffle([...distinct], rng).slice(0, STORM_FANS);
			const population = shuffle(
				[...distinct, ...stormFans.flatMap((fan) => Array.from({ length: STORM_TABS_EACH }, () => fan))],
				rng
			);
			expect(population.length).toBe(BURST_FANS);

			const results = await burstClaims(population, projectId, rng);

			// Group every response by fan (results[i] belongs to population[i]).
			const grouped = new Map<string, DispenseResult[]>();
			population.forEach((fan, i) => {
				const list = grouped.get(fan) ?? [];
				list.push(results[i]!);
				grouped.set(fan, list);
			});

			for (const [fan, entries] of grouped) {
				const oks = entries.filter((r) => r.ok);
				const refuses = entries.filter((r) => !r.ok);
				// No mixed outcomes: a fan is either a holder (all re-shows after
				// the win) or fully drained — never both "has code" and "drained".
				expect(oks.length === 0 || refuses.length === 0, `${tag}: fan ${fan} not mixed`).toBe(true);
				for (const refused of refuses) expect(refused.reason).toBe('drained');
				if (oks.length === 0) continue;
				// A fan NEVER sees two codes: every ok is the same code on the
				// same claim row.
				expect(new Set(oks.map((r) => expectDispenseOk(r).claim.code)).size, `${tag}: fan ${fan} holds one code`).toBe(1);
				for (const ok of oks) expect(expectDispenseOk(ok).claim.claimId).toBe(expectDispenseOk(oks[0]!).claim.claimId);
			}

			// The pool always drains fully under excess demand, exactly once per
			// code: 200 fresh dispenses, 200 unique strings.
			const fresh = [...grouped.values()].flat().filter((r) => r.ok && expectDispenseOk(r).reused === false);
			expect(fresh.length, `${tag}: exactly one fresh dispense per code`).toBe(BURST_CODES);
			expect(new Set(fresh.map((r) => expectDispenseOk(r).claim.code)).size, `${tag}: 200 unique dispensed strings`).toBe(BURST_CODES);

			expect(await auditLedger(projectId), `${tag}: ledger audit`).toEqual({
				orphanCodes: 0,
				orphanClaims: 0,
				orphanClaimIdentities: 0,
				dupCodeRefs: 0,
				dupCodeStrings: 0
			});
			expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', projectId)).toBe(BURST_CODES);
			expect(await projectAvailability(env.DB, projectId)).toEqual({ total: BURST_CODES, available: 0, claimed: BURST_CODES, reported: 0 });
			expect(await projectStatus(projectId)).toBe('drained');
		}
	});
});

// ---------------------------------------------------------------------------
// Invariant 2 — a verified email cannot exceed 1 code + 1 reissue per project.
// ---------------------------------------------------------------------------

describe('QA1 invariant 2 — 1 code + 1 reissue per email per project', () => {
	it('claim → report → reissue lifecycle: exactly one live code; second report refused; new claim re-shows the SAME claim', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `qa1-life-${projectId}`;

		const first = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		const deadCode = first.claim.code;

		const report = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'dead', now: NOW }));
		expect(report.outcome).toBe('reissued');
		const replacement = report.claim.code;
		expect(replacement).not.toBe(deadCode);

		// The fan holds EXACTLY one live code — one claims row, its code claimed.
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		const claims = await listFanClaims(env.DB, fanHash);
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ code: replacement, kind: 'reissue', codeStatus: 'claimed' });
		// ...and exactly one LIVE (claimable-state) code row keyed to this fan.
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM claims cl JOIN codes cd ON cd.id = cl.code_id
				 WHERE cl.fan_hash = ?1 AND cd.status = 'claimed'`,
				fanHash
			)
		).toBe(1);

		// Second report: refused (already-reissued), consumes nothing.
		const second = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, now: NOW }));
		expect(second.outcome).toBe('already-reissued');
		expect(second.claim.code).toBe(replacement);
		expect(await count('SELECT COUNT(*) AS n FROM reports r JOIN claims cl ON cl.id = r.claim_id WHERE cl.project_id = ?1', projectId)).toBe(1);
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 5, available: 3, claimed: 1, reported: 1 });

		// New claim attempt: the SAME claim is re-shown (never a second code).
		const revisit = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		expect(revisit.reused).toBe(true);
		expect(revisit.claim.claimId).toBe(first.claim.claimId);
		expect(revisit.claim.code).toBe(replacement);
		expect(revisit.claim.kind).toBe('reissue');
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 5, available: 3, claimed: 1, reported: 1 });
	});

	it('cross-project: one email claims from three projects → three codes total (per-project limit, not global)', async () => {
		const first = await seedProject({ codeCount: 3 });
		const second = await seedProject({ codeCount: 3 });
		const third = await seedProject({ codeCount: 3 });
		const projects = [first, second, third];
		const fanHash = `qa1-cross-${first.projectId}`;

		const codes: string[] = [];
		for (const project of projects) {
			const result = expectDispenseOk(await dispenseCode({ db: env.DB, project: project.projectId, fanHash, now: NOW }));
			codes.push(result.claim.code);
		}
		expect(new Set(codes).size).toBe(3); // one code per project, all distinct
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE fan_hash = ?1', fanHash)).toBe(3);
		const claims = await listFanClaims(env.DB, fanHash);
		expect(claims).toHaveLength(3);
		expect(new Set(claims.map((c) => c.slug)).size).toBe(3);

		// A per-project re-claim re-shows only that project's code — the other
		// two claims are untouched.
		const revisit = expectDispenseOk(await dispenseCode({ db: env.DB, project: first.projectId, fanHash, now: NOW }));
		expect(revisit.reused).toBe(true);
		expect(revisit.claim.code).toBe(codes[0]);
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE fan_hash = ?1', fanHash)).toBe(3);

		// The reissue budget is per project too: reporting on the first project
		// reissues ONLY there; the others keep their original claims.
		const report = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: first.projectId, now: NOW }));
		expect(report.outcome).toBe('reissued');
		const after = await listFanClaims(env.DB, fanHash);
		expect(after).toHaveLength(3);
		expect(after.filter((c) => c.kind === 'reissue')).toHaveLength(1);
		expect(after.find((c) => c.slug === first.slug)).toMatchObject({ kind: 'reissue', codeStatus: 'claimed' });
		for (const other of [second, third]) {
			expect(after.find((c) => c.slug === other.slug)).toMatchObject({ kind: 'original', codeStatus: 'claimed' });
			expect((await projectAvailability(env.DB, other.projectId))!.claimed).toBe(1);
		}
		expect((await projectAvailability(env.DB, first.projectId))!.reported).toBe(1);
	});

	it('duplicate-claim storm on a reissued claim: every tab re-shows the replacement, nothing new dispenses', async () => {
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `qa1-restorm-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		const report = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, now: NOW }));
		expect(report.outcome).toBe('reissued');
		const after = await projectAvailability(env.DB, projectId);

		const racers = await Promise.all(
			Array.from({ length: 8 }, () => dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }))
		);
		expect(racers.every((r) => r.ok)).toBe(true);
		for (const racer of racers) {
			const ok = expectDispenseOk(racer);
			expect(ok.claim.code).toBe(report.claim.code);
			expect(ok.claim.claimId).toBe(held.claim.claimId);
			expect(ok.claim.kind).toBe('reissue');
			expect(ok.reused).toBe(true);
		}
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		expect(await projectAvailability(env.DB, projectId)).toEqual(after);
	});
});

// ---------------------------------------------------------------------------
// Invariant 3 — paused/drained projects dispense nothing (while claims stay
// re-showable: the existing-holder right, BE5/BE6 semantics).
// ---------------------------------------------------------------------------

describe('QA1 invariant 3 — paused/drained dispense nothing; claims stay re-showable', () => {
	it('paused and drained projects refuse dispense with typed outcomes and zero writes', async () => {
		const paused = await seedProject({ codeCount: 5, status: 'paused' });
		expect(await dispenseCode({ db: env.DB, project: paused.projectId, fanHash: `qa1-p3-${paused.projectId}`, now: NOW })).toEqual({
			ok: false,
			reason: 'paused'
		});
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', paused.projectId)).toBe(0);
		expect((await projectAvailability(env.DB, paused.projectId))!.available).toBe(5);

		const drainedByStatus = await seedProject({ codeCount: 5, status: 'drained' });
		expect(
			await dispenseCode({ db: env.DB, project: drainedByStatus.projectId, fanHash: `qa1-d3-${drainedByStatus.projectId}`, now: NOW })
		).toEqual({ ok: false, reason: 'drained' });

		const drainedByPool = await seedProject({ codeCount: 0, status: 'active' });
		expect(
			await dispenseCode({ db: env.DB, project: drainedByPool.projectId, fanHash: `qa1-dp-${drainedByPool.projectId}`, now: NOW })
		).toEqual({ ok: false, reason: 'drained' });
		for (const project of [drainedByStatus, drainedByPool]) {
			expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1', project.projectId)).toBe(0);
		}
	});

	it('existing holders keep their right: revisit re-shows the held code after pause AND after drain', async () => {
		const paused = await seedProject({ codeCount: 5 });
		const pausedFan = `qa1-hold-p-${paused.projectId}`;
		const heldPaused = expectDispenseOk(await dispenseCode({ db: env.DB, project: paused.projectId, fanHash: pausedFan, now: NOW }));
		await env.DB.prepare(`UPDATE projects SET status = 'paused' WHERE id = ?1`).bind(paused.projectId).run();
		const revisitPaused = expectDispenseOk(await dispenseCode({ db: env.DB, project: paused.projectId, fanHash: pausedFan, now: NOW }));
		expect(revisitPaused.reused).toBe(true);
		expect(revisitPaused.claim.code).toBe(heldPaused.claim.code);
		// While paused, nobody new gets anything.
		expect(await dispenseCode({ db: env.DB, project: paused.projectId, fanHash: `qa1-new-p-${paused.projectId}`, now: NOW })).toEqual({
			ok: false,
			reason: 'paused'
		});

		// Drained by pool exhaustion: a pool-of-one drains on the first claim.
		const drained = await seedProject({ codeCount: 1 });
		const drainedFan = `qa1-hold-d-${drained.projectId}`;
		const heldDrained = expectDispenseOk(await dispenseCode({ db: env.DB, project: drained.projectId, fanHash: drainedFan, now: NOW }));
		expect(await projectStatus(drained.projectId)).toBe('drained');
		const revisitDrained = expectDispenseOk(await dispenseCode({ db: env.DB, project: drained.projectId, fanHash: drainedFan, now: NOW }));
		expect(revisitDrained.reused).toBe(true);
		expect(revisitDrained.claim.code).toBe(heldDrained.claim.code);
		expect(await dispenseCode({ db: env.DB, project: drained.projectId, fanHash: `qa1-new-d-${drained.projectId}`, now: NOW })).toEqual({
			ok: false,
			reason: 'drained'
		});
		// No extra consumption by either revisit.
		expect(await projectAvailability(env.DB, paused.projectId)).toEqual({ total: 5, available: 4, claimed: 1, reported: 0 });
		expect(await projectAvailability(env.DB, drained.projectId)).toEqual({ total: 1, available: 0, claimed: 1, reported: 0 });
	});

	it('INTENDED SEMANTICS (V-BE6 deviation 2): pause does not freeze an existing holder’s reissue — but stops all fresh distribution', async () => {
		// This test PINS the flagged BE6 decision as intended semantics, not an
		// accident: pausing stops NEW claims (invariant 3), while the one-time
		// reissue remains an existing claim-holder's right (the same reasoning
		// as BE5's revisit re-show). If this behavior is ever deliberately
		// changed (one guard in report.ts statement 3), this test moves with it.
		const { projectId } = await seedProject({ codeCount: 5 });
		const fanHash = `qa1-pause-reissue-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));

		await env.DB.prepare(`UPDATE projects SET status = 'paused' WHERE id = ?1`).bind(projectId).run();

		// Fresh distribution stays stopped while paused.
		expect(await dispenseCode({ db: env.DB, project: projectId, fanHash: `qa1-pause-new-${projectId}`, now: NOW })).toEqual({
			ok: false,
			reason: 'paused'
		});

		// The holder reports and receives their single replacement.
		const report = expectReportReplaced(await reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'dead', now: NOW }));
		expect(report.outcome).toBe('reissued');
		expect(report.reportedCode).toBe(held.claim.code);

		// ...and never a second one.
		const second = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, now: NOW }));
		expect(second.outcome).toBe('already-reissued');

		// Ledger: one claim, one report, the dead code reported, replacement
		// claimed, the rest of the pool untouched, still paused.
		expect(await count('SELECT COUNT(*) AS n FROM claims WHERE project_id = ?1 AND fan_hash = ?2', projectId, fanHash)).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM reports r JOIN claims cl ON cl.id = r.claim_id WHERE cl.project_id = ?1', projectId)).toBe(1);
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 5, available: 3, claimed: 1, reported: 1 });
		expect(await projectStatus(projectId)).toBe('paused');
	});

	it('INTENDED SEMANTICS (V-BE6 deviation 1): a drained-pool report consumes the one-reissue budget — no replacement then, none after a refill', async () => {
		// Pins the flagged BE6 decision: the REPORT itself spends the budget even
		// when the pool cannot honor it (nothing in the product could later
		// deliver an owed replacement). The claim stays honestly on the dead
		// code; a post-refill report is already-reissued forever.
		const { projectId, batchId } = await seedProject({ codeCount: 1 });
		const fanHash = `qa1-drained-budget-${projectId}`;
		const held = expectDispenseOk(await dispenseCode({ db: env.DB, project: projectId, fanHash, now: NOW }));
		expect(await projectStatus(projectId)).toBe('drained'); // pool of one, now empty

		const report = expectReportReplaced(await reportClaim({ db: env.DB, fanHash, project: projectId, reason: 'dead', now: NOW }));
		expect(report.outcome).toBe('reissue-drained');
		expect(report.reportedCode).toBe(held.claim.code);
		// Honest claim state: same dead code, never reissued.
		expect(report.claim.claimId).toBe(held.claim.claimId);
		expect(report.claim.code).toBe(held.claim.code);
		expect(report.claim.kind).toBe('original');
		expect(report.claim.reissuedAt).toBeNull();
		expect(report.claim.codeStatus).toBe('reported');
		// The report WAS recorded.
		expect(await count('SELECT COUNT(*) AS n FROM reports r JOIN claims cl ON cl.id = r.claim_id WHERE cl.project_id = ?1', projectId)).toBe(1);

		// Artist refills the pool (BE7's upload lane; direct SQL here).
		await env.DB
			.prepare('INSERT INTO codes (project_id, batch_id, code) VALUES (?1, ?2, ?3)')
			.bind(projectId, batchId, 'qa1x-9999')
			.run();

		// The budget was spent by report #1: no reissue, ever.
		const afterRefill = expectReportOk(await reportClaim({ db: env.DB, fanHash, project: projectId, now: NOW }));
		expect(afterRefill.outcome).toBe('already-reissued');
		expect(afterRefill.claim.code).toBe(held.claim.code);
		expect(afterRefill.claim.codeStatus).toBe('reported');
		// The refilled code is still available — nobody consumed it.
		expect(await projectAvailability(env.DB, projectId)).toEqual({ total: 2, available: 1, claimed: 0, reported: 1 });
	});
});

// ---------------------------------------------------------------------------
// OTP abuse matrix — the claimant funnel's rate-limit contract. Library level
// runs off the injected clock + injected limits (BE3's QA1 hook); endpoint
// level is a real-clock smoke of the wired fan endpoints.
// ---------------------------------------------------------------------------

/** Far from otp.test.ts's Aug–Oct 2026 windows (files are storage-isolated,
 *  but belt and braces) and aligned to a UTC-day + 10-minute boundary. */
const LADDER_BASE = Date.parse('2026-06-15T12:00:00Z');
let ladderRun = 0;

describe('QA1 — OTP rate-limit matrix (injectable clocks where BE3 provided them)', () => {
	it('full refusal ladder on the injected clock: cooldown → pending-exhausted → ip short → ip daily → global cap', async () => {
		ladderRun += 1;
		const tag = `qa1lib-${ladderRun}`;
		const at = (seconds: number) => new Date(LADDER_BASE + seconds * 1000);
		// Injected limits (tiny so every refusal class fires in one test — the
		// MATRIX, i.e. which control refuses first, is the contract under test).
		const limits: Partial<OtpLimits> = {
			resendCooldownSeconds: 60,
			maxSendsPerPending: 2,
			ipWindowSends: 3,
			ipDailySends: 4,
			globalDailySends: 8,
			ttlSeconds: 600
		};
		const messages: OtpMessage[] = [];
		const mailer: Mailer = {
			driver: 'console',
			async sendOtp(message) {
				messages.push(message);
			}
		};
		const send = (name: string, ip: string, now: Date) =>
			requestOtp({
				db: env.DB,
				purpose: 'fan',
				subject: `${tag}-${name}`,
				deliverTo: `${tag}-${name}@example.test`,
				pepper: OTP_PEPPER,
				mailer,
				ip,
				now,
				limits
			});
		const codeOf = (name: string) => messages.find((m) => m.to === `${tag}-${name}@example.test`)!.code;

		// 1) Cooldown: immediate same-subject resend refused, no quota consumed.
		expect((await send('a', '10.0.0.1', at(0))).ok).toBe(true);
		expect(await send('a', '10.0.0.1', at(10))).toMatchObject({ ok: false, reason: 'cooldown', retryAfterSeconds: 50 });

		// 2) Pending-exhausted: after the cooldown, one resend; the next is
		// refused until the pending expires (subject-local, pre-counter).
		expect((await send('a', '10.0.0.1', at(61))).ok).toBe(true);
		expect(await send('a', '10.0.0.1', at(130))).toMatchObject({ ok: false, reason: 'pending-exhausted' });

		// 3) Per-IP short window: three sends from one IP across subjects pass;
		// the fourth is refused (check-after-increment: the blocked attempt
		// consumes its own short-window quota).
		expect((await send('b1', '10.0.0.2', at(0))).ok).toBe(true);
		expect((await send('b2', '10.0.0.2', at(1))).ok).toBe(true);
		expect((await send('b3', '10.0.0.2', at(2))).ok).toBe(true);
		expect(await send('b4', '10.0.0.2', at(3))).toMatchObject({ ok: false, reason: 'ip-rate-limited' });

		// Early-block property (otp.ts header contract): the ip-refused attempt
		// never reached the global counter — day-1 global holds exactly the five
		// DELIVERED sends so far (a, a-resend, b1, b2, b3).
		const day1Start = new Date(Math.floor(at(0).getTime() / 86_400_000) * 86_400_000);
		const globalDay1 = await env.DB
			.prepare(`SELECT sends FROM otp_rate_counters WHERE scope = 'global1d' AND window_start = ?1`)
			.bind(day1Start.toISOString().replace('T', ' ').slice(0, 19))
			.first<{ sends: number }>();
		expect(globalDay1!.sends).toBe(5);

		// 4) Per-IP daily window: past the short window, the same IP is capped by
		// its daily budget (3 ok + 1 short-blocked = 4 counted; the next trips).
		expect((await send('b5', '10.0.0.2', at(700))).ok).toBe(true);
		expect(await send('b6', '10.0.0.2', at(701))).toMatchObject({ ok: false, reason: 'ip-rate-limited' });

		// 5) Global cap: next UTC day, fresh IPs only — eight sends fill the
		// world budget, the ninth is the distinct global-cap class.
		for (let i = 1; i <= 8; i++) {
			expect((await send(`g${i}`, `10.1.0.${i}`, at(90_000))).ok).toBe(true);
		}
		expect(await send('g9', '10.1.0.9', at(90_010))).toMatchObject({ ok: false, reason: 'global-cap' });

		// 6) Verify with injected limits + injected clock: a real captured code
		// verifies exactly once; wrong-code guesses lock at the injected 5 and
		// VOID the real code (the stronger property).
		for (let i = 0; i < 4; i++) {
			expect(await verifyOtp({ db: env.DB, purpose: 'fan', subject: `${tag}-g8`, code: '000000', pepper: OTP_PEPPER, now: at(90_020), limits })).toEqual({
				ok: false,
				reason: 'invalid'
			});
		}
		expect(await verifyOtp({ db: env.DB, purpose: 'fan', subject: `${tag}-g8`, code: '000000', pepper: OTP_PEPPER, now: at(90_021), limits })).toEqual({
			ok: false,
			reason: 'locked'
		});
		expect(await verifyOtp({ db: env.DB, purpose: 'fan', subject: `${tag}-g8`, code: codeOf('g8'), pepper: OTP_PEPPER, now: at(90_022), limits })).toEqual({
			ok: false,
			reason: 'invalid'
		});
		// A fresh subject's code verifies exactly once (the ladder's ok path).
		expect(
			await verifyOtp({ db: env.DB, purpose: 'fan', subject: `${tag}-g1`, code: codeOf('g1'), pepper: OTP_PEPPER, now: at(90_030), limits })
		).toEqual({ ok: true });
	});
});

// --- Endpoint smoke: the REAL fan handlers on the real clock ----------------

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

function makeEvent(path: string, body: unknown, ip: string): RequestEvent {
	return {
		request: new Request(`http://app.test${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL(`http://app.test${path}`),
		cookies: new CookieJar().cookies,
		getClientAddress: () => ip,
		platform: {
			env: {
				DB: env.DB,
				ART: null,
				SESSION_SECRET,
				EMAIL_PEPPER,
				OTP_PEPPER,
				MAILER_DRIVER: 'console'
			}
		}
	} as unknown as RequestEvent;
}

const fanRequestOtp = (email: string, ip: string) =>
	(fanRequestOtpHandler as unknown as (event: RequestEvent) => Promise<Response>)(makeEvent('/api/fan/request-otp', { email }, ip));
const fanVerifyOtp = (email: string, code: string, ip: string) =>
	(fanVerifyOtpHandler as unknown as (event: RequestEvent) => Promise<Response>)(makeEvent('/api/fan/verify-otp', { email, code }, ip));

let endpointCounter = 0;

describe('QA1 — OTP endpoint smoke (real fan endpoints, real clock)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('cooldown, per-IP rate limit, and verify lockout all fire through the wired endpoint', async () => {
		endpointCounter += 1;
		const ipA = `198.18.50.${endpointCounter}`;
		const ipB = `198.18.51.${endpointCounter}`;
		const ipC = `198.18.52.${endpointCounter}`;
		const stamp = `${Date.now()}-${endpointCounter}`;

		// Capture (and silence) the console mailer's codes up front.
		const codes: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			const match = /\b(\d{6})\b/.exec(args.join(' '));
			if (match) codes.push(match[1]!);
		});

		// Cooldown: immediate same-email resend → 429 otp_cooldown.
		const email = `qa1-endpoint-${stamp}@example.test`;
		expect((await fanRequestOtp(email, ipA)).status).toBe(200);
		const cooldownResponse = await fanRequestOtp(email, ipA);
		expect(cooldownResponse.status).toBe(429);
		expect(await cooldownResponse.json()).toMatchObject({ error: 'otp_cooldown' });

		// Per-IP short window: 5 sends from one IP pass (different emails), the
		// 6th is refused with the rate_limited class.
		for (let i = 0; i < 5; i++) {
			expect((await fanRequestOtp(`qa1-burst-${stamp}-${i}@example.test`, ipB)).status).toBe(200);
		}
		const limited = await fanRequestOtp(`qa1-burst-${stamp}-extra@example.test`, ipB);
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({ error: 'rate_limited', retryAfterSeconds: expect.any(Number) });

		// Verify lockout: the latest captured code is the lockout email's; burn
		// the 5 attempts, then even the CORRECT code is dead.
		const lockoutEmail = `qa1-lockout-${stamp}@example.test`;
		expect((await fanRequestOtp(lockoutEmail, ipC)).status).toBe(200);
		const lockoutCode = codes.at(-1)!;
		for (let i = 0; i < 4; i++) {
			expect((await fanVerifyOtp(lockoutEmail, '000000', ipC)).status).toBe(400);
		}
		const locked = await fanVerifyOtp(lockoutEmail, '000000', ipC);
		expect(locked.status).toBe(429);
		expect(await locked.json()).toMatchObject({ error: 'too_many_attempts' });
		expect((await fanVerifyOtp(lockoutEmail, lockoutCode, ipC)).status).toBe(400); // the real code is void
	});
});
