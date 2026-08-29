/**
 * Artist project domain (BE7) — the artist console's whole backend: create,
 * update, CSV upload, stats, list, detail.
 *
 * Status machine (draft/active/paused/drained) and who owns each edge:
 *
 *   draft ──upload codes──▶ active ◀──resume (PATCH)── paused
 *                              │                         │
 *        drained ◀──pool emptied──┘ (BE5/BE6 auto-flip,  └─pause (PATCH): active only
 *         ▲   │                 guarded from 'active')
 *         │   └─upload codes re-activates (BE5 note: the drained flip only
 *         │      fires from 'active' inside the dispense batch, so BE7 must
 *         │      own the way back)
 *         └─ report/reissue can also empty the pool (BE6's flip, same guard)
 *
 * Artist-owned edges (PATCH): active↔paused ONLY. Pausing a draft is a
 * category error (nothing to pause — 409), and both drained edges are
 * system-owned: a drained project re-activates by uploading new codes, never
 * by hand. Uploading to a PAUSED project preserves the pause — the artist
 * chose that state; only draft/drained auto-activate (they are system states,
 * not artist intent).
 *
 * Slug policy: derived from artist+title, URL-safe, globally unique via the
 * `-2`, `-3`, ... suffix. Stable once the project leaves draft EXCEPT that a
 * title or artist-name edit while STILL draft re-derives it (both feed the
 * slug; a corrected name in draft should not fossilize into the share URL).
 * The share URL path shape is FE2/FE3's call — everything they need is the
 * `slug` field on every project view.
 *
 * Upload transactionality: code inserts + the status flip run in ONE
 * db.batch (implicit transaction, R1-verified discipline), so a mid-upload
 * failure never strands codes without the flip (or vice versa). The
 * code_batches row is inserted first (codes need its id — D1 batch bindings
 * are fixed upfront, so RETURNING cannot feed later statements); if the batch
 * then fails, that row is deleted again — it can never lie about code_count.
 * The UNIQUE(project_id, code) race (two concurrent uploads of overlapping
 * CSVs) surfaces as typed `conflict` — the loser's whole batch rolled back,
 * and a plain retry is safe (dedupe then skips the winner's codes).
 *
 * Stats are derived (COUNT), never maintained counters — same reasoning as
 * BE5's projectAvailability (three writers would drift; idx_codes_project_
 * status makes each slice an index range scan).
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
	dedupeAgainstExisting,
	fetchExistingCodes,
	parseBandcampCsv,
	type InvalidLine
} from './bandcamp-csv';
import { projectReports, type ProjectReportsView } from './report';
import { toSqlUtc } from './time';

// ---------------------------------------------------------------------------
// Field normalization + validation (pure; endpoints map null → 400).
// ---------------------------------------------------------------------------

export const TITLE_MAX_CHARS = 200;
export const ARTIST_NAME_MAX_CHARS = 200;
/** Share-URL sanity: the unique-ified slug (base + up to '-2147483647') still fits any URL. */
export const SLUG_BASE_MAX_CHARS = 60;
/** CSV upload size cap (~2MB per plan) — the endpoint reads the body, this is the shared limit. */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/** Trim + bound a free-text single-line field; null when it cannot be stored. */
function normalizeLine(input: unknown, maxChars: number): string | null {
	if (typeof input !== 'string') return null;
	const trimmed = input.trim().replace(/\s+/g, ' '); // collapse internal runs
	if (trimmed.length === 0 || trimmed.length > maxChars) return null;
	return trimmed;
}

/** Project title: 1..TITLE_MAX_CHARS chars, whitespace-collapsed. */
export function normalizeTitle(input: unknown): string | null {
	return normalizeLine(input, TITLE_MAX_CHARS);
}

/** Display artist name: 1..ARTIST_NAME_MAX_CHARS chars, whitespace-collapsed. */
export function normalizeArtistName(input: unknown): string | null {
	return normalizeLine(input, ARTIST_NAME_MAX_CHARS);
}

/**
 * Bandcamp album host: one alphanumeric/hyphen label before `.bandcamp.com`.
 * `www` is rejected (it is Bandcamp's own site, never an artist page — the
 * derived yum URL would be wrong). Hyphens may not lead/trail, matching how
 * Bandcamp subdomains are actually formed.
 */
const BANDCAMP_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bandcamp\.com$/i;

/** A validated album URL plus everything derived from it. */
export interface ParsedAlbumUrl {
	/** Normalized `https://<artist>.bandcamp.com[<path>]` — query/hash stripped. */
	albumUrl: string;
	/** `https://<artist>.bandcamp.com/yum` — FE3's redeem deep-link base (R3). */
	yumUrl: string;
	/** The bandcamp subdomain (artist's label on bandcamp.com). */
	subdomain: string;
}

/**
 * Validate a Bandcamp album URL and derive the yum URL per the CSV pattern
 * (`https://<subdomain>.bandcamp.com/yum`). Accepts http(s), any path, query
 * strings and hash fragments (normalized away); rejects everything that is
 * not exactly one label under bandcamp.com.
 */
export function parseAlbumUrl(input: unknown): ParsedAlbumUrl | null {
	if (typeof input !== 'string') return null;
	const trimmed = input.trim();
	if (trimmed.length === 0 || trimmed.length > 2048) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	if (!BANDCAMP_HOST_PATTERN.test(host)) return null;
	const subdomain = host.split('.')[0]!;
	if (subdomain === 'www') return null;
	const path = url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '';
	return {
		albumUrl: `https://${host}${path}`,
		yumUrl: `https://${host}/yum`,
		subdomain
	};
}

// ---------------------------------------------------------------------------
// Slug derivation.
// ---------------------------------------------------------------------------

/**
 * URL-safe slug base from artist name + title: lowercase, diacritics folded,
 * every non-alphanumeric run collapsed to one hyphen, bounded to
 * SLUG_BASE_MAX_CHARS. Falls back to `drop` when everything strips away
 * (e.g. an all-punctuation title) — uniqueness comes from uniqueSlug.
 */
export function slugifyProject(artistName: string, title: string): string {
	const base = `${artistName} ${title}`;
	const slug = base
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '') // strip combining marks after NFKD
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SLUG_BASE_MAX_CHARS)
		.replace(/-+$/g, '');
	return slug.length > 0 ? slug : 'drop';
}

/**
 * Unique-ify a slug base against the projects table: first collision gets
 * `-2`, then `-3`, ... (spec: "-2 suffix"). `excludeProjectId` lets a draft
 * re-derivation keep its own current slug without counting it as a collision.
 */
export async function uniqueSlug(db: D1Database, base: string, excludeProjectId?: number): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? base : `${base}-${n}`;
		const row = await db.prepare('SELECT id FROM projects WHERE slug = ?1').bind(candidate).first<{ id: number }>();
		if (!row || row.id === excludeProjectId) return candidate;
	}
}

// ---------------------------------------------------------------------------
// Views.
// ---------------------------------------------------------------------------

export type ProjectStatus = 'draft' | 'active' | 'paused' | 'drained';

/** Derived code counts (the list/detail `stats` field). */
export interface ProjectStats {
	total: number;
	claimed: number;
	available: number;
	reported: number;
}

/** One project as the artist console sees it (list items AND detail heads). */
export interface ProjectSummary {
	id: number;
	title: string;
	artistName: string;
	albumUrl: string;
	slug: string;
	yumUrl: string;
	status: ProjectStatus;
	artworkUrl: string | null;
	artworkStatus: 'pending' | 'fetched' | 'fallback';
	createdAt: string;
	updatedAt: string;
	stats: ProjectStats;
}

/** A recent claim on the artist's detail view — code strings included (the artist owns their codes). */
export interface ArtistClaimEntry {
	claimId: number;
	code: string;
	kind: 'original' | 'reissue';
	claimedAt: string;
	reissuedAt: string | null;
	/** The HELD code's current status ('claimed' live / 'reported' dead-after-drained-report). */
	codeStatus: 'claimed' | 'reported';
}

/** GET /:id payload: summary + recent claims + reports (BE6 helper). */
export interface ProjectDetail extends ProjectSummary {
	recentClaims: ArtistClaimEntry[];
	reports: ProjectReportsView;
}

/** How many recent claims the detail view carries. */
export const RECENT_CLAIMS_LIMIT = 20;

interface ProjectRow {
	id: number;
	title: string;
	artist_name: string;
	album_url: string;
	slug: string;
	yum_url: string;
	status: string;
	artwork_url: string | null;
	artwork_status: string;
	created_at: string;
	updated_at: string;
}

/** Bare column list — single-table SELECT/RETURNING (INSERT/UPDATE on projects). */
const SUMMARY_COLUMNS = `id, title, artist_name, album_url, slug, yum_url, status, artwork_url, artwork_status, created_at, updated_at`;

/** Prefixed + aliased column list — join queries (projects p LEFT JOIN codes c). */
const SUMMARY_COLUMNS_JOINED = `p.id AS id, p.title AS title, p.artist_name AS artist_name, p.album_url AS album_url,
	p.slug AS slug, p.yum_url AS yum_url, p.status AS status,
	p.artwork_url AS artwork_url, p.artwork_status AS artwork_status,
	p.created_at AS created_at, p.updated_at AS updated_at`;

const STATS_COLUMNS = `COUNT(c.id) AS total,
	COALESCE(SUM(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END), 0) AS available,
	COALESCE(SUM(CASE WHEN c.status = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed,
	COALESCE(SUM(CASE WHEN c.status = 'reported' THEN 1 ELSE 0 END), 0) AS reported`;

function toStatus(value: string): ProjectStatus {
	return value === 'active' || value === 'paused' || value === 'drained' ? value : 'draft';
}

function toSummary(row: ProjectRow, stats: ProjectStats): ProjectSummary {
	return {
		id: row.id,
		title: row.title,
		artistName: row.artist_name,
		albumUrl: row.album_url,
		slug: row.slug,
		yumUrl: row.yum_url,
		status: toStatus(row.status),
		artworkUrl: row.artwork_url,
		artworkStatus: row.artwork_status === 'fetched' || row.artwork_status === 'fallback' ? row.artwork_status : 'pending',
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		stats
	};
}

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

export interface CreateProjectDeps {
	db: D1Database;
	artistId: number;
	title: string;
	artistName: string;
	albumUrl: ParsedAlbumUrl;
	now: Date;
}

/** Create a draft project (no codes yet — uploading activates). Slug is derived + unique-ified here. */
export async function createProject(deps: CreateProjectDeps): Promise<ProjectSummary> {
	const { db, artistId, albumUrl, now } = deps;
	const slug = await uniqueSlug(db, slugifyProject(deps.artistName, deps.title));
	const nowText = toSqlUtc(now);
	const row = await db
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status, created_at, updated_at)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?7) RETURNING ${SUMMARY_COLUMNS}`
		)
		.bind(artistId, deps.title, deps.artistName, albumUrl.albumUrl, slug, albumUrl.yumUrl, nowText)
		.first<ProjectRow>();
	// RETURNING of a successful INSERT always yields the row; the guard is for the type system.
	if (!row) throw new Error('createProject: INSERT ... RETURNING produced no row');
	return toSummary(row, { total: 0, claimed: 0, available: 0, reported: 0 });
}

// ---------------------------------------------------------------------------
// Update (fields + pause/resume).
// ---------------------------------------------------------------------------

/** The subset of PATCH the domain layer understands (already-validated values). */
export interface ProjectPatch {
	title?: string;
	artistName?: string;
	albumUrl?: ParsedAlbumUrl;
	/** 'paused' = pause request, 'active' = resume request. */
	requestStatus?: 'active' | 'paused';
}

export interface UpdateProjectDeps {
	db: D1Database;
	artistId: number;
	projectId: number;
	patch: ProjectPatch;
	now: Date;
}

/**
 * PATCH outcome. `albumUrlChanged` (BE8 signal) is true only when a NEW
 * album URL was applied and it actually differs from the stored one — in
 * that case this function also resets the artwork fields to the typed
 * 'pending' state (the old cover must not survive an album swap) and the
 * endpoint fires BE8's refresh hook for the new URL.
 */
export type UpdateProjectResult =
	| { ok: true; project: ProjectSummary; albumUrlChanged: boolean }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'invalid-transition'; from: ProjectStatus; to: 'active' | 'paused' };

/**
 * The pause/resume rule as data: active↔paused only. A same-state request
 * (pause an already-paused project, resume an active one) is an idempotent
 * success — double-clicks must not turn into errors. Draft and drained are
 * system-owned: draft activates by uploading codes, drained re-activates the
 * same way, so every hand-requested transition out of them is refused.
 */
function resolveStatusTransition(current: ProjectStatus, to: 'active' | 'paused'):
	| { ok: true; target: ProjectStatus | null }
	| { ok: false } {
	if (current === 'draft' || current === 'drained') return { ok: false };
	if (current === to) return { ok: true, target: null }; // idempotent no-op
	return { ok: true, target: to }; // active→paused or paused→active
}

/**
 * Apply a PATCH: field updates in any state (slug re-derived only while
 * draft), pause/resume guarded by resolveStatusTransition. Scoped to the
 * artist — someone else's project id is indistinguishable from a missing one.
 */
export async function updateProject(deps: UpdateProjectDeps): Promise<UpdateProjectResult> {
	const { db, artistId, projectId, patch, now } = deps;
	const current = await db
		.prepare(`SELECT ${SUMMARY_COLUMNS} FROM projects WHERE id = ?1 AND artist_id = ?2`)
		.bind(projectId, artistId)
		.first<ProjectRow>();
	if (!current) return { ok: false, reason: 'not-found' };

	const currentStatus = toStatus(current.status);
	let statusTarget: ProjectStatus | null = null;
	if (patch.requestStatus) {
		const transition = resolveStatusTransition(currentStatus, patch.requestStatus);
		if (!transition.ok) return { ok: false, reason: 'invalid-transition', from: currentStatus, to: patch.requestStatus };
		statusTarget = transition.target;
	}

	const title = patch.title ?? current.title;
	const artistName = patch.artistName ?? current.artist_name;
	const albumUrl = patch.albumUrl?.albumUrl ?? current.album_url;
	const yumUrl = patch.albumUrl?.yumUrl ?? current.yum_url;
	// BE8: a genuinely NEW album URL invalidates the stored artwork — reset to
	// 'pending' in the same statement (a re-send of the identical URL is a no-op).
	const albumUrlChanged = patch.albumUrl !== undefined && patch.albumUrl.albumUrl !== current.album_url;

	// Slug: stable after draft — re-derive only when an input changed while still draft.
	let slug = current.slug;
	if (currentStatus === 'draft' && (patch.title !== undefined || patch.artistName !== undefined)) {
		slug = await uniqueSlug(db, slugifyProject(artistName, title), projectId);
	}

	const row = await db
		.prepare(
			`UPDATE projects SET title = ?3, artist_name = ?4, album_url = ?5, yum_url = ?6, slug = ?7,
				status = COALESCE(?8, status),
				artwork_url = CASE WHEN ?10 = 1 THEN NULL ELSE artwork_url END,
				artwork_status = CASE WHEN ?10 = 1 THEN 'pending' ELSE artwork_status END,
				artwork_checked_at = CASE WHEN ?10 = 1 THEN NULL ELSE artwork_checked_at END,
				updated_at = ?9
				WHERE id = ?1 AND artist_id = ?2
				RETURNING ${SUMMARY_COLUMNS}`
		)
		.bind(projectId, artistId, title, artistName, albumUrl, yumUrl, slug, statusTarget, toSqlUtc(now), albumUrlChanged ? 1 : 0)
		.first<ProjectRow>();
	if (!row) return { ok: false, reason: 'not-found' };

	// The UPDATE above touched no codes; stats reflect the (unchanged) pool.
	const stats = await db
		.prepare(`SELECT ${STATS_COLUMNS} FROM codes c WHERE c.project_id = ?1`)
		.bind(projectId)
		.first<ProjectStats>();
	return { ok: true, project: toSummary(row, stats ?? { total: 0, claimed: 0, available: 0, reported: 0 }), albumUrlChanged };
}

// ---------------------------------------------------------------------------
// CSV upload → batch + codes (+ activation).
// ---------------------------------------------------------------------------

export interface UploadCodesDeps {
	db: D1Database;
	artistId: number;
	projectId: number;
	/** Whole CSV file text (the endpoint owns transport: multipart/raw + size cap). */
	csvText: string;
	/** Original filename when known (multipart); null for raw-text uploads. */
	filename: string | null;
	now: Date;
}

export type UploadResult =
	| {
			ok: true;
			batchId: number | null;
			inserted: number;
			/** Skipped: the same code appeared earlier in THIS file (BE2 within-file dedupe). */
			duplicatesInFile: string[];
			/** Skipped: already held by this project from an earlier batch (cross-batch dedupe). */
			alreadyPresent: string[];
			invalidLines: InvalidLine[];
			/** The project's status after the upload. */
			status: ProjectStatus;
			/** Album title from the CSV header block, when present (never written — FE confirms). */
			albumTitle: string | null;
			/** yum URL from the CSV header block, when present (never written — FE confirms). */
			yumUrl: string | null;
			/**
			 * Auto-fill candidates for the FE to OFFER: carried by the CSV AND
			 * different from the stored value. Empty when there is nothing to
			 * suggest; the artist's entered values are never overwritten.
			 */
			autofill: { title?: string; yumUrl?: string };
	  }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'invalid-csv'; message: string }
	| { ok: false; reason: 'conflict' };

/** Codes rows per INSERT statement: 3 bind params/row × 30 = 90 ≤ D1's 100-param limit. */
const CODES_PER_STATEMENT = 30;

/**
 * Upload one Bandcamp CSV export to a project: BE2 parse → within-file dedupe
 * (parser) → cross-batch dedupe (fetchExistingCodes + dedupeAgainstExisting,
 * the BE2-documented wiring) → ONE db.batch inserting every fresh code and the
 * status flip. Draft and drained activate; paused stays paused (artist intent);
 * active stays active. An all-duplicate upload inserts nothing and changes
 * nothing (no empty batch row).
 */
export async function uploadCodes(deps: UploadCodesDeps): Promise<UploadResult> {
	const { db, artistId, projectId, csvText, filename, now } = deps;
	const project = await db
		.prepare('SELECT id, title, yum_url, status FROM projects WHERE id = ?1 AND artist_id = ?2')
		.bind(projectId, artistId)
		.first<{ id: number; title: string; yum_url: string; status: string }>();
	if (!project) return { ok: false, reason: 'not-found' };

	const parsed = parseBandcampCsv(csvText);
	if (!parsed.ok) return { ok: false, reason: 'invalid-csv', message: parsed.error };

	const existing = await fetchExistingCodes(db, projectId);
	const { fresh, alreadyPresent } = dedupeAgainstExisting(parsed.codes, existing);

	const autofill: { title?: string; yumUrl?: string } = {};
	if (parsed.albumTitle !== null && parsed.albumTitle !== project.title) autofill.title = parsed.albumTitle;
	if (parsed.yumUrl !== null && parsed.yumUrl !== project.yum_url) autofill.yumUrl = parsed.yumUrl;

	const base = {
		duplicatesInFile: parsed.duplicates,
		alreadyPresent,
		invalidLines: parsed.invalidLines,
		albumTitle: parsed.albumTitle,
		yumUrl: parsed.yumUrl,
		autofill
	};

	if (fresh.length === 0) {
		// Nothing new: no batch row (code_count would lie), no status change.
		return { ok: true, batchId: null, inserted: 0, ...base, status: toStatus(project.status) };
	}

	// (1) batch row first — codes reference it (D1 batch bindings are fixed
	// upfront, so its RETURNING cannot feed the batch below).
	const batchRow = await db
		.prepare('INSERT INTO code_batches (project_id, filename, code_count) VALUES (?1, ?2, ?3) RETURNING id')
		.bind(projectId, filename, fresh.length)
		.first<{ id: number }>();
	if (!batchRow) throw new Error('uploadCodes: code_batches INSERT ... RETURNING produced no row');
	const batchId = batchRow.id;

	// (2) codes + status flip in ONE transaction. The flip is guarded to
	// draft/drained so a paused project keeps its artist-chosen pause.
	const statements: D1PreparedStatement[] = [];
	for (let i = 0; i < fresh.length; i += CODES_PER_STATEMENT) {
		const chunk = fresh.slice(i, i + CODES_PER_STATEMENT);
		const values = chunk.map((_, j) => `(?${j * 3 + 1}, ?${j * 3 + 2}, ?${j * 3 + 3})`).join(', ');
		statements.push(
			db.prepare(`INSERT INTO codes (project_id, batch_id, code) VALUES ${values}`).bind(
				...chunk.flatMap((code) => [projectId, batchId, code])
			)
		);
	}
	statements.push(
		db
			.prepare(`UPDATE projects SET status = 'active', updated_at = ?3 WHERE id = ?1 AND artist_id = ?2 AND status IN ('draft', 'drained')`)
			.bind(projectId, artistId, toSqlUtc(now))
	);

	try {
		await db.batch(statements);
	} catch (error) {
		// The whole batch rolled back — remove the now-lying code_batches row
		// so code_count never overstates reality, then classify.
		await db.prepare('DELETE FROM code_batches WHERE id = ?1').bind(batchId).run();
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('UNIQUE constraint failed') && message.includes('codes')) {
			// Concurrent upload of overlapping codes won the race; a retry is safe.
			return { ok: false, reason: 'conflict' };
		}
		throw error;
	}

	const statusRow = await db.prepare('SELECT status FROM projects WHERE id = ?1').bind(projectId).first<{ status: string }>();
	return {
		ok: true,
		batchId,
		inserted: fresh.length,
		...base,
		status: toStatus(statusRow?.status ?? project.status)
	};
}

// ---------------------------------------------------------------------------
// List + detail (artist-scoped reads).
// ---------------------------------------------------------------------------

/** Every project of one artist, newest first, each with derived stats. */
export async function listProjects(db: D1Database, artistId: number): Promise<ProjectSummary[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS_JOINED}, ${STATS_COLUMNS}
				FROM projects p LEFT JOIN codes c ON c.project_id = p.id
				WHERE p.artist_id = ?1
				GROUP BY p.id
				ORDER BY p.created_at DESC, p.id DESC`
		)
		.bind(artistId)
		.all<ProjectRow & ProjectStats>();
	return (results ?? []).map((row) => toSummary(row, { total: row.total, claimed: row.claimed, available: row.available, reported: row.reported }));
}

/**
 * One project's console view: summary + stats + the RECENT_CLAIMS_LIMIT most
 * recent claims (code strings shown — the artist owns their codes) + reports
 * via BE6's projectReports. Scoped to the artist; null reads as not-found.
 */
export async function projectDetail(db: D1Database, artistId: number, projectId: number): Promise<ProjectDetail | null> {
	const row = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS_JOINED}, ${STATS_COLUMNS}
				FROM projects p LEFT JOIN codes c ON c.project_id = p.id
				WHERE p.id = ?1 AND p.artist_id = ?2
				GROUP BY p.id`
		)
		.bind(projectId, artistId)
		.first<ProjectRow & ProjectStats>();
	if (!row) return null;

	const claims = await db
		.prepare(
			`SELECT cl.id AS claim_id, cl.kind AS kind, cl.claimed_at AS claimed_at, cl.reissued_at AS reissued_at,
				cd.code AS code, cd.status AS code_status
				FROM claims cl JOIN codes cd ON cd.id = cl.code_id
				WHERE cl.project_id = ?1
				ORDER BY cl.claimed_at DESC, cl.id DESC
				LIMIT ?2`
		)
		.bind(projectId, RECENT_CLAIMS_LIMIT)
		.all<{
			claim_id: number;
			kind: string;
			claimed_at: string;
			reissued_at: string | null;
			code: string;
			code_status: string;
		}>();

	const reports = await projectReports(db, projectId);

	return {
		...toSummary(row, { total: row.total, claimed: row.claimed, available: row.available, reported: row.reported }),
		recentClaims: (claims.results ?? []).map((claim) => ({
			claimId: claim.claim_id,
			code: claim.code,
			kind: claim.kind === 'reissue' ? 'reissue' : 'original',
			claimedAt: claim.claimed_at,
			reissuedAt: claim.reissued_at,
			codeStatus: claim.code_status === 'reported' ? 'reported' : 'claimed'
		})),
		reports: reports ?? { projectId, reportCount: 0, reports: [] }
	};
}
