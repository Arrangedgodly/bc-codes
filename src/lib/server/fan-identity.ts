/**
 * Fan identity (BE4) — the canonical `fan_hash` + identity lifecycle + the
 * fan-facing claims read surface.
 *
 * Fan identity is a VERIFIED EMAIL, stored hash-only (town-hall pivot; plan.md
 * "Fixed by scope"): the only at-rest form of a fan email anywhere in the
 * system is `hashFanEmail(email, EMAIL_PEPPER)` — lowercase hex HMAC. That one
 * string is the join key for everything fan-side:
 *
 *   otp_pendings.subject (purpose='fan')  — the OTP identity (BE3 machinery)
 *   fan_identities.email_hash             — the identity row (this module)
 *   claims.fan_hash                       — 1+1-per-email invariant + FE4 lookup
 *
 * One canonical implementation: BE5's `dispenseCode` accepts the hash as a
 * parameter (it never computes one), and `hashIp` (dispense.ts) is the sibling
 * helper for client IPs under the same pepper — plaintext fan PII never rests.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { hmacHex } from './crypto';
import { projectRefBinds } from './dispense';
import { toArtworkStatus, type PublicArtworkStatus } from './public';
import { toSqlUtc } from './time';

/**
 * The canonical fan identity hash: HMAC-SHA256(email.trim().toLowerCase(),
 * EMAIL_PEPPER) as lowercase hex. Canonicalization mirrors normalizeEmail's
 * storage form (BE3), so `  Fan@X.Test `, `fan@x.test` and `FAN@x.test` are
 * ONE fan — one OTP subject, one identity row, one per-project claim budget.
 * Deterministic + keyed: hashes cannot be joined across apps or reversed
 * without the secret, and two fans collide only on a full SHA-256 collision.
 */
export async function hashFanEmail(email: string, emailPepper: string): Promise<string> {
	return hmacHex(email.trim().toLowerCase(), emailPepper);
}

/** A fan identity as callers use it (the hash rides along — it is the key BE5/FE4 consume). */
export interface FanIdentity {
	fanId: number;
	fanHash: string;
}

/**
 * Idempotent identity lookup/creation — the SAME contract as dispense.ts's
 * batch statement (`INSERT INTO fan_identities ... ON CONFLICT (email_hash) DO
 * NOTHING`), collapsed into one round trip via upsert + RETURNING (the
 * otp.ts counter precedent): either order of (verify-here, dispense-there)
 * works, and repeated calls return the SAME row. `last_seen_at` is stamped as
 * a best-effort audit signal (most recent verified sign-in); no rule reads it.
 * `created_at` is only ever set by the first insert.
 */
export async function ensureFanIdentity(deps: { db: D1Database; fanHash: string; now: Date }): Promise<FanIdentity> {
	const { db, fanHash, now } = deps;
	if (typeof fanHash !== 'string' || fanHash.length === 0) {
		// Wiring bug, not a user state — fail loudly (mirrors dispenseCode's guard).
		throw new TypeError('ensureFanIdentity: fanHash must be a non-empty string (hashFanEmail output)');
	}
	const row = await db
		.prepare(
			`INSERT INTO fan_identities (email_hash, created_at, last_seen_at) VALUES (?1, ?2, ?2)
			 ON CONFLICT (email_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
			 RETURNING id`
		)
		.bind(fanHash, toSqlUtc(now))
		.first<{ id: number }>();
	if (!row) throw new Error('ensureFanIdentity: fan_identities row missing after upsert');
	return { fanId: row.id, fanHash };
}

/** One claim as a fan-facing read renders it (never exposes fan_hash). */
export interface FanClaimView {
	claimId: number;
	projectId: number;
	/** Share slug — fan surfaces link back to the project page. */
	slug: string;
	title: string;
	artistName: string;
	codeId: number;
	/** The dispensed `xxxx-xxxx` code string — the product's payload. */
	code: string;
	/** 'original' or the one 'reissue' (BE6 flips the same claim row). */
	kind: 'original' | 'reissue';
	/**
	 * The HELD code's current status: 'claimed' = live · 'reported' = the fan
	 * reported it dead (BE6 flow; a reissue re-points code_id and this reads
	 * 'claimed' again).
	 */
	codeStatus: 'claimed' | 'reported';
	/** SQL-UTC 'YYYY-MM-DD HH:MM:SS' — first dispense. */
	claimedAt: string;
	/** SQL-UTC — set when the single reissue happened (else null). */
	reissuedAt: string | null;
}

/**
 * FE4's archive row: the claim view + the project context the my-codes page
 * renders per row. `yumUrl` is the redeem console base — FE4 appends
 * `?code={code}` CLIENT-side only (the R3 discipline: the backend never
 * fetches it); null only if the schema's NOT NULL ever relaxes. Artwork rides
 * as the BE8 tri-state so the row can render the cover or its text-card.
 */
export interface FanArchiveClaim extends FanClaimView {
	yumUrl: string | null;
	artworkUrl: string | null;
	artworkStatus: PublicArtworkStatus;
}

/**
 * The claim-row SELECT shared by both fan claim reads: the claim + its held
 * code + the joined project fields FE3/FE4 render (identity, redeem base,
 * artwork). One list, one mapper — the two reads differ only in WHERE.
 */
interface FanClaimRow {
	claim_id: number;
	project_id: number;
	slug: string;
	title: string;
	artist_name: string;
	yum_url: string;
	artwork_url: string | null;
	artwork_status: string;
	code_id: number;
	code: string;
	kind: string;
	code_status: string;
	claimed_at: string;
	reissued_at: string | null;
}

const FAN_CLAIM_SELECT = `SELECT cl.id AS claim_id, p.id AS project_id, p.slug AS slug, p.title AS title,
	p.artist_name AS artist_name, p.yum_url AS yum_url,
	p.artwork_url AS artwork_url, p.artwork_status AS artwork_status,
	cd.id AS code_id, cd.code AS code,
	cl.kind AS kind, cd.status AS code_status, cl.claimed_at AS claimed_at, cl.reissued_at AS reissued_at
 FROM claims cl
 JOIN projects p ON p.id = cl.project_id
 JOIN codes cd ON cd.id = cl.code_id`;

function mapFanClaimRow(row: FanClaimRow): FanArchiveClaim {
	return {
		claimId: row.claim_id,
		projectId: row.project_id,
		slug: row.slug,
		title: row.title,
		artistName: row.artist_name,
		yumUrl: row.yum_url,
		artworkUrl: row.artwork_url,
		artworkStatus: toArtworkStatus(row.artwork_status),
		codeId: row.code_id,
		code: row.code,
		kind: row.kind === 'reissue' ? 'reissue' : 'original',
		codeStatus: row.code_status === 'reported' ? 'reported' : 'claimed',
		claimedAt: row.claimed_at,
		reissuedAt: row.reissued_at
	};
}

/**
 * All claims for one fan across ALL projects and devices (FE4's query helper):
 * claims are keyed by fan_hash, so the email's hash — available from the fan
 * session (`getFanFromCookies`) — is the only input. Newest first (id as the
 * stable tiebreaker); joined project fields let FE4 link + label without a
 * second query. An email with no claims gets `[]` — FE4's honest empty state.
 */
export async function listFanClaims(db: D1Database, fanHash: string): Promise<FanArchiveClaim[]> {
	const rows = await db
		.prepare(`${FAN_CLAIM_SELECT} WHERE cl.fan_hash = ?1 ORDER BY cl.claimed_at DESC, cl.id DESC`)
		.bind(fanHash)
		.all<FanClaimRow>();
	return rows.results.map(mapFanClaimRow);
}

/**
 * ONE fan's claim on ONE project (FE3's SSR load and the claim endpoint's
 * response body): the base FanClaimView (a closed, test-pinned shape — the
 * archive-only artwork/yum fields belong to listFanClaims), keyed by fan_hash
 * and the project's slug or id (projectRefBinds — the one resolution helper).
 *
 * This is the revisit read: a claim read here is ALWAYS the session fan's own
 * claim (fan_hash keying), so re-showing it can never leak another fan's code.
 * codeStatus/kind/reissuedAt ride along so the slab can render the honest
 * claim states (live original · replacement reissue · reported-dead) without a
 * second query. Null = this fan holds no claim on the project.
 */
export async function fanClaimForProject(
	db: D1Database,
	fanHash: string,
	project: string | number
): Promise<FanClaimView | null> {
	const [id, slug] = projectRefBinds(project);
	const row = await db
		.prepare(`${FAN_CLAIM_SELECT} WHERE cl.fan_hash = ?1 AND ((?2 >= 0 AND p.id = ?2) OR (?3 <> '' AND p.slug = ?3))`)
		.bind(fanHash, id, slug)
		.first<FanClaimRow>();
	if (!row) return null;
	// FE3's read keeps its closed, test-pinned shape: the project context the
	// ARCHIVE renders (artwork, yum base) is FE4's extension, not the slab's.
	const { yumUrl: _yum, artworkUrl: _art, artworkStatus: _status, ...claim } = mapFanClaimRow(row);
	return claim;
}
