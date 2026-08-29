/**
 * Report + reissue (BE6) — the fan's dead-code flow and the artist's
 * visibility into it.
 *
 * The product bargain (plan.md "Fixed by scope"): a fan who claims a code and
 * finds it already redeemed may report it dead and receive EXACTLY ONE
 * replacement per project per email — never more. The mechanics ride entirely
 * on BE5's invariants plus the schema laid down in migrations/0001_init.sql:
 *
 * | Property                        | Enforced by                                       |
 * |---------------------------------|---------------------------------------------------|
 * | Only the claim owner can report | Every lookup here is keyed by fan_hash — a        |
 * |                                 | non-owner's hash simply finds no claim row        |
 * |                                 | (typed `no-claim`). There is no report-by-id      |
 * |                                 | surface to forge.                                 |
 * | Exactly one replacement         | The reissue re-points the SAME claims row         |
 * |                                 | (never inserts a second one), so                  |
 * |                                 | UNIQUE(project_id, fan_hash) keeps holding: the   |
 * |                                 | fan can never hold two live codes.                |
 * | Exactly one report ever         | reports.claim_id UNIQUE. Because a reissue        |
 * |                                 | re-points the same claim row, the constraint      |
 * |                                 | bounds the whole flow: report #1 (whether or not  |
 * |                                 | a replacement existed in the pool) consumes the   |
 * |                                 | budget; report #2 is typed `already-reissued`     |
 * |                                 | forever.                                          |
 * | Reported codes never re-dispense| codes.status='reported' — BE5's pick subquery     |
 * |                                 | only ever selects status='available'.             |
 * | Concurrent double reports       | ONE serialized db.batch (implicit transaction,    |
 * | → exactly one reissue           | R1-verified): the reports INSERT runs FIRST, so   |
 * |                                 | the loser of two racing batches trips             |
 * |                                 | UNIQUE(claim_id), rolls back entirely, re-reads,  |
 * |                                 | and answers `already-reissued` with the winner's  |
 * |                                 | committed state.                                  |
 *
 * Statement order inside the ONE db.batch (order is contractual — D1 runs
 * batch statements sequentially in one transaction, same discipline as BE5):
 *
 *   1. INSERT INTO reports — the report record (reason optional, timestamp,
 *      claim_id + the dead code_id). Placed FIRST so the UNIQUE(claim_id)
 *      tripwire fires before any other statement mutates anything in a race.
 *   2. UPDATE codes -> 'reported' (+ reported_at) for exactly the dead code,
 *      guarded from status='claimed' — this is the artist-visible marking.
 *   3. THE reissue: UPDATE claims ... FROM (BE5's exact random-pick subquery)
 *      re-points the SAME claim row to a fresh available code and flips
 *      kind='original' -> 'reissue' + reissued_at. UPDATE...FROM (SQLite
 *      3.33+, comfortably below D1's engine — BE5 already relies on RETURNING
 *      from 3.35+) is load-bearing: when the pool has no available code, the
 *      FROM subquery yields no rows, the UPDATE is a silent 0-row no-op —
 *      code_id is never assigned NULL (NOT NULL would abort the batch and
 *      lose the report itself). One batch therefore lands BOTH honest
 *      outcomes: full reissue, or report-recorded-no-replacement.
 *   4. UPDATE codes -> 'claimed' for exactly the claim's (new) code under a
 *      status='available' guard, RETURNING id, code — its row count is THE
 *      reissue signal (the exact discipline of BE5's freshness flag): 1 row
 *      iff THIS batch re-pointed the claim. On the drained no-op path the
 *      claim still points at the dead code, which statement (2) already
 *      marked 'reported' — so nothing flips, zero rows.
 *   5. Drained auto-flip, identical to BE5's: if the reissue took the last
 *      available code (or the pool was already empty), projects.status goes
 *      'drained' — guarded to fire only from 'active' so BE7 stays
 *      authoritative elsewhere.
 *   6. Read back the committed claim + its code status for the response.
 *
 * Two deliberate scope decisions (documented for QA1/review):
 *
 * - The REPORT consumes the reissue budget even when the pool is empty at
 *   report time (`reissue-drained`: report recorded, no new code, claim still
 *   pointing at the dead code, kind stays 'original'). There is no second
 *   trigger surface in the product that could later deliver the owed
 *   replacement, so keeping the budget open would be a promise nothing can
 *   honor. "No further reissue ever" is the honest contract.
 * - The reissue has NO project-status gate: pausing stops NEW distribution
 *   (BE5's fresh-claim path), but a report is an existing claim-holder's
 *   right over their held code — same reasoning as BE5's revisit re-show,
 *   which also short-circuits before status guards. Whether a replacement
 *   exists is decided purely by the pool (statement 3's subquery).
 */

import type { D1Database } from '@cloudflare/workers-types';
import { projectRefBinds, type ClaimView } from './dispense';
import { toSqlUtc } from './time';

/** A claim as the report flow returns it (never exposes fan_hash). */
export interface ReportClaimView extends ClaimView {
	/** The HELD code's current status: 'claimed' (live) | 'reported' (dead). */
	codeStatus: 'claimed' | 'reported';
	/** SQL-UTC 'YYYY-MM-DD HH:MM:SS' — set when the single reissue happened. */
	reissuedAt: string | null;
}

/**
 * User-safe outcomes. `reissued` = report recorded AND a replacement
 * dispensed (the claim now holds it). `reissue-drained` = report recorded,
 * pool had nothing (claim honestly still points at the dead code).
 * `already-reissued` = this fan's one report was spent (returns the current
 * claim state). `no-claim` = this fan holds no claim on the project — which
 * is also the owner-only enforcement. Anything unexpected THROWS (callers map
 * that to 500, never to a lie about state).
 */
export type ReportResult =
	| { ok: true; outcome: 'reissued'; claim: ReportClaimView; reportedCode: string }
	| { ok: true; outcome: 'reissue-drained'; claim: ReportClaimView; reportedCode: string }
	| { ok: true; outcome: 'already-reissued'; claim: ReportClaimView }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'no-claim' };

/** Everything the report flow needs (deps style: testable, no module state). */
export interface ReportDeps {
	db: D1Database;
	/**
	 * Fan identity: HMAC-SHA256(email, EMAIL_PEPPER) hex — the canonical
	 * hashFanEmail output (fan-identity.ts). This module only accepts the
	 * hash; it never computes one.
	 */
	fanHash: string;
	/** Project slug (the share URL) or numeric id. */
	project: string | number;
	/** Optional fan note; trimmed, clamped to REASON_MAX_CHARS, null when empty. */
	reason?: string | null;
	/** Injected clock — every written timestamp is deterministic under test. */
	now: Date;
}

/** Fan notes are advisory, not content: bounded so a report can't store a novel. */
export const REASON_MAX_CHARS = 500;

function normalizeReason(reason: string | null | undefined): string | null {
	if (typeof reason !== 'string') return null;
	const trimmed = reason.trim();
	return trimmed.length === 0 ? null : trimmed.slice(0, REASON_MAX_CHARS);
}

/** The read-back / already-reissued row shape (claim joined to its live code). */
interface ClaimReadRow {
	claim_id: number;
	kind: string;
	claimed_at: string;
	reissued_at: string | null;
	ip_hash: string | null;
	source: string | null;
	code_id: number;
	code: string;
	code_status: string;
}

/** Statement (4)'s RETURNING shape ({ id, code }). */
interface FlipRow {
	id: number;
	code: string;
}

function toReportClaimView(row: ClaimReadRow): ReportClaimView {
	return {
		claimId: row.claim_id,
		codeId: row.code_id,
		code: row.code,
		kind: row.kind === 'reissue' ? 'reissue' : 'original',
		claimedAt: row.claimed_at,
		ipHash: row.ip_hash,
		source: row.source,
		codeStatus: row.code_status === 'reported' ? 'reported' : 'claimed',
		reissuedAt: row.reissued_at
	};
}

/**
 * ONE round trip for the whole pre-check: the project (+status), this fan's
 * claim (if any), the claim's held code, and whether a report already exists.
 * Keyed entirely by fan_hash — a non-owner's hash matches no claim row, which
 * IS the owner-only rule. The UNIQUE(project_id, fan_hash) means the join can
 * never multiply rows.
 */
interface ReportPreRead {
	project_id: number;
	status: string;
	claim_id: number | null;
	kind: string | null;
	claimed_at: string | null;
	reissued_at: string | null;
	ip_hash: string | null;
	source: string | null;
	code_id: number | null;
	code: string | null;
	code_status: string | null;
	report_id: number | null;
}

async function loadForReport(
	db: D1Database,
	project: string | number,
	fanHash: string
): Promise<ReportPreRead | null> {
	const [id, slug] = projectRefBinds(project);
	return db
		.prepare(
			`SELECT p.id AS project_id, p.status AS status,
				cl.id AS claim_id, cl.kind AS kind, cl.claimed_at AS claimed_at, cl.reissued_at AS reissued_at,
				cl.ip_hash AS ip_hash, cl.source AS source,
				cd.id AS code_id, cd.code AS code, cd.status AS code_status,
				r.id AS report_id
				FROM projects p
				LEFT JOIN claims cl ON cl.project_id = p.id AND cl.fan_hash = ?1
				LEFT JOIN codes cd ON cd.id = cl.code_id
				LEFT JOIN reports r ON r.claim_id = cl.id
				WHERE (?2 >= 0 AND p.id = ?2) OR (?3 <> '' AND p.slug = ?3)`
		)
		.bind(fanHash, id, slug)
		.first<ReportPreRead>();
}

/**
 * The one-report budget is spent iff a reports row exists for the claim.
 * kind='reissue' (a committed reissue) and code_status='reported' (a drained
 * report left the claim pointing at the dead code) are belt-and-braces
 * signals of the same fact — in every committed flow all three flip together
 * or the report row alone exists.
 */
function isBudgetSpent(row: Pick<ReportPreRead, 'report_id' | 'kind' | 'code_status'>): boolean {
	return row.report_id != null || row.kind === 'reissue' || row.code_status === 'reported';
}

/**
 * Report the fan's dispensed code dead on one project. Owner-only by
 * construction (fan_hash keying); records the report (artist-visible) and
 * grants the single replacement iff the pool has an available code at batch
 * time — all in ONE serialized batch, so racing double-reports collapse to
 * exactly one reissue and one reports row.
 */
export async function reportClaim(deps: ReportDeps): Promise<ReportResult> {
	const { db, fanHash, now } = deps;
	if (typeof fanHash !== 'string' || fanHash.length === 0) {
		// Wiring bug (the fan session guarantees the hash), not a user state.
		throw new TypeError('reportClaim: fanHash must be a non-empty string (hashFanEmail output)');
	}

	// -- Typed pre-check ------------------------------------------------------
	const pre = await loadForReport(db, deps.project, fanHash);
	if (!pre) return { ok: false, reason: 'not-found' };
	if (pre.status === 'draft') return { ok: false, reason: 'not-found' }; // unpublished is invisible
	if (pre.claim_id == null) return { ok: false, reason: 'no-claim' }; // owner-only: no claim for THIS fan
	if (isBudgetSpent(pre)) {
		return {
			ok: true,
			outcome: 'already-reissued',
			claim: toReportClaimView(pre as unknown as ClaimReadRow)
		};
	}
	// Pre-check guarantees the live shape: an original claim whose held code
	// is 'claimed'. (A code only leaves 'claimed' via this flow, which always
	// writes the reports row the budget check above just excluded.)
	const claimId = pre.claim_id;
	const deadCodeId = pre.code_id!;
	const deadCode = pre.code!;
	const nowText = toSqlUtc(now);
	const reason = normalizeReason(deps.reason);

	try {
		const results = await db.batch<FlipRow | ClaimReadRow>([
			// (1) The report record. FIRST so UNIQUE(claim_id) trips a racing
			// second batch before it mutates anything (full rollback follows).
			db
				.prepare('INSERT INTO reports (claim_id, code_id, reason, created_at) VALUES (?1, ?2, ?3, ?4)')
				.bind(claimId, deadCodeId, reason, nowText),
			// (2) Mark the dead code artist-visible, guarded from 'claimed'.
			db
				.prepare(`UPDATE codes SET status = 'reported', reported_at = ?2 WHERE id = ?1 AND status = 'claimed'`)
				.bind(deadCodeId, nowText),
			// (3) THE reissue — re-point the SAME claim row at one random
			// available code (BE5's pick subquery verbatim) under the
			// kind='original' once-only guard. UPDATE...FROM makes an empty
			// pool a silent 0-row no-op (never a NULL code_id).
			db
				.prepare(
					`UPDATE claims
						SET code_id = picked.id, kind = 'reissue', reissued_at = ?3
						FROM (SELECT id FROM codes WHERE project_id = ?1 AND status = 'available' ORDER BY RANDOM() LIMIT 1) AS picked
						WHERE claims.id = ?2 AND claims.kind = 'original'`
				)
				.bind(pre.project_id, claimId, nowText),
			// (4) Flip exactly the newly picked code; its RETURNING row count
			// is THE reissue signal (1 row iff THIS batch re-pointed). On the
			// drained no-op the claim still points at the dead code, which (2)
			// already marked 'reported' — nothing flips.
			db
				.prepare(
					`UPDATE codes SET status = 'claimed', claimed_at = ?2
						WHERE id = (SELECT code_id FROM claims WHERE id = ?1) AND status = 'available'
						RETURNING id, code`
				)
				.bind(claimId, nowText),
			// (5) Drained auto-flip — BE5 parity, guarded to fire only from 'active'.
			db
				.prepare(
					`UPDATE projects SET status = 'drained', updated_at = ?2
						WHERE id = ?1 AND status = 'active'
							AND NOT EXISTS (SELECT 1 FROM codes WHERE project_id = ?1 AND status = 'available')`
				)
				.bind(pre.project_id, nowText),
			// (6) Read back the committed claim for the response.
			db
				.prepare(
					`SELECT cl.id AS claim_id, cl.kind AS kind, cl.claimed_at AS claimed_at, cl.reissued_at AS reissued_at,
						cl.ip_hash AS ip_hash, cl.source AS source, cd.id AS code_id, cd.code AS code, cd.status AS code_status
						FROM claims cl JOIN codes cd ON cd.id = cl.code_id WHERE cl.id = ?1`
				)
				.bind(claimId)
		]);

		const flipped = results[3]!.results.length > 0;
		const readRow = results[5]!.results[0] as ClaimReadRow | undefined;
		if (!readRow) {
			// The claim vanished mid-batch (project cascade-deleted) — impossible
			// in-product; classify honestly rather than fabricate a claim.
			return { ok: false, reason: 'not-found' };
		}
		const claim = toReportClaimView(readRow);
		return flipped
			? { ok: true, outcome: 'reissued', claim, reportedCode: deadCode }
			: { ok: true, outcome: 'reissue-drained', claim, reportedCode: deadCode };
	} catch (error) {
		// Concurrent double-report (same claim): our reports INSERT lost the
		// UNIQUE(claim_id) race and the WHOLE batch rolled back — nothing we
		// attempted was written. The winner's report (and its reissue, if the
		// pool allowed one) is committed; re-read and answer with that state.
		const reread = await loadForReport(db, deps.project, fanHash);
		if (reread && reread.claim_id != null && isBudgetSpent(reread)) {
			return {
				ok: true,
				outcome: 'already-reissued',
				claim: toReportClaimView(reread as unknown as ClaimReadRow)
			};
		}
		// Anything else re-reads clean: a genuine failure — rethrow (500, not a lie).
		throw error;
	}
}

/**
 * Artist visibility (BE7 stats / FE5 console): one project's reports — the
 * count plus the reported-codes list (dead code, optional reason, when, and
 * whether the reporting fan received a replacement). Accepts slug or id;
 * null when the project does not exist. Every reports row is exactly one
 * reported code (reports.claim_id UNIQUE), so reports.length IS the count.
 */
export interface ProjectReportEntry {
	reportId: number;
	claimId: number;
	codeId: number;
	/** The reported (dead) `xxxx-xxxx` code — never re-dispensed. */
	code: string;
	reason: string | null;
	/** SQL-UTC 'YYYY-MM-DD HH:MM:SS' — the report moment (reports.created_at). */
	reportedAt: string;
	/** Whether the single reissue fired (false = the pool was drained then). */
	reissued: boolean;
	reissuedAt: string | null;
}

export interface ProjectReportsView {
	projectId: number;
	reportCount: number;
	reports: ProjectReportEntry[];
}

export async function projectReports(
	db: D1Database,
	project: string | number
): Promise<ProjectReportsView | null> {
	const [id, slug] = projectRefBinds(project);
	const projectRow = await db
		.prepare(`SELECT id FROM projects WHERE (?1 >= 0 AND id = ?1) OR (?2 <> '' AND slug = ?2)`)
		.bind(id, slug)
		.first<{ id: number }>();
	if (!projectRow) return null;

	const rows = await db
		.prepare(
			`SELECT r.id AS report_id, r.claim_id AS claim_id, r.code_id AS code_id,
				cd.code AS code, r.reason AS reason, r.created_at AS reported_at,
				cl.kind AS claim_kind, cl.reissued_at AS reissued_at
				FROM reports r
				JOIN claims cl ON cl.id = r.claim_id
				JOIN codes cd ON cd.id = r.code_id
				WHERE cl.project_id = ?1
				ORDER BY r.created_at DESC, r.id DESC`
		)
		.bind(projectRow.id)
		.all<{
			report_id: number;
			claim_id: number;
			code_id: number;
			code: string;
			reason: string | null;
			reported_at: string;
			claim_kind: string;
			reissued_at: string | null;
		}>();

	return {
		projectId: projectRow.id,
		reportCount: rows.results.length,
		reports: rows.results.map((row) => ({
			reportId: row.report_id,
			claimId: row.claim_id,
			codeId: row.code_id,
			code: row.code,
			reason: row.reason,
			reportedAt: row.reported_at,
			reissued: row.claim_kind === 'reissue',
			reissuedAt: row.reissued_at
		}))
	};
}
