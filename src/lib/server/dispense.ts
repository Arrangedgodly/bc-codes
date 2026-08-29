/**
 * Atomic dispense engine (BE5) — the correctness heart of bc-codes.
 *
 * Three hard invariants (the test contract, docs/ultron/plan.md QA1):
 *
 * | Invariant                    | Enforced by                                         |
 * |------------------------------|-----------------------------------------------------|
 * | No double-dispense           | One serialized db.batch (implicit transaction,      |
 * | (a code goes to exactly      | R1-verified) whose claim INSERT picks the code via  |
 * |  one fan)                    | the R1 random-pick subquery; the code UPDATE then   |
 * |                              | flips exactly that claim's code under a             |
 * |                              | status='available' guard. D1 executes batches       |
 * |                              | sequentially and non-concurrently, so a racing      |
 * |                              | batch re-evaluates `status='available'` AFTER the   |
 * |                              | winner commits (docs/ultron/research/               |
 * |                              | R1-cloudflare-stack.md and its 250-claim burst).    |
 * | 1 code per project per fan   | claims.UNIQUE(project_id, fan_hash) — the load-     |
 * | email                        | bearing constraint. A same-fan racer (two tabs)     |
 * |                              | loses on one of two paths, BOTH ending in an        |
 * |                              | honest reused=true re-show of the winner's claim:   |
 * |                              | (a) codes remain — the claim INSERT hits the        |
 * |                              | UNIQUE, D1 rolls back the WHOLE batch (code UPDATE  |
 * |                              | included, empirically verified), the catch path     |
 * |                              | re-reads; (b) the winner's commit emptied the pool  |
 * |                              | — the INSERT…SELECT is a silent no-op (no row to    |
 * |                              | insert, so no constraint fires) and (3) flips       |
 * |                              | nothing; freshness keys off (3)'s RETURNING, so     |
 * |                              | the winner's claim still reads reused=true. Never   |
 * |                              | a second code for the same fan.                     |
 * | Paused/drained dispense      | Typed pre-check below AND the same guards inside    |
 * | nothing                      | the batch WHERE/EXISTS (TOCTOU-safe: a status flip  |
 * |                              | or a pool emptied between check and batch still     |
 * |                              | results in a 0-row dispense, never a bad one).      |
 *
 * Statement order inside the ONE db.batch (order is contractual — D1 runs
 * batch statements sequentially in one transaction):
 *   1. INSERT INTO fan_identities ... ON CONFLICT DO NOTHING — the claims FK
 *      precondition (BE4 owns the identity lifecycle; this is idempotent, so
 *      either order works).
 *   2. INSERT INTO claims ... SELECT — THE dispense: picks one random
 *      available code of an ACTIVE project (R1's exact
 *      `WHERE id IN (SELECT ... ORDER BY RANDOM() LIMIT 1)` shape) and creates
 *      the claim pointing at it, carrying ip_hash/source metadata.
 *   3. UPDATE codes SET status='claimed' ... RETURNING id, code — flips
 *      exactly the code the claim from (2) grabbed.
 *   4. UPDATE projects -> 'drained' when the pool just emptied (guarded to
 *      only ever fire from 'active', so BE7's pause/resume stays authoritative
 *      everywhere else; BE7 must re-activate a drained project when uploading
 *      new codes — noted in the production log).
 *   5. SELECT the committed claim + code string for the response. The
 *      response's `reused` flag is decided by statement (3)'s RETURNING
 *      row count (1 row = THIS batch dispensed), never by the read-back's
 *      mere existence — on the empty-pool same-fan race path the read-back
 *      returns the WINNER's committed claim, which this batch never
 *      created (row 2, path (b) above).
 *
 * Why claim-INSERT-then-code-UPDATE, not the literal UPDATE-first order in the
 * plan row: D1 batch bindings are fixed per statement upfront, so a later
 * statement cannot reference an earlier statement's RETURNING output. The
 * claim INSERT therefore OWNS the pick (subquery) and the UPDATE flips exactly
 * that claim's code — same R1-verified elements (the random-pick subquery,
 * everything in one batch, UNIQUE(project_id, fan_hash) rollback), zero
 * windows: there is never an intermediate state where a code is claimed but
 * claimless, even mid-transaction. Safety is identical (any failure rolls the
 * whole batch back); the linkage is simply inverted.
 *
 * Revisit semantics: an existing claim for (project, fan_hash) short-circuits
 * BEFORE any state guard — the fan already holds the code, and re-showing it
 * is correct even after the project is paused or drained. Only a missing
 * project (or a draft one — unpublished is invisible) outranks it.
 *
 * Availability is derived, never maintained as a counter: idx_codes_project_
 * status makes each status slice an index range scan (sub-millisecond at MVP
 * scale: hundreds to low thousands of codes per project, a few directory
 * polls per second). A maintained counter would add writes to the hottest
 * path (this batch) and drift risk across three writers (dispense here, BE6
 * reissue, BE7 upload). projectAvailability() below is the single read
 * surface FE2/BE7 consume; a counter can hide behind it if scale ever demands.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { hmacHex } from './crypto';
import { toSqlUtc } from './time';

/** A claim as shown to the fan / FE surfaces (never exposes fan_hash). */
export interface ClaimView {
	claimId: number;
	codeId: number;
	/** The dispensed `xxxx-xxxx` code string — the product's payload. */
	code: string;
	kind: 'original' | 'reissue';
	/** SQL-UTC 'YYYY-MM-DD HH:MM:SS' — the claim's created_at. */
	claimedAt: string;
	ipHash: string | null;
	source: string | null;
}

/**
 * User-safe outcomes. `not-found` also covers draft projects (unpublished =
 * invisible: no existence leak); `paused` and `drained` are honest states the
 * UI renders. Anything unexpected (DB failure) THROWS — callers map that to a
 * 500, not to a lie about availability.
 */
export type DispenseResult =
	| { ok: true; claim: ClaimView; reused: boolean }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'paused' }
	| { ok: false; reason: 'drained' };

/** Everything the dispense path needs (deps style: testable, no module state). */
export interface DispenseDeps {
	db: D1Database;
	/** Project slug (the share URL) or numeric id. */
	project: string | number;
	/**
	 * Fan identity: HMAC-SHA256(email, EMAIL_PEPPER) hex — computed by
	 * hashFanEmail (fan-identity.ts, the canonical implementation; BE4 wires
	 * it). This module only accepts the hash string as a parameter.
	 */
	fanHash: string;
	/** HMAC-SHA256(ip, EMAIL_PEPPER) hex — see hashIp(); null when absent. */
	ipHash?: string | null;
	/** Surface tag ('web'); null when absent. */
	source?: string | null;
	/** Injected clock — every written timestamp is deterministic under test. */
	now: Date;
}

/**
 * HMAC-SHA256(ip, EMAIL_PEPPER) hex for the ip_hash column. Lowercase-hex,
 * peppered like fan emails: plaintext client IPs are never stored, and the
 * hash is computable only with the secret.
 */
export async function hashIp(ip: string, pepper: string): Promise<string> {
	return hmacHex(ip.trim(), pepper);
}

/** Row shape shared by the batch read-back, the error-path re-read, and the pre-read. */
interface ClaimRow {
	claim_id: number;
	kind: string;
	claimed_at: string;
	ip_hash: string | null;
	source: string | null;
	code_id: number;
	code: string;
}

const CLAIM_SELECT = `SELECT cl.id AS claim_id, cl.kind AS kind, cl.claimed_at AS claimed_at,
	cl.ip_hash AS ip_hash, cl.source AS source, cd.id AS code_id, cd.code AS code
	FROM claims cl JOIN codes cd ON cd.id = cl.code_id
	WHERE cl.project_id = ?1 AND cl.fan_hash = ?2`;

function toClaimView(row: ClaimRow): ClaimView {
	return {
		claimId: row.claim_id,
		codeId: row.code_id,
		code: row.code,
		kind: row.kind === 'reissue' ? 'reissue' : 'original',
		claimedAt: row.claimed_at,
		ipHash: row.ip_hash,
		source: row.source
	};
}

/**
 * Resolve a slug-or-id reference into (id, slug) bind pair; -1/'' disable a
 * side. Shared by every project-scoped read/write helper (BE6's report lane
 * reuses it via import so slug/id resolution has ONE implementation).
 */
export function projectRefBinds(project: string | number): [number, string] {
	return typeof project === 'number' ? [project, ''] : [-1, project];
}

async function readClaim(db: D1Database, projectId: number, fanHash: string): Promise<ClaimView | null> {
	const row = await db.prepare(CLAIM_SELECT).bind(projectId, fanHash).first<ClaimRow>();
	return row ? toClaimView(row) : null;
}

interface PreRead {
	projectId: number;
	status: string;
	available: number;
	claim: ClaimView | null;
}

/**
 * ONE round trip for the whole pre-check: project (+status), its available
 * count, and the fan's existing claim if any. The UNIQUE(project_id, fan_hash)
 * means the LEFT JOIN can never multiply rows.
 */
async function loadProjectWithClaim(
	db: D1Database,
	project: string | number,
	fanHash: string
): Promise<PreRead | null> {
	const [id, slug] = projectRefBinds(project);
	const row = await db
		.prepare(
			`SELECT p.id AS project_id, p.status AS status,
				(SELECT COUNT(*) FROM codes c WHERE c.project_id = p.id AND c.status = 'available') AS available,
				cl.id AS claim_id, cl.kind AS kind, cl.claimed_at AS claimed_at,
				cl.ip_hash AS ip_hash, cl.source AS source,
				cd.id AS code_id, cd.code AS code
				FROM projects p
				LEFT JOIN claims cl ON cl.project_id = p.id AND cl.fan_hash = ?1
				LEFT JOIN codes cd ON cd.id = cl.code_id
				WHERE (?2 >= 0 AND p.id = ?2) OR (?3 <> '' AND p.slug = ?3)`
		)
		.bind(fanHash, id, slug)
		.first<{ project_id: number; status: string; available: number } & ClaimRow & { claim_id: number | null }>();
	if (!row) return null;
	return {
		projectId: row.project_id,
		status: row.status,
		available: row.available,
		claim: row.claim_id == null ? null : toClaimView(row as ClaimRow)
	};
}

/**
 * The guards failed between pre-read and batch (status flipped or pool emptied
 * mid-flight). Re-read the project so the typed outcome reflects the CURRENT
 * state, not the stale one. A project deleted mid-flight is not-found; drained
 * (or active — pool empty but the flip is beside the point) is drained;
 * anything else (paused, flipped back to draft) is paused — the honest
 * "come back later" state.
 */
async function classifyMissedDispense(db: D1Database, projectId: number): Promise<DispenseResult> {
	const row = await db.prepare('SELECT status FROM projects WHERE id = ?1').bind(projectId).first<{ status: string }>();
	if (!row) return { ok: false, reason: 'not-found' };
	if (row.status === 'active' || row.status === 'drained') return { ok: false, reason: 'drained' };
	return { ok: false, reason: 'paused' };
}

/**
 * Claim (or re-show) one code for one fan on one project.
 *
 * - Revisit (existing claim): returns the SAME code, reused=true, no dispense.
 * - Fresh: one serialized batch claims a random available code atomically and
 *   returns it, reused=false — decided by the batch's own code-UPDATE
 *   RETURNING a row, never by the read-back's existence.
 * - Same-fan race loser, pool NOT emptied by the winner: the claim INSERT
 *   throws (UNIQUE violation), the whole batch rolls back, and the re-read
 *   returns the winner's claim — reused=true, same code.
 * - Same-fan race loser, pool EMPTIED by the winner: the claim INSERT…SELECT
 *   is a silent no-op (nothing to pick, so no UNIQUE violation fires), the
 *   code UPDATE flips nothing, and the read-back returns the winner's
 *   committed claim — reused=true, same code (the V-BE5 path: an honest
 *   re-show, not a phantom fresh dispense).
 */
export async function dispenseCode(deps: DispenseDeps): Promise<DispenseResult> {
	const { db, fanHash, now } = deps;
	if (typeof fanHash !== 'string' || fanHash.length === 0) {
		// Wiring bug (BE4 guarantees the hash), not a user state: fail loudly
		// rather than dispense under an empty identity.
		throw new TypeError('dispenseCode: fanHash must be a non-empty string (HMAC-SHA256(email, EMAIL_PEPPER))');
	}

	// -- Typed pre-check: NO dispense unless everything below is green. -------
	const pre = await loadProjectWithClaim(db, deps.project, fanHash);
	if (!pre) return { ok: false, reason: 'not-found' };
	if (pre.status === 'draft') return { ok: false, reason: 'not-found' }; // unpublished is invisible
	if (pre.claim) return { ok: true, claim: pre.claim, reused: true }; // revisit re-shows, even if paused/drained now
	if (pre.status === 'paused') return { ok: false, reason: 'paused' };
	if (pre.status !== 'active' || pre.available === 0) return { ok: false, reason: 'drained' };

	// -- The dispense: ONE db.batch = ONE transaction. Order is contractual. --
	const projectId = pre.projectId;
	const ipHash = deps.ipHash ?? null;
	const source = deps.source ?? null;
	const nowText = toSqlUtc(now);

	try {
		const results = await db.batch<ClaimRow>([
			// (1) claims.fan_id FK precondition. Idempotent: if BE4 already
			// created the identity (OTP verify), this is a no-op.
			db
				.prepare('INSERT INTO fan_identities (email_hash) VALUES (?1) ON CONFLICT (email_hash) DO NOTHING')
				.bind(fanHash),
			// (2) THE dispense — claim INSERT owns the random pick (R1's exact
			// subquery). Inserts 0 rows (no error) when the pool is empty or
			// the project is no longer active — INCLUDING the same-fan race
			// case where the winner's commit emptied the pool: no row to
			// insert means no UNIQUE(project_id, fan_hash) check fires, so
			// this loser path does NOT throw (path (b) in the module header).
			// When codes remain and a same-fan racer committed first, the
			// attempted insert DOES throw UNIQUE and rolls back the batch.
			db
				.prepare(
					`INSERT INTO claims (project_id, fan_id, fan_hash, code_id, kind, claimed_at, ip_hash, source)
						SELECT ?1, (SELECT id FROM fan_identities WHERE email_hash = ?2), ?2, picked.id, 'original', ?5, ?3, ?4
						FROM codes AS picked
						WHERE picked.id IN (
							SELECT id FROM codes
							WHERE status = 'available' AND project_id = ?1
							ORDER BY RANDOM()
							LIMIT 1
						)
						AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ?1 AND p.status = 'active')`
				)
				.bind(projectId, fanHash, ipHash, source, nowText),
			// (3) Flip exactly the claim's code (R1's UPDATE ... RETURNING; the
			// status guard is belt-and-braces inside the same transaction).
			// Its RETURNING row count is ALSO the freshness signal: 1 row iff
			// THIS batch picked a code and flipped it. 0 rows with a claim in
			// the read-back means that claim pre-existed the batch — the
			// empty-pool same-fan race loser re-showing the winner's claim.
			db
				.prepare(
					`UPDATE codes SET status = 'claimed', claimed_at = ?3
						WHERE id = (SELECT code_id FROM claims WHERE project_id = ?1 AND fan_hash = ?2)
							AND status = 'available'
						RETURNING id, code`
				)
				.bind(projectId, fanHash, nowText),
			// (4) Keep projects.status honest: flip to drained when this batch
			// emptied the pool. Guarded to fire only from 'active'.
			db
				.prepare(
					`UPDATE projects SET status = 'drained', updated_at = ?2
						WHERE id = ?1 AND status = 'active'
							AND NOT EXISTS (SELECT 1 FROM codes WHERE project_id = ?1 AND status = 'available')`
				)
				.bind(projectId, nowText),
			// (5) Read back the committed claim for the response.
			db.prepare(CLAIM_SELECT).bind(projectId, fanHash)
		]);

		// Freshness is keyed off what THIS batch wrote, never off the
		// read-back's existence. Statement (3)'s RETURNING has a row iff this
		// committed batch flipped a code (fresh dispense — the pick in (2)
		// and the flip in (3) share one serialized transaction, so a row
		// inserted by (2) is always flipped by (3)). A read-back claim with
		// NO flipped code can only be a claim that pre-existed this batch:
		// the empty-pool same-fan race loser, whose (2) was a silent no-op —
		// an honest reused=true re-show of the winner's claim. No read-back
		// row at all => the in-batch guards fired (pause/drain raced in) =>
		// classify now.
		const flipped = results[2]!.results.length > 0;
		const claimRow = results[4]!.results[0] ?? null;
		if (claimRow) return { ok: true, claim: toClaimView(claimRow), reused: !flipped };
		return await classifyMissedDispense(db, projectId);
		} catch (error) {
			// Same-fan race, codes-remain variant (two tabs): our claim INSERT
			// lost the UNIQUE race, the batch rolled back entirely (nothing
			// dispensed by us), and the winner's committed claim IS this fan's
			// claim — re-read and re-show it. (The emptied-pool loser variant
			// never throws: its INSERT was a no-op, handled above with
			// reused=true.) This also covers a lost-response-but-committed
			// batch (idempotent re-show). Any other failure re-reads to null
			// and rethrows.
		const existing = await readClaim(db, projectId, fanHash);
		if (existing) return { ok: true, claim: existing, reused: true };
		throw error;
	}
}

/** Per-status code counts for one project (FE2 availability meters, BE7 stats). */
export interface ProjectAvailability {
	total: number;
	available: number;
	claimed: number;
	reported: number;
}

/**
 * Derived availability (see the module header for why COUNT, not a counter).
 * Accepts slug or id; null when the project does not exist.
 */
export async function projectAvailability(
	db: D1Database,
	project: string | number
): Promise<ProjectAvailability | null> {
	const [id, slug] = projectRefBinds(project);
	const projectRow = await db
		.prepare(`SELECT id FROM projects WHERE (?1 >= 0 AND id = ?1) OR (?2 <> '' AND slug = ?2)`)
		.bind(id, slug)
		.first<{ id: number }>();
	if (!projectRow) return null;
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END), 0) AS available,
				COALESCE(SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed,
				COALESCE(SUM(CASE WHEN status = 'reported' THEN 1 ELSE 0 END), 0) AS reported
				FROM codes WHERE project_id = ?1`
		)
		.bind(projectRow.id)
		.first<ProjectAvailability>();
	return row ?? { total: 0, available: 0, claimed: 0, reported: 0 };
}
