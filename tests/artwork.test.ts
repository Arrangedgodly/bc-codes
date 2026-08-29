/**
 * Artwork tests (BE8) — og:image extraction (pure, against a real-shaped
 * Bandcamp album page fixture), the refresh pipeline (real D1 + the REAL
 * local R2 binding from wrangler.jsonc, with fetch stubbed at the module
 * boundary so no request ever leaves the process), the R2 serve route, the
 * manual refresh endpoint, and the create/PATCH fire-and-forget hooks.
 *
 * Storage-branch coverage (task scope): R2 primary (content-type stored from
 * the magic-byte sniff, served back with long cache headers), CDN-hotlink
 * graceful fallback (binding absent / put throws), and the typed empty state
 * for every failure mode: missing meta, 404s, timeout, oversize, wrong type,
 * invalid URL — each landing artwork_status='fallback' with artwork_url NULL.
 * Plus the contract that trumps all: artwork NEVER blocks project creation.
 */

import { env as bindings } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import bandcampAlbumHtml from './fixtures/bandcamp-album.html?raw';
import {
	IMAGE_MAX_BYTES,
	extractAlbumArtworkUrl,
	fireArtworkRefresh,
	parseArtworkImageUrl,
	refreshProjectArtwork,
	setArtworkFetchForTesting,
	sniffImageType
} from '../src/lib/server/artwork';
import * as collection from '../src/routes/api/artist/projects/+server';
import * as item from '../src/routes/api/artist/projects/[id]/+server';
import * as refreshEndpoint from '../src/routes/api/artist/projects/[id]/refresh-artwork/+server';
import * as artRoute from '../src/routes/art/[projectId]/+server';
import { ARTIST_SESSION_COOKIE, artistSessionCookieOptions, issueArtistSession } from '../src/lib/server/artist-session';

const SESSION_SECRET = 'test-session-secret';
const NOW = new Date('2026-08-28T12:00:00Z');
const NOW_TEXT = '2026-08-28 12:00:00';

// --- fetch stubbing ---------------------------------------------------------

interface CapturedRequest {
	url: string;
	init: RequestInit | undefined;
}

/** Recording fetch stub routing by URL prefix → response factory. */
function routingFetch(routes: { match: (url: string) => boolean; respond: (url: string, init?: RequestInit) => Response }[]) {
	const seen: CapturedRequest[] = [];
	const impl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		seen.push({ url, init });
		const route = routes.find((r) => r.match(url));
		if (!route) return new Response('not found', { status: 404 });
		return route.respond(url, init);
	};
	return { fetch: impl, seen };
}

const htmlPage = (html: string) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
const imageResponse = (bytes: Uint8Array<ArrayBuffer>, contentType = 'image/png') =>
	new Response(bytes, { status: 200, headers: { 'content-type': contentType } });

/** Minimal valid-ish image bodies (magic bytes + payload). */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x8a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4]);

/** A page whose og:image points at the given CDN URL. */
const pageWithOgImage = (imageUrl: string) =>
	htmlPage(`<!DOCTYPE html><html><head><title>X</title><meta property="og:image" content="${imageUrl}"></head><body></body></html>`);

// --- event scaffolding (artist-projects.test.ts's pattern, + ctx + art) -----

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

type AnyHandler = (event: RequestEvent) => Promise<Response>;
const HANDLERS: Record<string, Record<string, AnyHandler>> = {
	'/api/artist/projects': { POST: collection.POST as AnyHandler },
	'/api/artist/projects/:id': { PATCH: item.PATCH as AnyHandler },
	'/api/artist/projects/:id/refresh-artwork': { POST: refreshEndpoint.POST as AnyHandler },
	'/art/:id': { GET: artRoute.GET as AnyHandler }
};

interface CallOptions {
	params?: Record<string, string>;
	jar?: CookieJar;
	json?: unknown;
	/** R2 binding the endpoint sees: real local ART, null, or a mock. */
	art?: R2Bucket | null;
	/** Execution context — captures waitUntil promises so tests can await them. */
	captured?: Promise<unknown>[];
}

function makeEvent(method: string, path: string, opts: CallOptions): RequestEvent {
	let body: BodyInit | null = null;
	if (opts.json !== undefined) body = JSON.stringify(opts.json);
	const captured = opts.captured;
	return {
		request: new Request(`http://app.test${path}`, { method, body, headers: { 'content-type': 'application/json' } }),
		url: new URL(`http://app.test${path}`),
		params: opts.params ?? {},
		cookies: (opts.jar ?? new CookieJar()).cookies,
		getClientAddress: () => '192.0.2.9',
		platform: {
			env: {
				DB: bindings.DB,
				ART: opts.art === undefined ? null : opts.art,
				SESSION_SECRET,
				EMAIL_PEPPER: 'test-email-pepper',
				OTP_PEPPER: 'test-otp-pepper',
				MAILER_DRIVER: 'console'
			},
			ctx: captured ? { waitUntil: (p: Promise<unknown>) => void captured.push(p) } : undefined
		}
	} as unknown as RequestEvent;
}

/** Fire one endpoint and parse its JSON body; returns [response, parsed body]. */
async function call(method: string, path: string, opts: CallOptions = {}) {
	const response = await HANDLERS[path]![method]!(makeEvent(method, path, opts));
	return [response, ((await response.json().catch(() => null)) as unknown)] as const;
}

/** Fire one endpoint WITHOUT touching the body (binary responses). */
async function callRaw(method: string, path: string, opts: CallOptions = {}) {
	return HANDLERS[path]![method]!(makeEvent(method, path, opts));
}

// --- fixtures ----------------------------------------------------------------

let seq = 0;
const uid = () => ++seq;

async function signIn() {
	const n = uid();
	const email = `artist-art-${n}@example.test`;
	await bindings.DB.prepare('INSERT INTO artists (email) VALUES (?1)').bind(email).run();
	const artist = await bindings.DB.prepare('SELECT id FROM artists WHERE email = ?1').bind(email).first<{ id: number }>();
	const session = await issueArtistSession({ db: bindings.DB, artistId: artist!.id, secret: SESSION_SECRET, now: new Date() });
	const jar = new CookieJar();
	jar.cookies.set(ARTIST_SESSION_COOKIE, session.cookieValue, artistSessionCookieOptions(true));
	return { artistId: artist!.id, jar, n };
}

/** A project row straight into D1 (module-level refresh tests don't need the API). */
async function makeProject(albumUrl: string): Promise<{ projectId: number; artistId: number }> {
	const { artistId } = await signIn();
	const n = uid();
	const row = await bindings.DB
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status, created_at, updated_at)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?7) RETURNING id`
		)
		.bind(artistId, `Album ${n}`, `Artist ${n}`, albumUrl, `art-test-${n}-${Date.now()}`, 'https://x.bandcamp.com/yum', NOW_TEXT)
		.first<{ id: number }>();
	return { projectId: row!.id, artistId };
}

async function artworkRow(projectId: number) {
	return bindings.DB
		.prepare('SELECT artwork_url, artwork_status, artwork_checked_at FROM projects WHERE id = ?1')
		.bind(projectId)
		.first<{ artwork_url: string | null; artwork_status: string; artwork_checked_at: string | null }>();
}

afterEach(() => {
	setArtworkFetchForTesting(null);
});

// ---------------------------------------------------------------------------
// Pure extraction + sniffing.
// ---------------------------------------------------------------------------

describe('extractAlbumArtworkUrl — real-shaped Bandcamp album page', () => {
	it('finds og:image in the fixture (before twitter/link carriers)', () => {
		expect(extractAlbumArtworkUrl(bandcampAlbumHtml)).toBe('https://f4.bcbits.com/img/a0012345678_10.jpg');
	});

	it('accepts swapped attribute order, single quotes, and decodes entities', () => {
		expect(extractAlbumArtworkUrl('<meta content="https://f4.bcbits.com/img/a1_10.jpg" property="og:image">')).toBe(
			'https://f4.bcbits.com/img/a1_10.jpg'
		);
		expect(extractAlbumArtworkUrl("<meta property='og:image' content='https://f4.bcbits.com/img/a2_10.jpg?x=1&amp;y=2'>")).toBe(
			'https://f4.bcbits.com/img/a2_10.jpg?x=1&y=2'
		);
	});

	it('falls back to twitter:image, then link rel=image_src, then nothing', () => {
		expect(extractAlbumArtworkUrl('<meta name="twitter:image" content="https://t4.bcbits.com/card.png">')).toBe(
			'https://t4.bcbits.com/card.png'
		);
		expect(extractAlbumArtworkUrl('<meta name="twitter:image:src" content="https://t4.bcbits.com/card2.png">')).toBe(
			'https://t4.bcbits.com/card2.png'
		);
		expect(extractAlbumArtworkUrl('<link rel="image_src" href="https://f4.bcbits.com/img/a3_10.jpg">')).toBe(
			'https://f4.bcbits.com/img/a3_10.jpg'
		);
		expect(extractAlbumArtworkUrl('<html><head><title>no carriers</title></head></html>')).toBeNull();
	});

	it('rejects non-https, non-absolute, and oversized og:image values at URL parse', () => {
		expect(parseArtworkImageUrl('http://f4.bcbits.com/img/a1.jpg')).toBeNull();
		expect(parseArtworkImageUrl('data:image/png;base64,AAAA')).toBeNull();
		expect(parseArtworkImageUrl('//f4.bcbits.com/img/a1.jpg')).toBeNull();
		expect(parseArtworkImageUrl('not a url')).toBeNull();
		expect(parseArtworkImageUrl('https://x/' + 'a'.repeat(2048))).toBeNull();
		expect(parseArtworkImageUrl('https://user:pass@f4.bcbits.com/img/a1.jpg')).toBeNull();
		expect(parseArtworkImageUrl('https://f4.bcbits.com/img/a1.jpg')!.href).toBe('https://f4.bcbits.com/img/a1.jpg');
	});
});

describe('sniffImageType — magic bytes only', () => {
	it('identifies exactly jpeg/png/webp and nothing else', () => {
		expect(sniffImageType(PNG_BYTES)).toBe('image/png');
		expect(sniffImageType(JPEG_BYTES)).toBe('image/jpeg');
		expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1]))).toBe('image/webp');
		expect(sniffImageType(GIF_BYTES)).toBeNull();
		expect(sniffImageType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
		expect(sniffImageType(new Uint8Array(0))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The refresh pipeline against real D1 (+ real local R2 where noted).
// ---------------------------------------------------------------------------

/** Stub fetch serving the fixture page + a PNG at the fixture's og:image URL. */
function happyPathFetch() {
	return routingFetch([
		{ match: (u) => u.includes('bandcamp.com/album/'), respond: () => htmlPage(bandcampAlbumHtml) },
		{ match: (u) => u.includes('bcbits.com/img/'), respond: () => imageResponse(PNG_BYTES) }
	]);
}

describe('refreshProjectArtwork — R2 primary path (real local R2)', () => {
	it('caches the og:image under artwork/<id> with the sniffed content type, points artwork_url at /art/:id', async () => {
		const { projectId, artistId } = await makeProject('https://arrangedgodly.bandcamp.com/album/taxed-tolled-eternally-trolled');
		const stub = happyPathFetch();

		const result = await refreshProjectArtwork({
			db: bindings.DB,
			art: bindings.ART,
			artistId,
			projectId,
			albumUrl: 'https://arrangedgodly.bandcamp.com/album/taxed-tolled-eternally-trolled',
			now: NOW,
			fetchImpl: stub.fetch,
			log: () => {}
		});

		expect(result).toEqual({ ok: true, artworkStatus: 'fetched', source: 'r2', artworkUrl: `/art/${projectId}` });
		expect(await artworkRow(projectId)).toEqual({
			artwork_url: `/art/${projectId}`,
			artwork_status: 'fetched',
			artwork_checked_at: NOW_TEXT
		});
		// R2: bytes + content type stored (NOT the stub's declared header for its own sake).
		const stored = await bindings.ART.get(`artwork/${projectId}`);
		expect(stored).not.toBeNull();
		expect(stored!.httpMetadata?.contentType).toBe('image/png');
		expect(new Uint8Array(await new Response(stored!.body as unknown as BodyInit).arrayBuffer())).toEqual(PNG_BYTES);

		// Exactly two outbound requests: album page, then the image.
		expect(stub.seen.map((r) => new URL(r.url).host)).toEqual(['arrangedgodly.bandcamp.com', 'f4.bcbits.com']);
	});

	it('stores jpeg content type for a jpeg body regardless of the response header', async () => {
		const { projectId, artistId } = await makeProject('https://j.bandcamp.com/album/j');
		await refreshProjectArtwork({
			db: bindings.DB,
			art: bindings.ART,
			artistId,
			projectId,
			albumUrl: 'https://j.bandcamp.com/album/j',
			now: NOW,
			fetchImpl: routingFetch([
				{ match: (u) => u.includes('bandcamp.com'), respond: () => pageWithOgImage('https://f4.bcbits.com/img/big_10.jpg') },
				{ match: (u) => u.includes('bcbits.com'), respond: () => imageResponse(JPEG_BYTES, 'application/octet-stream') }
			]).fetch,
			log: () => {}
		});
		const stored = await bindings.ART.head(`artwork/${projectId}`);
		expect(stored?.httpMetadata?.contentType).toBe('image/jpeg');
	});
});

describe('refreshProjectArtwork — CDN-hotlink graceful fallback', () => {
	it('stores the verified og:image URL when the R2 binding is absent', async () => {
		const { projectId, artistId } = await makeProject('https://n.bandcamp.com/album/n');
		const result = await refreshProjectArtwork({
			db: bindings.DB,
			art: null,
			artistId,
			projectId,
			albumUrl: 'https://n.bandcamp.com/album/n',
			now: NOW,
			fetchImpl: happyPathFetch().fetch,
			log: () => {}
		});
		expect(result).toEqual({ ok: true, artworkStatus: 'fetched', source: 'cdn', artworkUrl: 'https://f4.bcbits.com/img/a0012345678_10.jpg' });
		expect(await artworkRow(projectId)).toMatchObject({ artwork_url: 'https://f4.bcbits.com/img/a0012345678_10.jpg', artwork_status: 'fetched' });
	});

	it('hotlinks instead of failing when the R2 put throws', async () => {
		const { projectId, artistId } = await makeProject('https://p.bandcamp.com/album/p');
		const throwingArt = {
			put: async () => {
				throw new Error('R2 is down');
			}
		} as unknown as R2Bucket;
		const result = await refreshProjectArtwork({
			db: bindings.DB,
			art: throwingArt,
			artistId,
			projectId,
			albumUrl: 'https://p.bandcamp.com/album/p',
			now: NOW,
			fetchImpl: happyPathFetch().fetch,
			log: () => {}
		});
		expect(result).toEqual({ ok: true, artworkStatus: 'fetched', source: 'cdn', artworkUrl: 'https://f4.bcbits.com/img/a0012345678_10.jpg' });
	});
});

describe('refreshProjectArtwork — typed empty state on every failure', () => {
	async function expectFallback(
		opts: { albumUrl?: string; respond: (url: string) => Response | Promise<Response>; timeoutMs?: number },
		reason: string
	) {
		const albumUrl = opts.albumUrl ?? 'https://f.bandcamp.com/album/f';
		const { projectId, artistId } = await makeProject(albumUrl);
		const result = await refreshProjectArtwork({
			db: bindings.DB,
			art: bindings.ART,
			artistId,
			projectId,
			albumUrl,
			now: NOW,
			fetchImpl: (async (input: RequestInfo | URL) => opts.respond(String(input))) as typeof fetch,
			timeoutMs: opts.timeoutMs,
			log: () => {}
		});
		expect(result, reason).toEqual({ ok: true, artworkStatus: 'fallback', reason });
		// The typed empty state: NULL url, 'fallback' status, checked-at stamped.
		expect(await artworkRow(projectId)).toEqual({ artwork_url: null, artwork_status: 'fallback', artwork_checked_at: NOW_TEXT });
		// And nothing leaked into R2.
		expect(await bindings.ART.get(`artwork/${projectId}`)).toBeNull();
	}

	it('page fetch error', async () => {
		await expectFallback(
			{ respond: () => Promise.reject(new TypeError('fetch failed')) },
			'page-fetch-failed'
		);
	});

	it('page 404', async () => {
		await expectFallback({ respond: () => new Response('gone', { status: 404 }) }, 'page-status');
	});

	it('timeout (abort signal fires)', async () => {
		const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
			})) as typeof fetch;
		const { projectId, artistId } = await makeProject('https://slow.bandcamp.com/album/s');
		const result = await refreshProjectArtwork({
			db: bindings.DB,
			art: bindings.ART,
			artistId,
			projectId,
			albumUrl: 'https://slow.bandcamp.com/album/s',
			now: NOW,
			fetchImpl: hanging,
			timeoutMs: 25,
			log: () => {}
		});
		expect(result).toEqual({ ok: true, artworkStatus: 'fallback', reason: 'page-fetch-failed' });
	});

	it('no cover meta on the page', async () => {
		await expectFallback({ respond: () => htmlPage('<html><head><title>empty</title></head></html>') }, 'no-image-meta');
	});

	it('og:image value is not a usable https URL', async () => {
		await expectFallback(
			{ respond: () => pageWithOgImage('http://insecure.bcbits.com/img/a_10.jpg') },
			'invalid-image-url'
		);
		await expectFallback({ respond: () => pageWithOgImage('javascript:alert(1)') }, 'invalid-image-url');
	});

	it('image fetch 404', async () => {
		await expectFallback(
			{
				respond: (url) =>
					url.includes('bandcamp.com') ? pageWithOgImage('https://f4.bcbits.com/img/a_10.jpg') : new Response('gone', { status: 404 })
			},
			'image-status'
		);
	});

	it('image oversize via capped read (chunked stream, no content-length)', async () => {
		// Valid JPEG magic, then more than 2MB in chunks with no declared
		// length — the truncated-read path must decide.
		await expectFallback(
			{
				respond: (url) =>
					url.includes('bandcamp.com')
						? pageWithOgImage('https://f4.bcbits.com/img/huge_10.jpg')
						: new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(JPEG_BYTES);
										controller.enqueue(new Uint8Array(IMAGE_MAX_BYTES));
										controller.enqueue(new Uint8Array(1));
										controller.close();
									}
								}),
								{ status: 200, headers: { 'content-type': 'image/jpeg' } }
							)
			},
			'oversize'
		);
	});

	it('image oversize with a fixed body over the cap (whichever check the runtime lets decide)', async () => {
		const fixed = new Uint8Array(IMAGE_MAX_BYTES + 1);
		fixed.set(JPEG_BYTES);
		await expectFallback(
			{
				respond: (url) =>
					url.includes('bandcamp.com') ? pageWithOgImage('https://f4.bcbits.com/img/huge2_10.jpg') : imageResponse(fixed, 'image/jpeg')
			},
			'oversize'
		);
	});

	it('unsupported image type (gif)', async () => {
		await expectFallback(
			{
				respond: (url) =>
					url.includes('bandcamp.com') ? pageWithOgImage('https://f4.bcbits.com/img/g_10.jpg') : imageResponse(GIF_BYTES, 'image/gif')
			},
			'unsupported-type'
		);
	});

	it('not-found for an unknown or foreign project', async () => {
		const { artistId } = await makeProject('https://x.bandcamp.com/album/x');
		const result = await refreshProjectArtwork({
			db: bindings.DB,
			art: bindings.ART,
			artistId,
			projectId: 999_999_999,
			albumUrl: 'https://x.bandcamp.com/album/x',
			now: NOW,
			fetchImpl: happyPathFetch().fetch,
			log: () => {}
		});
		expect(result).toEqual({ ok: false, reason: 'not-found' });
	});
});

// ---------------------------------------------------------------------------
// Serve route.
// ---------------------------------------------------------------------------

describe('GET /art/:id — R2 serve route', () => {
	it('serves the stored bytes with the stored content type and long cache headers', async () => {
		const { projectId, artistId } = await makeProject('https://s.bandcamp.com/album/s');
		await refreshProjectArtwork({
			db: bindings.DB, art: bindings.ART, artistId, projectId, albumUrl: 'https://s.bandcamp.com/album/s',
			now: NOW, fetchImpl: happyPathFetch().fetch, log: () => {}
		});

		const response = await callRaw('GET', '/art/:id', { params: { projectId: String(projectId) }, art: bindings.ART });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('cache-control')).toContain('max-age=86400');
		expect(response.headers.get('cache-control')).toContain('stale-while-revalidate');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
	});

	it('404s for unknown ids, malformed ids, and unfetched projects', async () => {
		for (const id of ['abc', '0', '-1', '', '999999999']) {
			const [response] = await call('GET', '/art/:id', { params: { projectId: id }, art: bindings.ART });
			expect(response.status, `id=${id}`).toBe(404);
		}
		// A project that exists but has no artwork object → 404 (FE keys off artwork_status).
		const { projectId } = await makeProject('https://u.bandcamp.com/album/u');
		const [response] = await call('GET', '/art/:id', { params: { projectId: String(projectId) }, art: bindings.ART });
		expect(response.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Manual refresh endpoint.
// ---------------------------------------------------------------------------

describe('POST /api/artist/projects/:id/refresh-artwork', () => {
	it('requires the artist session (401, no state change)', async () => {
		const { projectId } = await makeProject('https://r.bandcamp.com/album/r');
		const [response, body] = await call('POST', '/api/artist/projects/:id/refresh-artwork', {
			params: { id: String(projectId) },
			art: bindings.ART
		});
		expect(response.status).toBe(401);
		expect(body).toEqual({ error: 'unauthorized' });
		expect((await artworkRow(projectId))!.artwork_status).toBe('pending');
	});

	it('404s for unknown, malformed, and other artists\' projects', async () => {
		const { jar } = await signIn();
		const { projectId } = await makeProject('https://o.bandcamp.com/album/o'); // someone else's
		for (const id of [String(projectId), 'abc', '999999999']) {
			const [response] = await call('POST', '/api/artist/projects/:id/refresh-artwork', { params: { id }, jar, art: bindings.ART });
			expect(response.status, `id=${id}`).toBe(404);
		}
	});

	it('refreshes awaited, returning the settled outcome', async () => {
		const { projectId, artistId } = await makeProject('https://m.bandcamp.com/album/m');
		const jar = new CookieJar();
		const session = await issueArtistSession({ db: bindings.DB, artistId, secret: SESSION_SECRET, now: new Date() });
		jar.cookies.set(ARTIST_SESSION_COOKIE, session.cookieValue, artistSessionCookieOptions(true));

		setArtworkFetchForTesting(happyPathFetch().fetch);
		const [response, body] = await call('POST', '/api/artist/projects/:id/refresh-artwork', {
			params: { id: String(projectId) },
			jar,
			art: bindings.ART
		});
		expect(response.status).toBe(200);
		expect(body).toEqual({ ok: true, artwork: { status: 'fetched', url: `/art/${projectId}`, source: 'r2' } });
		expect(await artworkRow(projectId)).toMatchObject({ artwork_url: `/art/${projectId}`, artwork_status: 'fetched' });
	});

	it('is idempotent — repeated calls converge on the same state, no new rows', async () => {
		const { projectId, artistId } = await makeProject('https://i.bandcamp.com/album/i');
		const jar = new CookieJar();
		const session = await issueArtistSession({ db: bindings.DB, artistId, secret: SESSION_SECRET, now: new Date() });
		jar.cookies.set(ARTIST_SESSION_COOKIE, session.cookieValue, artistSessionCookieOptions(true));
		setArtworkFetchForTesting(happyPathFetch().fetch);

		const outcomes = [];
		for (let i = 0; i < 2; i++) {
			const [response, body] = await call('POST', '/api/artist/projects/:id/refresh-artwork', {
				params: { id: String(projectId) },
				jar,
				art: bindings.ART
			});
			expect(response.status).toBe(200);
			outcomes.push(body);
		}
		expect(outcomes[0]).toEqual(outcomes[1]);
		expect(await artworkRow(projectId)).toMatchObject({ artwork_url: `/art/${projectId}`, artwork_status: 'fetched' });
		// The one R2 key, overwritten in place.
		const listing = await bindings.ART.list({ prefix: `artwork/${projectId}` });
		expect(listing.objects).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Fire-and-forget hooks (create / album-URL change).
// ---------------------------------------------------------------------------

describe('create hook — artwork NEVER blocks project creation', () => {
	it('returns 201 immediately and lands the typed empty state when every fetch fails', async () => {
		const { jar } = await signIn();
		const failing = (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		setArtworkFetchForTesting(failing);

		const captured: Promise<unknown>[] = [];
		const [response, body] = await call('POST', '/api/artist/projects', {
			jar,
			json: { title: 'Hooked', artistName: 'Hooked', albumUrl: 'https://hooked.bandcamp.com/album/h' },
			art: bindings.ART,
			captured
		});
		expect(response.status).toBe(201);
		const project = (body as { project: { id: number; artworkStatus: string; artworkUrl: string | null } }).project;
		expect(project.artworkStatus).toBe('pending'); // at response time
		await Promise.all(captured); // then the deferred refresh settles:
		expect(await artworkRow(project.id)).toEqual({ artwork_url: null, artwork_status: 'fallback', artwork_checked_at: expect.any(String) });
	});

	it('fills /art/:id via waitUntil on the happy path', async () => {
		const { jar } = await signIn();
		setArtworkFetchForTesting(happyPathFetch().fetch);
		const captured: Promise<unknown>[] = [];
		const [response, body] = await call('POST', '/api/artist/projects', {
			jar,
			json: { title: 'Happy', artistName: 'Happy', albumUrl: 'https://arrangedgodly.bandcamp.com/album/x' },
			art: bindings.ART,
			captured
		});
		expect(response.status).toBe(201);
		const projectId = (body as { project: { id: number } }).project.id;
		await Promise.all(captured);
		expect(await artworkRow(projectId)).toMatchObject({ artwork_url: `/art/${projectId}`, artwork_status: 'fetched' });
	});

	it('skips (zero fetches) when no execution context exists', async () => {
		const { jar } = await signIn();
		const stub = happyPathFetch();
		setArtworkFetchForTesting(stub.fetch);
		const [response, body] = await call('POST', '/api/artist/projects', {
			jar,
			json: { title: 'NoCtx', artistName: 'NoCtx', albumUrl: 'https://noctx.bandcamp.com/album/n' },
			art: bindings.ART
		});
		expect(response.status).toBe(201);
		expect(stub.seen).toHaveLength(0);
		expect((await artworkRow((body as { project: { id: number } }).project.id))!.artwork_status).toBe('pending');
	});
});

describe('PATCH hook — album URL change', () => {
	async function artistJarFor(projectId: number) {
		const row = await bindings.DB.prepare('SELECT artist_id FROM projects WHERE id = ?1').bind(projectId).first<{ artist_id: number }>();
		const jar = new CookieJar();
		const session = await issueArtistSession({ db: bindings.DB, artistId: row!.artist_id, secret: SESSION_SECRET, now: new Date() });
		jar.cookies.set(ARTIST_SESSION_COOKIE, session.cookieValue, artistSessionCookieOptions(true));
		return jar;
	}

	it('resets artwork to pending synchronously, then refreshes for the new URL', async () => {
		const { projectId } = await makeProject('https://old.bandcamp.com/album/old');
		const jar = await artistJarFor(projectId);
		// Pretend the old album's art was fetched.
		await bindings.DB
			.prepare("UPDATE projects SET artwork_url = '/art/old', artwork_status = 'fetched' WHERE id = ?1")
			.bind(projectId)
			.run();

		const stub = routingFetch([
			{ match: (u) => u.includes('bandcamp.com'), respond: () => pageWithOgImage('https://f4.bcbits.com/img/new_10.jpg') },
			{ match: (u) => u.includes('bcbits.com'), respond: () => imageResponse(JPEG_BYTES) }
		]);
		setArtworkFetchForTesting(stub.fetch);

		const captured: Promise<unknown>[] = [];
		const [response, body] = await call('PATCH', '/api/artist/projects/:id', {
			params: { id: String(projectId) },
			jar,
			json: { albumUrl: 'https://new.bandcamp.com/album/new' },
			art: bindings.ART,
			captured
		});
		expect(response.status).toBe(200);
		// Synchronous part: stale art is already gone in the response.
		expect((body as { project: { artworkStatus: string; artworkUrl: string | null } }).project).toMatchObject({
			artworkStatus: 'pending',
			artworkUrl: null
		});
		await Promise.all(captured);
		// Deferred part: new album's art landed (and the R2 key was overwritten in place).
		expect(await artworkRow(projectId)).toMatchObject({ artwork_url: `/art/${projectId}`, artwork_status: 'fetched' });
		const stored = await bindings.ART.head(`artwork/${projectId}`);
		expect(stored?.httpMetadata?.contentType).toBe('image/jpeg');
		expect(stub.seen.map((r) => r.url)).toEqual(['https://new.bandcamp.com/album/new', 'https://f4.bcbits.com/img/new_10.jpg']);
	});

	it('re-sending the SAME album URL refetches nothing and keeps stored artwork', async () => {
		const { projectId } = await makeProject('https://same.bandcamp.com/album/same');
		const jar = await artistJarFor(projectId);
		await bindings.DB
			.prepare("UPDATE projects SET artwork_url = '/art/kept', artwork_status = 'fetched' WHERE id = ?1")
			.bind(projectId)
			.run();

		const stub = happyPathFetch();
		setArtworkFetchForTesting(stub.fetch);
		const [response] = await call('PATCH', '/api/artist/projects/:id', {
			params: { id: String(projectId) },
			jar,
			json: { albumUrl: 'https://same.bandcamp.com/album/same' },
			art: bindings.ART,
			captured: []
		});
		expect(response.status).toBe(200);
		expect(stub.seen).toHaveLength(0);
		expect(await artworkRow(projectId)).toMatchObject({ artwork_url: '/art/kept', artwork_status: 'fetched' });
	});
});

describe('fireArtworkRefresh — catch-all', () => {
	it('swallows even infrastructure crashes so the triggering request can never fail', async () => {
		const captured: Promise<unknown>[] = [];
		const brokenDb = {
			prepare: () => {
				throw new Error('D1 exploded');
			}
		} as unknown as D1Database;
		fireArtworkRefresh({
			db: brokenDb,
			art: null,
			artistId: 1,
			projectId: 1,
			albumUrl: 'https://x.bandcamp.com/album/x',
			now: NOW,
			context: { waitUntil: (p) => captured.push(p) },
			log: () => {}
		});
		await expect(Promise.all(captured)).resolves.toBeDefined();
	});

	it('logs and skips when no execution context is given', () => {
		const logs: string[] = [];
		fireArtworkRefresh({
			db: bindings.DB,
			art: null,
			artistId: 1,
			projectId: 1,
			albumUrl: 'https://x.bandcamp.com/album/x',
			now: NOW,
			context: null,
			log: (m) => logs.push(m)
		});
		expect(logs.some((m) => m.includes('skipped'))).toBe(true);
	});
});
