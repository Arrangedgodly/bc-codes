/**
 * Public fan-board read model (FE2) — the ONLY surface where unauthenticated
 * visitors read project data. Everything else project-shaped is artist-scoped
 * (BE7); this module exists so "public" never accidentally means "the artist
 * API without the auth check":
 *
 *   - The SELECT lists are closed: title, artist name, slug, artwork fields,
 *     status, and DERIVED counts only. Code strings, claim rows, fan hashes
 *     and artist emails are structurally absent — not filtered out, never
 *     selected. If a future field leaks in here, tests/public-board.test.ts
 *     pins the payload key set and the no-code-strings property.
 *   - The board lists ACTIVE + AVAILABLE projects only (plan FE2 scoping).
 *     Paused/draft projects are not listed — a fan cannot claim from them —
 *     and drained pools have nothing to give. BE5/BE6 flip a project to
 *     'drained' in the same batch as the last dispense, so an active row with
 *     zero available codes is a transient inconsistency at worst; the
 *     HAVING-available guard keeps even that off the wall (honesty beats
 *     listing: a cell the fan cannot claim from must not render).
 *   - Draft is invisible EVERYWHERE public: never listed, and
 *     getPublicProjectBySlug refuses it — a share URL must not leak an
 *     unfinished project. Paused and drained stay reachable by direct link
 *     (FE3 renders their honest states; the FE2 placeholder does too).
 *
 * Counts are derived (COUNT/SUM), same discipline as BE7: no maintained
 * counters to drift. idx_codes_project_status makes each stats join an index
 * range scan; idx_projects_status scopes the board's WHERE.
 */

import type { D1Database } from '@cloudflare/workers-types';

/** Pathological-scale guard only — scope is ~50 active projects (town hall). */
export const BOARD_LIMIT = 200;

/** Artwork tri-state exactly as BE8 writes it (migrations/0001_init.sql). */
export type PublicArtworkStatus = 'pending' | 'fetched' | 'fallback';

/** A public status: everything except draft (draft is not a shareable state). */
export type PublicProjectStatus = 'active' | 'paused' | 'drained';

/** Exported for fan-identity.ts's claim views (FE4 renders the same tri-state). */
export function toArtworkStatus(value: string): PublicArtworkStatus {
	return value === 'fetched' || value === 'fallback' ? value : 'pending';
}

function toPublicStatus(value: string): PublicProjectStatus | null {
	return value === 'active' || value === 'paused' || value === 'drained' ? value : null;
}

/**
 * One drop-cell on the fan board: everything the wall renders, nothing it
 * must not. `artworkUrl` is either our R2 route (/art/<id>, BE8 primary) or
 * an absolute CDN URL (BE8 graceful hotlink fallback) — both public.
 */
export interface PublicDrop {
	id: number;
	slug: string;
	title: string;
	artistName: string;
	artworkUrl: string | null;
	artworkStatus: PublicArtworkStatus;
	available: number;
	claimed: number;
	total: number;
	createdAt: string;
}

/** One project as a direct /p/[slug] visit may see it (board cell + status). */
export interface PublicProject extends PublicDrop {
	status: PublicProjectStatus;
	reported: number;
	/**
	 * The artist's Bandcamp album page (public URL) — FE3's warm exits link
	 * here (follow-the-artist copy on drained drops). NOT NULL in the schema;
	 * typed defensively so a future schema change degrades, never crashes.
	 */
	albumUrl: string | null;
	/**
	 * The redeem console base `https://<artist>.bandcamp.com/yum` (R3) — FE3
	 * appends `?code={code}` CLIENT-SIDE only (the backend never fetches it).
	 * Same NOT NULL / defensive typing note as albumUrl.
	 */
	yumUrl: string | null;
}

/** Derived public counts — reported is board-irrelevant but pool-honest. */
interface CountRow {
	total: number;
	available: number;
	claimed: number;
	reported: number;
}

const COUNT_COLUMNS = `COUNT(c.id) AS total,
	COALESCE(SUM(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END), 0) AS available,
	COALESCE(SUM(CASE WHEN c.status = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed,
	COALESCE(SUM(CASE WHEN c.status = 'reported' THEN 1 ELSE 0 END), 0) AS reported`;

interface PublicRow extends CountRow {
	id: number;
	slug: string;
	title: string;
	artist_name: string;
	album_url: string;
	yum_url: string;
	status: string;
	artwork_url: string | null;
	artwork_status: string;
	created_at: string;
}

/**
 * The board: active projects that still have codes to give, newest drop
 * first (the wall reads top-down as "latest launches"). One query; the
 * payload never touches code strings or claims.
 */
export async function listPublicDrops(db: D1Database): Promise<PublicDrop[]> {
	const { results } = await db
		.prepare(
			`SELECT p.id AS id, p.slug AS slug, p.title AS title, p.artist_name AS artist_name,
				p.status AS status, p.artwork_url AS artwork_url, p.artwork_status AS artwork_status,
				p.created_at AS created_at,
				${COUNT_COLUMNS}
				FROM projects p LEFT JOIN codes c ON c.project_id = p.id
				WHERE p.status = 'active'
				GROUP BY p.id
				HAVING available > 0
				ORDER BY p.created_at DESC, p.id DESC
				LIMIT ?1`
		)
		.bind(BOARD_LIMIT)
		.all<PublicRow>();
	return (results ?? []).map((row) => ({
		id: row.id,
		slug: row.slug,
		title: row.title,
		artistName: row.artist_name,
		artworkUrl: row.artwork_url,
		artworkStatus: toArtworkStatus(row.artwork_status),
		available: row.available,
		claimed: row.claimed,
		total: row.total,
		createdAt: row.created_at
	}));
}

/**
 * One project by share slug for the public project page. Draft and unknown
 * slugs are indistinguishable (both null) — an unfinished project must not
 * be confirmed to exist by its URL.
 */
export async function getPublicProjectBySlug(db: D1Database, slug: string): Promise<PublicProject | null> {
	const row = await db
		.prepare(
			`SELECT p.id AS id, p.slug AS slug, p.title AS title, p.artist_name AS artist_name,
				p.album_url AS album_url, p.yum_url AS yum_url,
				p.status AS status, p.artwork_url AS artwork_url, p.artwork_status AS artwork_status,
				p.created_at AS created_at,
				${COUNT_COLUMNS}
				FROM projects p LEFT JOIN codes c ON c.project_id = p.id
				WHERE p.slug = ?1 AND p.status != 'draft'
				GROUP BY p.id`
		)
		.bind(slug)
		.first<PublicRow>();
	if (!row) return null;
	const status = toPublicStatus(row.status);
	// The CHECK constraint makes this unreachable; the guard is for the type system.
	if (status === null) return null;
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		artistName: row.artist_name,
		status,
		artworkUrl: row.artwork_url,
		artworkStatus: toArtworkStatus(row.artwork_status),
		albumUrl: row.album_url,
		yumUrl: row.yum_url,
		available: row.available,
		claimed: row.claimed,
		reported: row.reported,
		total: row.total,
		createdAt: row.created_at
	};
}
