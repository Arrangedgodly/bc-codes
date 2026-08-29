/**
 * og:image artwork fetcher (BE8) — pulls each project's album cover off its
 * Bandcamp album page and lands it in one of exactly three stable states
 * (projects.artwork_status, migrations/0001_init.sql):
 *
 *   'pending'  — nothing tried yet (schema default; also re-set synchronously
 *                by BE7's updateProject the moment the album URL changes, so
 *                the FE never shows art that belongs to the previous album).
 *   'fetched'  — artwork_url is usable by the FE.
 *   'fallback' — typed empty state: artwork_url NULL, FE renders the
 *                text-card fallback. Set on EVERY failure mode below.
 *
 * Storage decision (task's (a) vs (b), justified): (b) R2-backed copy under
 * the ART binding as the primary path — we re-fetch the og:image bytes once,
 * cap them (≤2MB, jpg/png/webp verified by magic bytes, not by trusting the
 * response header), store them at `artwork/<projectId>` with the content type
 * in R2 httpMetadata, and point projects.artwork_url at OUR serve route
 * (/art/<projectId>, long cache headers, content-type from metadata). This
 * removes the classic hotlink fragilities: Bandcamp can rotate CDN hosts or
 * add hotlink protection, artists can swap cover art out from under a stored
 * URL, and hotlinking leaks every fan's IP/request to a third party while
 * giving us zero cache control. (a) URL-only (artwork_url = the bcbits URL,
 * status still 'fetched') survives as the GRACEFUL fallback when the R2
 * write itself is unavailable (binding absent) or fails — the image was
 * verified to exist and pass the caps, so hotlinking it is strictly better
 * than the text card. Every decision point logs which branch it took.
 *
 * Failure NEVER propagates: any fetch error, non-200, missing meta, invalid
 * URL, oversize or wrong-type image writes the typed empty state and returns
 * a typed result — refreshProjectArtwork cannot reject for network/parse
 * reasons, and fireArtworkRefresh (the create/PATCH hook) catch-alls even
 * unexpected crashes so project creation/upload is NEVER blocked by artwork.
 *
 * Parsing: a narrow regex/meta-tag scanner — no DOM dependency (Workers has
 * none). The album page is read as a capped prefix (first PAGE_MAX_BYTES;
 * og:image lives in <head>, far inside it), then <meta> tags are split out
 * and their attributes parsed pairwise. og:image wins, twitter:image and
 * <link rel="image_src"> are fallbacks, mirroring how Bandcamp pages carry
 * the cover.
 *
 * Subrequest budget: at most 2 outbound fetches (page + image) plus one R2
 * put — noise against the Workers 50-subrequest/request cap; the image fetch
 * only ever happens after a successful page parse, never speculatively.
 * Per-fetch timeout ~5s (FETCH_TIMEOUT_MS) bounds the whole refresh well
 * under a request lifetime even when awaited (the manual refresh endpoint).
 *
 * Trigger model: Workers has no background tasks without queues, so the
 * create/PATCH hooks defer via the execution context's waitUntil (the
 * platform's blessed fire-and-forget — the refresh keeps running after the
 * response is sent). Where no execution context exists (unit-test events,
 * exotic harnesses) the refresh is SKIPPED with a log line rather than fired
 * detached — a promise with no lifetime guarantee could die mid-write or hit
 * the network when a test never asked for it; POST /api/artist/projects/:id/
 * refresh-artwork is the always-available manual surface in those setups.
 * R3 note: the album page fetch is the ALBUM URL (artist-supplied), never a
 * /yum?code=<real> URL — the backend never fetches anything that could
 * consume a code.
 */

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { toSqlUtc } from './time';

/** Album-page prefix we are willing to buffer and scan (og:image is in <head>). */
export const PAGE_MAX_BYTES = 256 * 1024;
/** Image cache cap per plan: ≤2MB, jpg/png/webp only. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Tight per-fetch timeout (~5s per plan) so hooks never tail a request long. */
export const FETCH_TIMEOUT_MS = 5000;

/**
 * Header set for the outbound album-page/image fetches. Bandcamp serves
 * UA-less requests (what a bare Workers fetch sends) a page with no cover
 * meta — observed live 2026-08-29: fallback (no-image-meta) from the Worker
 * while the same URL returns og:image to any browser-identified client.
 * Identifying as a mainstream browser is the standard og:image-fetcher
 * convention (link-preview services do exactly this); volume stays trivial
 * (2 subrequests per project create/refresh, artist-initiated).
 */
const BROWSER_FETCH_HEADERS: Record<string, string> = {
	accept: 'text/html,application/xhtml+xml',
	'accept-language': 'en',
	'user-agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

/** Minimal logger so endpoints/tests can observe (or silence) branch choices. */
export type LogFn = (message: string, data?: unknown) => void;

const defaultLog: LogFn = (message, data) => {
	if (data === undefined) console.log(message);
	else console.log(message, data);
};

/**
 * The fetch used by refresh when no explicit fetchImpl is passed. Module-level
 * indirection (defaulting to the Workers global fetch) exists so the
 * create/PATCH endpoint hooks — which cannot take a fetch parameter — are
 * testable without any request leaving the process; tests swap it via
 * setArtworkFetchForTesting and MUST restore with null. Production code never
 * touches the setter.
 */
let artworkFetch: typeof fetch = fetch;

/** Test-only fetch override (null restores the Workers global). */
export function setArtworkFetchForTesting(impl: typeof fetch | null): void {
	artworkFetch = impl ?? fetch;
}

/** R2 object key for a project's artwork (constant — refreshes overwrite in place). */
export function artworkR2Key(projectId: number): string {
	return `artwork/${projectId}`;
}

/** FE-facing path served by src/routes/art/[projectId]/+server.ts. */
export function artworkPath(projectId: number): string {
	return `/art/${projectId}`;
}

// ---------------------------------------------------------------------------
// Narrow meta extraction (pure).
// ---------------------------------------------------------------------------

/** Every <meta ...> tag in the scanned prefix, case-insensitively. */
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
/** One `name="value"` attribute (double- or single-quoted) inside a tag. */
const ATTRIBUTE_PATTERN = /([a-z_][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** Bandcamp's legacy cover carrier, kept as the last-resort fallback. */
const LINK_IMAGE_SRC_PATTERN = /<link\b[^>]*\brel\s*=\s*(?:"image_src"|'image_src')[^>]*>/i;

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'"
};

/** Decode the handful of entities that can legally appear inside a meta URL. */
function decodeHtmlEntities(text: string): string {
	return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (match, hex?: string, dec?: string, name?: string) => {
		if (hex) return String.fromCodePoint(parseInt(hex, 16));
		if (dec) return String.fromCodePoint(parseInt(dec, 10));
		return NAMED_ENTITIES[name?.toLowerCase() ?? ''] ?? match;
	});
}

/** Attribute map of one tag (values entity-decoded, names lowercased). */
function tagAttributes(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
		const name = match[1]!.toLowerCase();
		if (!(name in attrs)) attrs[name] = decodeHtmlEntities(match[2] ?? match[3] ?? '');
	}
	return attrs;
}

/**
 * The album's cover URL from a page (prefix): og:image, else twitter:image
 * (or twitter:image:src), else <link rel="image_src"> href. First match per
 * key wins; NULL when the prefix carries no cover meta at all.
 */
export function extractAlbumArtworkUrl(html: string): string | null {
	let og: string | null = null;
	let twitter: string | null = null;
	for (const match of html.matchAll(META_TAG_PATTERN)) {
		if (og && twitter) break;
		const attrs = tagAttributes(match[0]);
		const key = attrs.property ?? attrs.name;
		const content = attrs.content;
		if (!key || !content) continue;
		if (!og && key === 'og:image') og = content;
		else if (!twitter && (key === 'twitter:image' || key === 'twitter:image:src')) twitter = content;
	}
	if (og) return og;
	if (twitter) return twitter;
	const link = LINK_IMAGE_SRC_PATTERN.exec(html);
	const href = link ? tagAttributes(link[0]).href : undefined;
	return href ?? null;
}

/**
 * A usable artwork URL: absolute https, no credentials, bounded length.
 * Protocol-relative, data:, and everything else are rejected — we re-fetch
 * the image, and the FE loads it from our own https origin.
 */
export function parseArtworkImageUrl(input: string): URL | null {
	if (input.length === 0 || input.length > 2048) return null;
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	if (url.username || url.password) return null;
	return url;
}

// ---------------------------------------------------------------------------
// Capped response reads + type sniffing.
// ---------------------------------------------------------------------------

/** A response body read with a byte ceiling. */
interface CappedBody {
	bytes: Uint8Array;
	/** True when the stream held MORE than maxBytes (we stopped early). */
	truncated: boolean;
}

/**
 * Stream a response body with a byte ceiling, stopping (and cancelling) as
 * soon as the cap is crossed — the caller decides whether a truncated read
 * is usable (page prefix: yes) or fatal (image: oversize).
 */
async function readCapped(response: Response, maxBytes: number): Promise<CappedBody> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(0), truncated: false };

	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
			if (total > maxBytes) {
				truncated = true;
				break;
			}
		}
	} finally {
		// Release the stream whether we drained it or abandoned it early.
		await reader.cancel().catch(() => {});
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

/** The only image types we cache, identified by magic bytes (never by header). */
export type ArtworkContentType = 'image/jpeg' | 'image/png' | 'image/webp';

export function sniffImageType(bytes: Uint8Array): ArtworkContentType | null {
	/** bytes[byteOffset + i] === signature[i] for every i. */
	const is = (byteOffset: number, ...signature: number[]) =>
		signature.every((byte, i) => bytes[byteOffset + i] === byte);
	if (bytes.length >= 3 && is(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (bytes.length >= 8 && is(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x8a)) return 'image/png';
	if (bytes.length >= 12 && is(0, 0x52, 0x49, 0x46, 0x46) && is(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'; // RIFF….WEBP
	return null;
}

// ---------------------------------------------------------------------------
// Refresh.
// ---------------------------------------------------------------------------

/** Why the typed empty state was written (mirrors the module header's list). */
export type ArtworkFallbackReason =
	| 'page-fetch-failed' // network error / timeout / aborted album-page fetch
	| 'page-status' // album page answered non-200
	| 'no-image-meta' // prefix carried no og:image / twitter:image / image_src
	| 'invalid-image-url' // meta value was not an absolute https URL
	| 'image-fetch-failed' // network error / timeout on the image itself
	| 'image-status' // image answered non-200
	| 'oversize' // > IMAGE_MAX_BYTES (content-length or capped read)
	| 'unsupported-type'; // magic bytes are not jpg/png/webp

export type ArtworkRefreshResult =
	| { ok: true; artworkStatus: 'fetched'; source: 'r2' | 'cdn'; artworkUrl: string }
	| { ok: true; artworkStatus: 'fallback'; reason: ArtworkFallbackReason }
	| { ok: false; reason: 'not-found' };

export interface RefreshArtworkDeps {
	db: D1Database;
	/** R2 binding ART; null switches the success path to the CDN-hotlink fallback. */
	art: R2Bucket | null;
	artistId: number;
	projectId: number;
	/** Normalized album page URL (BE7's parseAlbumUrl output shape). */
	albumUrl: string;
	now: Date;
	/** Fetch override (tests / callers with a scoped transport). */
	fetchImpl?: typeof fetch;
	/** Per-fetch timeout override; defaults to FETCH_TIMEOUT_MS (~5s). */
	timeoutMs?: number;
	log?: LogFn;
}

/** Persist one terminal artwork state (the single write path — same shape for every branch). */
async function writeArtwork(
	db: D1Database,
	artistId: number,
	projectId: number,
	artworkUrl: string | null,
	artworkStatus: 'fetched' | 'fallback',
	now: Date
): Promise<void> {
	await db
		.prepare('UPDATE projects SET artwork_url = ?3, artwork_status = ?4, artwork_checked_at = ?5 WHERE id = ?1 AND artist_id = ?2')
		.bind(projectId, artistId, artworkUrl, artworkStatus, toSqlUtc(now))
		.run();
}

/**
 * Fetch + store one project's artwork. NEVER throws for network/parse/cap
 * reasons — every failure lands the typed empty state and a typed result.
 * (An actual DB failure still rejects; callers that must not fail wrap in
 * fireArtworkRefresh.)
 */
export async function refreshProjectArtwork(deps: RefreshArtworkDeps): Promise<ArtworkRefreshResult> {
	const { db, art, artistId, projectId, albumUrl, now } = deps;
	const fetchImpl = deps.fetchImpl ?? artworkFetch;
	const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
	const log = deps.log ?? defaultLog;
	const signal = () => AbortSignal.timeout(timeoutMs);

	const owned = await db
		.prepare('SELECT id FROM projects WHERE id = ?1 AND artist_id = ?2')
		.bind(projectId, artistId)
		.first<{ id: number }>();
	if (!owned) return { ok: false, reason: 'not-found' };

	const fallback = async (reason: ArtworkFallbackReason): Promise<ArtworkRefreshResult> => {
		log(`artwork[${projectId}]: fallback (${reason})`);
		await writeArtwork(db, artistId, projectId, null, 'fallback', now);
		return { ok: true, artworkStatus: 'fallback', reason };
	};

	// (1) The album page — capped prefix read; meta tags live in <head>.
	let page: Response;
	try {
		page = await fetchImpl(albumUrl, { redirect: 'follow', signal: signal(), headers: BROWSER_FETCH_HEADERS });
	} catch (error) {
		log(`artwork[${projectId}]: album page fetch failed`, error);
		return fallback('page-fetch-failed');
	}
	if (!page.ok) {
		log(`artwork[${projectId}]: album page status ${page.status}`);
		return fallback('page-status');
	}
	let pageHtml: string;
	try {
		const { bytes } = await readCapped(page, PAGE_MAX_BYTES);
		pageHtml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	} catch (error) {
		log(`artwork[${projectId}]: album page read failed`, error);
		return fallback('page-fetch-failed');
	}

	// (2) The cover URL out of the prefix.
	const rawUrl = extractAlbumArtworkUrl(pageHtml);
	if (!rawUrl) return fallback('no-image-meta');
	const imageUrl = parseArtworkImageUrl(rawUrl);
	if (!imageUrl) return fallback('invalid-image-url');

	// (3) The image — strict caps this time (truncation is fatal, type is sniffed).
	let image: Response;
	try {
		image = await fetchImpl(imageUrl.href, {
			redirect: 'follow',
			signal: signal(),
			headers: { ...BROWSER_FETCH_HEADERS, accept: 'image/*' }
		});
	} catch (error) {
		log(`artwork[${projectId}]: image fetch failed`, error);
		return fallback('image-fetch-failed');
	}
	if (!image.ok) {
		log(`artwork[${projectId}]: image status ${image.status}`);
		return fallback('image-status');
	}
	const declaredLength = Number(image.headers.get('content-length') ?? '');
	if (Number.isFinite(declaredLength) && declaredLength > IMAGE_MAX_BYTES) return fallback('oversize');
	let imageBytes: Uint8Array;
	let truncated: boolean;
	try {
		const read = await readCapped(image, IMAGE_MAX_BYTES);
		imageBytes = read.bytes;
		truncated = read.truncated;
	} catch (error) {
		log(`artwork[${projectId}]: image read failed`, error);
		return fallback('image-fetch-failed');
	}
	if (truncated) return fallback('oversize');
	const contentType = sniffImageType(imageBytes);
	if (!contentType) return fallback('unsupported-type');

	// (4) R2 primary, CDN-hotlink graceful fallback (see the module header).
	if (!art) {
		log(`artwork[${projectId}]: fetched (cdn hotlink — R2 binding absent)`);
		await writeArtwork(db, artistId, projectId, imageUrl.href, 'fetched', now);
		return { ok: true, artworkStatus: 'fetched', source: 'cdn', artworkUrl: imageUrl.href };
	}
	try {
		await art.put(artworkR2Key(projectId), imageBytes, { httpMetadata: { contentType } });
	} catch (error) {
		log(`artwork[${projectId}]: R2 put failed — hotlinking the verified CDN URL instead`, error);
		await writeArtwork(db, artistId, projectId, imageUrl.href, 'fetched', now);
		return { ok: true, artworkStatus: 'fetched', source: 'cdn', artworkUrl: imageUrl.href };
	}
	log(`artwork[${projectId}]: fetched (r2, ${contentType}, ${imageBytes.byteLength}B)`);
	await writeArtwork(db, artistId, projectId, artworkPath(projectId), 'fetched', now);
	return { ok: true, artworkStatus: 'fetched', source: 'r2', artworkUrl: artworkPath(projectId) };
}

// ---------------------------------------------------------------------------
// Fire-and-forget hook (create / album-URL change).
// ---------------------------------------------------------------------------

export interface FireArtworkRefreshDeps extends RefreshArtworkDeps {
	/**
	 * Workers execution context (event.platform.ctx) — its waitUntil carries
	 * the refresh past the response. Absent ⇒ the refresh is skipped with a
	 * log (see the module header for why a detached promise is not fired).
	 */
	context?: { waitUntil(promise: Promise<unknown>): void } | null;
}

/**
 * Enqueue the refresh for after the response: waitUntil when the platform
 * gave us a context, skip (loudly) otherwise, and catch-all so NOTHING here
 * can ever fail the create/PATCH that triggered it.
 */
export function fireArtworkRefresh(deps: FireArtworkRefreshDeps): void {
	const log = deps.log ?? defaultLog;
	const waitUntil = deps.context?.waitUntil?.bind(deps.context);
	if (!waitUntil) {
		log(`artwork[${deps.projectId}]: no execution context — refresh skipped (POST /api/artist/projects/${deps.projectId}/refresh-artwork re-runs it)`);
		return;
	}
	const run = refreshProjectArtwork(deps).catch((error) => {
		// refreshProjectArtwork only rejects on infrastructure faults (DB); the
		// artwork contract is "never block the caller" — swallow + log.
		log(`artwork[${deps.projectId}]: refresh crashed — project state otherwise untouched`, error);
	});
	waitUntil(run);
}
