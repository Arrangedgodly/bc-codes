/**
 * Artist project API tests (BE7) — the real +server.ts handlers against the
 * real D1 binding (vitest inside workerd; migrations applied by tests/setup.ts),
 * driven by a hand-rolled RequestEvent (request/cookies/platform/params are
 * all the handlers touch). BE5's dispenseCode and BE6's reportClaim are wired
 * in directly for the stats/ drained- re-activation cases — the artist API's
 * counters must agree with what those engines actually wrote.
 *
 * Storage persists across test files, so every artist email, project title
 * and code prefix derives from a global counter (unique per test run).
 *
 * Coverage map (task scope):
 *   create→draft · upload→active+counts · re-upload dedupe across batches ·
 *   drained re-activation on new upload · pause/resume guards (draft→409,
 *   drained→409, idempotent same-state, paused survives upload) · slug
 *   collision + uniqueness + stability · album URL validation (non-bandcamp
 *   rejected) · auth required (401, zero writes) · stats after dispense+report ·
 *   multipart + raw-text uploads · 2MB cap · invalid CSV · harvest/autofill
 *   offered but never written · cross-artist scoping · DELETE→405 · malformed
 *   ids → 404.
 */

import { env as bindings } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import * as collection from '../src/routes/api/artist/projects/+server';
import * as item from '../src/routes/api/artist/projects/[id]/+server';
import * as upload from '../src/routes/api/artist/projects/[id]/upload/+server';
import { ARTIST_SESSION_COOKIE, artistSessionCookieOptions, issueArtistSession } from '../src/lib/server/artist-session';
import { dispenseCode } from '../src/lib/server/dispense';
import { reportClaim } from '../src/lib/server/report';

const SESSION_SECRET = 'test-session-secret';
const NOW = new Date('2026-08-28T12:00:00Z');

/** Records cookie writes so a jar can carry an issued session across calls. */
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
	'/api/artist/projects': { GET: collection.GET as AnyHandler, POST: collection.POST as AnyHandler },
	'/api/artist/projects/:id': { GET: item.GET as AnyHandler, PATCH: item.PATCH as AnyHandler, DELETE: item.DELETE as AnyHandler },
	'/api/artist/projects/:id/upload': { POST: upload.POST as AnyHandler }
};

interface CallOptions {
	params?: Record<string, string>;
	jar?: CookieJar;
	json?: unknown;
	body?: BodyInit;
	headers?: Record<string, string>;
}

function makeEvent(method: string, path: string, opts: CallOptions): RequestEvent {
	const headers = new Headers(opts.headers ?? {});
	let body: BodyInit | null = null;
	if (opts.json !== undefined) {
		body = JSON.stringify(opts.json);
		if (!headers.has('content-type')) headers.set('content-type', 'application/json');
	} else if (opts.body !== undefined) {
		body = opts.body;
	}
	return {
		request: new Request(`http://app.test${path}`, { method, headers, body }),
		url: new URL(`http://app.test${path}`),
		params: opts.params ?? {},
		cookies: (opts.jar ?? new CookieJar()).cookies,
		getClientAddress: () => '192.0.2.9',
		platform: {
			env: {
				DB: bindings.DB,
				ART: null,
				SESSION_SECRET,
				EMAIL_PEPPER: 'test-email-pepper',
				OTP_PEPPER: 'test-otp-pepper',
				MAILER_DRIVER: 'console'
			}
		}
	} as unknown as RequestEvent;
}

/** Fire one endpoint; returns [response, parsed body]. */
async function call(method: string, path: string, opts: CallOptions = {}) {
	const response = await HANDLERS[path]![method]!(makeEvent(method, path, opts));
	return [response, ((await response.json().catch(() => null)) as unknown)] as const;
}

let seq = 0;
const uid = () => ++seq;

/** Artist row + a session cookie in a jar, via BE3's issueArtistSession. */
async function signIn() {
	const n = uid();
	const email = `artist-${n}@example.test`;
	await bindings.DB.prepare('INSERT INTO artists (email) VALUES (?1) ON CONFLICT (email) DO NOTHING').bind(email).run();
	const artist = await bindings.DB.prepare('SELECT id FROM artists WHERE email = ?1').bind(email).first<{ id: number }>();
	const session = await issueArtistSession({ db: bindings.DB, artistId: artist!.id, secret: SESSION_SECRET, now: new Date() });
	const jar = new CookieJar();
	jar.cookies.set(ARTIST_SESSION_COOKIE, session.cookieValue, artistSessionCookieOptions(true));
	return { artistId: artist!.id, jar, n };
}

/** A Bandcamp-export-shaped CSV around the given codes. */
function makeCsv(codes: string[], opts: { album?: string; yumUrl?: string } = {}): string {
	const lines = ['name of code set: test', 'date created: Aug-28-2026', 'date exported: Aug-28-2026'];
	if (opts.album) lines.push(`album: ${opts.album}`);
	if (opts.yumUrl) lines.push('', 'send your fans here to redeem their codes:', `    ${opts.yumUrl}`);
	lines.push('', 'code');
	return `${lines.join('\n')}\n${codes.join('\n')}\n`;
}

/** n valid xxxx-xxxx codes, unique within this generated set. */
const genCodes = (prefix: string, n: number, from = 1) =>
	Array.from({ length: n }, (_, i) => `${prefix}-${String(from + i).padStart(4, '0')}`);

/** Create a project via the API; throws on a non-201 so tests fail loudly. */
async function apiCreateProject(jar: CookieJar, title: string, artistName: string, albumUrl: string) {
	const [response, body] = await call('POST', '/api/artist/projects', {
		jar,
		json: { title, artistName, albumUrl }
	});
	if (response.status !== 201) throw new Error(`create failed: ${response.status} ${JSON.stringify(body)}`);
	return (body as { project: { id: number; slug: string } }).project;
}

/** Raw-text CSV upload via the API; returns [response, body]. */
async function apiUpload(jar: CookieJar, projectId: number, csv: string) {
	return call('POST', '/api/artist/projects/:id/upload', {
		params: { id: String(projectId) },
		jar,
		body: csv,
		headers: { 'content-type': 'text/csv' }
	});
}

async function projectRow(projectId: number) {
	return bindings.DB.prepare('SELECT * FROM projects WHERE id = ?1').bind(projectId).first<{
		id: number;
		title: string;
		artist_name: string;
		album_url: string;
		slug: string;
		yum_url: string;
		status: string;
	}>();
}

async function countRows(sql: string, ...params: unknown[]): Promise<number> {
	const row = await bindings.DB.prepare(sql).bind(...params).first<{ n: number }>();
	return row?.n ?? 0;
}

// ---------------------------------------------------------------------------

describe('artist projects — auth', () => {
	it('answers 401 on every endpoint without an artist session, writing nothing', async () => {
		const before = await countRows('SELECT COUNT(*) AS n FROM projects');
		const someId = 1;
		const cases: [string, string, CallOptions][] = [
			['GET', '/api/artist/projects', {}],
			['POST', '/api/artist/projects', { json: { title: 'X', artistName: 'Y', albumUrl: 'https://x.bandcamp.com/album/x' } }],
			['GET', '/api/artist/projects/:id', { params: { id: String(someId) } }],
			['PATCH', '/api/artist/projects/:id', { params: { id: String(someId) }, json: { title: 'X' } }],
			['POST', '/api/artist/projects/:id/upload', { params: { id: String(someId) }, body: makeCsv(['aaaa-0001']), headers: { 'content-type': 'text/csv' } }]
		];
		for (const [method, path, opts] of cases) {
			const [response, body] = await call(method, path, opts);
			expect(response.status, `${method} ${path}`).toBe(401);
			expect(body).toEqual({ error: 'unauthorized' });
		}
		expect(await countRows('SELECT COUNT(*) AS n FROM projects')).toBe(before);
	});
});

describe('artist projects — create', () => {
	it('creates a draft project with derived slug + yum URL and zero stats', async () => {
		const { jar } = await signIn();
		const [response, body] = await call('POST', '/api/artist/projects', {
			jar,
			json: {
				title: 'Taxed, Tolled & Eternally Trolled!',
				artistName: 'arrangedgodly',
				albumUrl: 'https://arrangedgodly.bandcamp.com/album/taxed-tolled-eternally-trolled'
			}
		});
		expect(response.status).toBe(201);
		const project = (body as { project: Record<string, unknown> }).project;
		expect(project.status).toBe('draft');
		expect(project.slug).toBe('arrangedgodly-taxed-tolled-eternally-trolled');
		expect(project.yumUrl).toBe('https://arrangedgodly.bandcamp.com/yum');
		expect(project.stats).toEqual({ total: 0, claimed: 0, available: 0, reported: 0 });
		expect(project.artworkUrl).toBeNull(); // BE8 fills this later
		// The artist-entered values round-trip verbatim.
		expect(project.title).toBe('Taxed, Tolled & Eternally Trolled!');
		expect(project.artistName).toBe('arrangedgodly');
	});

	it('rejects non-bandcamp album URLs (and normalizes accepted ones)', async () => {
		const { jar } = await signIn();
		const bad = [
			'https://example.com/album/x', // not bandcamp
			'https://bandcamp.com/album/x', // no artist subdomain
			'https://www.bandcamp.com/album/x', // bandcamp's own site, not an artist
			'ftp://artist.bandcamp.com/album/x', // wrong scheme
			'not a url',
			'',
			42,
			null,
			undefined
		];
		for (const albumUrl of bad) {
			const [response, body] = await call('POST', '/api/artist/projects', {
				jar,
				json: { title: 'T', artistName: 'A', albumUrl }
			});
			expect(response.status, `albumUrl=${JSON.stringify(albumUrl)}`).toBe(400);
			expect((body as { error: string }).error).toBe('invalid_album_url');
		}
		// Accepted: scheme/host case-insensitive, query + hash + trailing slash normalized away.
		const [okResponse, okBody] = await call('POST', '/api/artist/projects', {
			jar,
			json: { title: 'T', artistName: 'A', albumUrl: 'HTTP://Artist.Bandcamp.com/Album/Foo/?utm=x#frag' }
		});
		expect(okResponse.status).toBe(201);
		const project = (okBody as { project: Record<string, unknown> }).project;
		expect(project.albumUrl).toBe('https://artist.bandcamp.com/Album/Foo');
		expect(project.yumUrl).toBe('https://artist.bandcamp.com/yum');
	});

	it('rejects missing/empty/oversized titles and artist names', async () => {
		const { jar } = await signIn();
		const albumUrl = 'https://a.bandcamp.com/album/a';
		for (const title of [undefined, '', '   ', 42, 'x'.repeat(201)]) {
			const [response, body] = await call('POST', '/api/artist/projects', { jar, json: { title, artistName: 'A', albumUrl } });
			expect(response.status, `title=${JSON.stringify(title)?.slice(0, 30)}`).toBe(400);
			expect((body as { error: string }).error).toBe('invalid_title');
		}
		for (const artistName of [undefined, '', 42, 'x'.repeat(201)]) {
			const [response, body] = await call('POST', '/api/artist/projects', { jar, json: { title: 'T', artistName, albumUrl } });
			expect(response.status).toBe(400);
			expect((body as { error: string }).error).toBe('invalid_artist_name');
		}
		// Whitespace runs collapse; 200 chars of actual text pass.
		const [okResponse, okBody] = await call('POST', '/api/artist/projects', {
			jar,
			json: { title: '  A   title  ', artistName: 'A', albumUrl }
		});
		expect(okResponse.status).toBe(201);
		expect((okBody as { project: { title: string } }).project.title).toBe('A title');
	});
});

describe('artist projects — upload', () => {
	it('raw-text upload activates a draft and inserts every code (counts + DB)', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const codes = genCodes(`u${String(n % 1000).padStart(3, '0')}`, 5);

		const [response, body] = await apiUpload(jar, project.id, makeCsv(codes));
		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true, inserted: 5, parsed: 5, projectStatus: 'active', duplicatesInFile: [], duplicatesExisting: [] });
		expect((body as { batchId: number }).batchId).toBeGreaterThan(0);

		expect(await countRows('SELECT COUNT(*) AS n FROM codes WHERE project_id = ?1', project.id)).toBe(5);
		expect((await projectRow(project.id))!.status).toBe('active');
		// One batch row carrying the count (filename null for raw-text uploads).
		const batch = await bindings.DB.prepare('SELECT filename, code_count FROM code_batches WHERE project_id = ?1').bind(project.id).first<{ filename: string | null; code_count: number }>();
		expect(batch).toMatchObject({ filename: null, code_count: 5 });

		// The list now shows the activated project with exact stats.
		const [, listBody] = await call('GET', '/api/artist/projects', { jar });
		const listed = (listBody as { projects: { id: number; stats: Record<string, number>; status: string }[] }).projects.find((p) => p.id === project.id);
		expect(listed!.status).toBe('active');
		expect(listed!.stats).toEqual({ total: 5, claimed: 0, available: 5, reported: 0 });
	});

	it('multipart upload records the filename', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const codes = genCodes(`m${String(n % 1000).padStart(3, '0')}`, 2);

		const form = new FormData();
		form.append('file', new File([makeCsv(codes)], 'GetMusic codes.csv', { type: 'text/csv' }));
		const [response, body] = await call('POST', '/api/artist/projects/:id/upload', {
			params: { id: String(project.id) },
			jar,
			body: form
		});
		expect(response.status).toBe(200);
		expect((body as { inserted: number }).inserted).toBe(2);
		const batch = await bindings.DB.prepare('SELECT filename, code_count FROM code_batches WHERE project_id = ?1').bind(project.id).first<{ filename: string | null; code_count: number }>();
		expect(batch).toMatchObject({ filename: 'GetMusic codes.csv', code_count: 2 });
	});

	it('dedupes a re-upload across batches (within-file dupes and invalid lines reported)', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const prefix = `d${String(n % 1000).padStart(3, '0')}`;
		await apiUpload(jar, project.id, makeCsv(genCodes(prefix, 3)));

		// Overlap: aaaa-0001 already present, 0004 new, an in-file dupe, and one garbage line.
		const second = [`${prefix}-0001`, `${prefix}-0004`, `${prefix}-0004`, 'this is not a code'];
		const [response, body] = await apiUpload(jar, project.id, makeCsv(second));
		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			inserted: 1,
			parsed: 2,
			duplicatesInFile: [`${prefix}-0004`],
			duplicatesExisting: [`${prefix}-0001`],
			projectStatus: 'active'
		});
		expect((body as { invalidLines: { lineNumber: number; text: string }[] }).invalidLines).toEqual([
			{ lineNumber: expect.any(Number), text: 'this is not a code' }
		]);

		expect(await countRows('SELECT COUNT(*) AS n FROM codes WHERE project_id = ?1', project.id)).toBe(4);
		expect(await countRows('SELECT COUNT(*) AS n FROM code_batches WHERE project_id = ?1', project.id)).toBe(2);
	});

	it('an all-duplicate upload inserts nothing, adds no batch row, and changes no status', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const codes = genCodes(`z${String(n % 1000).padStart(3, '0')}`, 2);
		await apiUpload(jar, project.id, makeCsv(codes));
		await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status: 'paused' } });

		const [response, body] = await apiUpload(jar, project.id, makeCsv(codes));
		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true, inserted: 0, batchId: null, duplicatesExisting: codes, projectStatus: 'paused' });
		expect(await countRows('SELECT COUNT(*) AS n FROM code_batches WHERE project_id = ?1', project.id)).toBe(1);
	});

	it('rejects non-CSV bodies (400 with BE2 artist-safe message)', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		for (const csv of ['', 'just some prose\nwithout any code column\n', '\u0000\u0001binary\u0002']) {
			const [response, body] = await apiUpload(jar, project.id, csv);
			expect(response.status, JSON.stringify(csv.slice(0, 12))).toBe(400);
			expect((body as { error: string }).error).toBe('invalid_csv');
			expect(typeof (body as { message: string }).message).toBe('string');
		}
		expect(await countRows('SELECT COUNT(*) AS n FROM codes WHERE project_id = ?1', project.id)).toBe(0);
	});

	it('caps uploads at ~2MB (413)', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const big = 'x'.repeat(3 * 1024 * 1024);
		const [response, body] = await apiUpload(jar, project.id, big);
		expect(response.status).toBe(413);
		expect((body as { error: string }).error).toBe('file_too_large');
	});

	it('offers CSV harvest as autofill candidates but never writes them', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, 'My Typed Title', 'Someone', 'https://someone.bandcamp.com/album/foo');
		const codes = genCodes(`h${String(n % 1000).padStart(3, '0')}`, 1);

		const [response, body] = await apiUpload(
			jar,
			project.id,
			makeCsv(codes, { album: 'The Real Album', yumUrl: 'https://thereal.bandcamp.com/yum' })
		);
		expect(response.status).toBe(200);
		expect((body as { albumTitle: string | null }).albumTitle).toBe('The Real Album');
		expect((body as { yumUrl: string | null }).yumUrl).toBe('https://thereal.bandcamp.com/yum');
		expect((body as { autofill: Record<string, string> }).autofill).toEqual({
			title: 'The Real Album',
			yumUrl: 'https://thereal.bandcamp.com/yum'
		});

		// The artist-entered values are untouched — confirming is a PATCH (FE5's call).
		const row = await projectRow(project.id);
		expect(row!.title).toBe('My Typed Title');
		expect(row!.yum_url).toBe('https://someone.bandcamp.com/yum');

		// After the FE confirms (PATCH), a re-upload stops suggesting.
		await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { title: 'The Real Album', albumUrl: 'https://thereal.bandcamp.com/album/foo' } });
		const [, again] = await apiUpload(jar, project.id, makeCsv(codes, { album: 'The Real Album', yumUrl: 'https://thereal.bandcamp.com/yum' }));
		expect((again as { autofill: Record<string, string> }).autofill).toEqual({});
	});

	it('404s for an unknown (or another artist\'s) project', async () => {
		const { jar } = await signIn();
		const [missing] = await apiUpload(jar, 999_999_999, makeCsv(['aaaa-0001']));
		expect(missing.status).toBe(404);

		const other = await signIn();
		const mine = await apiCreateProject(jar, 'Mine', 'Mine', 'https://mine.bandcamp.com/album/x');
		for (const [method, path, opts] of [
			['GET', '/api/artist/projects/:id', { params: { id: String(mine.id) } }],
			['PATCH', '/api/artist/projects/:id', { params: { id: String(mine.id) }, json: { title: 'Hijack' } }],
			['POST', '/api/artist/projects/:id/upload', { params: { id: String(mine.id) }, body: makeCsv(['bbbb-0001']), headers: { 'content-type': 'text/csv' } }]
		] as [string, string, CallOptions][]) {
			const [response] = await call(method, path, { ...opts, jar: other.jar });
			expect(response.status, `${method} ${path}`).toBe(404);
		}
		// The owner's project is intact and invisible in the other artist's list.
		const [, listBody] = await call('GET', '/api/artist/projects', { jar: other.jar });
		expect((listBody as { projects: { id: number }[] }).projects.some((p) => p.id === mine.id)).toBe(false);
		expect((await projectRow(mine.id))!.title).toBe('Mine');
	});
});

describe('artist projects — pause/resume guards', () => {
	it('refuses pause AND resume on a draft (409, invalid_transition)', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		for (const status of ['paused', 'active'] as const) {
			const [response, body] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status } });
			expect(response.status).toBe(409);
			expect(body).toMatchObject({ error: 'invalid_transition', from: 'draft', to: status });
			expect(typeof (body as { message: string }).message).toBe('string');
		}
		expect((await projectRow(project.id))!.status).toBe('draft');
	});

	it('active ↔ paused works and same-state requests are idempotent', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		await apiUpload(jar, project.id, makeCsv(genCodes(`p${String(n % 1000).padStart(3, '0')}`, 2)));

		const [pauseResponse, pauseBody] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status: 'paused' } });
		expect(pauseResponse.status).toBe(200);
		expect((pauseBody as { project: { status: string } }).project.status).toBe('paused');
		// Paused again: idempotent success, not an error.
		const [again] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status: 'paused' } });
		expect(again.status).toBe(200);

		const [resumeResponse, resumeBody] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status: 'active' } });
		expect(resumeResponse.status).toBe(200);
		expect((resumeBody as { project: { status: string } }).project.status).toBe('active');
		// Active "resume": also idempotent.
		const [stillActive] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status: 'active' } });
		expect(stillActive.status).toBe(200);
	});

	it('an upload to a paused project preserves the pause (codes still land)', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const prefix = `w${String(n % 1000).padStart(3, '0')}`;
		await apiUpload(jar, project.id, makeCsv(genCodes(prefix, 2)));
		await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status: 'paused' } });

		const [response, body] = await apiUpload(jar, project.id, makeCsv(genCodes(prefix, 3, 3)));
		expect(response.status).toBe(200);
		expect((body as { projectStatus: string }).projectStatus).toBe('paused');
		expect((body as { inserted: number }).inserted).toBe(3);
		expect(await countRows('SELECT COUNT(*) AS n FROM codes WHERE project_id = ?1 AND status = \'available\'', project.id)).toBe(5);
	});

	it('refuses hand transitions on a drained project (409) — upload re-activates instead', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const prefix = `r${String(n % 1000).padStart(3, '0')}`;
		await apiUpload(jar, project.id, makeCsv(genCodes(prefix, 2)));

		// Drain: two fans take both codes — BE5 flips the project to drained.
		for (const fanHash of [`fan-drain-${project.id}-1`, `fan-drain-${project.id}-2`]) {
			const dispensed = await dispenseCode({ db: bindings.DB, project: project.id, fanHash, now: NOW });
			expect(dispensed.ok).toBe(true);
		}
		expect((await projectRow(project.id))!.status).toBe('drained');

		for (const status of ['paused', 'active'] as const) {
			const [response, body] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status } });
			expect(response.status).toBe(409);
			expect(body).toMatchObject({ error: 'invalid_transition', from: 'drained', to: status });
		}

		// New codes land → the project re-activates (BE5's note honored).
		const [response, body] = await apiUpload(jar, project.id, makeCsv(genCodes(prefix, 3, 3)));
		expect(response.status).toBe(200);
		expect((body as { projectStatus: string }).projectStatus).toBe('active');
		const row = await projectRow(project.id);
		expect(row!.status).toBe('active');
		expect(await countRows('SELECT COUNT(*) AS n FROM codes WHERE project_id = ?1 AND status = \'available\'', project.id)).toBe(3);
	});
});

describe('artist projects — slug policy', () => {
	it('unique-ifies collisions with the -2, -3 suffix (same artist AND across artists)', async () => {
		const first = await signIn();
		const a1 = await apiCreateProject(first.jar, 'Same Album', 'Same Artist', 'https://same.bandcamp.com/album/x');
		const a2 = await apiCreateProject(first.jar, 'Same Album', 'Same Artist', 'https://same.bandcamp.com/album/x');
		const second = await signIn();
		const a3 = await apiCreateProject(second.jar, 'Same Album', 'Same Artist', 'https://same.bandcamp.com/album/x');

		expect(a1.slug).toBe('same-artist-same-album');
		expect(a2.slug).toBe('same-artist-same-album-2');
		expect(a3.slug).toBe('same-artist-same-album-3'); // slug uniqueness is global
		expect(await countRows('SELECT COUNT(*) AS n FROM (SELECT slug FROM projects GROUP BY slug HAVING COUNT(*) > 1)')).toBe(0);
	});

	it('re-derives the slug on title/artist-name edits while draft, keeps it once active', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `First Title ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);

		// Title edit while draft → new slug (no collision → no suffix).
		const [, retitled] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { title: `Second Title ${n}` } });
		expect((retitled as { project: { slug: string } }).project.slug).toBe(`artist-${n}-second-title-${n}`);

		// Artist-name edit while draft also re-derives (both feed the slug).
		const [, renamed] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { artistName: `Renamed ${n}` } });
		const activeSlug = (renamed as { project: { slug: string } }).project.slug;
		expect(activeSlug).toBe(`renamed-${n}-second-title-${n}`);

		// Activate: the slug is now stable through further edits.
		await apiUpload(jar, project.id, makeCsv(genCodes(`s${String(n % 1000).padStart(3, '0')}`, 1)));
		const [, afterActivation] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { title: `Third Title ${n}` } });
		expect((afterActivation as { project: { slug: string } }).project.slug).toBe(activeSlug);
		expect((await projectRow(project.id))!.slug).toBe(activeSlug);
	});

	it('rejects a client attempting to set the slug directly', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const [response, body] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { slug: 'hacked' } });
		expect(response.status).toBe(400);
		expect((body as { error: string }).error).toBe('slug_immutable');
		expect((await projectRow(project.id))!.slug).toBe(project.slug);
	});

	it('falls back to `drop` when the slug inputs strip to nothing, still unique', async () => {
		const { jar } = await signIn();
		const a1 = await apiCreateProject(jar, '!!!', '???', 'https://x1.bandcamp.com/album/x');
		const a2 = await apiCreateProject(jar, '###', '***', 'https://x2.bandcamp.com/album/x');
		expect(a1.slug).toBe('drop');
		expect(a2.slug).toBe('drop-2');
	});
});

describe('artist projects — stats + detail (dispense/report wired in)', () => {
	it('list and detail stats agree with what dispense + report actually wrote', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const prefix = `t${String(n % 1000).padStart(3, '0')}`;
		await apiUpload(jar, project.id, makeCsv(genCodes(prefix, 5)));

		// One fan claims; one code leaves the pool.
		const fanHash = `fan-stats-${project.id}`;
		const dispensed = await dispenseCode({ db: bindings.DB, project: project.id, fanHash, now: NOW });
		expect(dispensed.ok).toBe(true);
		const deadCode = dispensed.ok ? dispensed.claim.code : '';

		const [, listAfterClaim] = await call('GET', '/api/artist/projects', { jar });
		const listed = (listAfterClaim as { projects: { id: number; stats: Record<string, number> }[] }).projects.find((p) => p.id === project.id);
		expect(listed!.stats).toEqual({ total: 5, claimed: 1, available: 4, reported: 0 });

		// The fan reports the code dead → reissue: dead code 'reported', replacement 'claimed'.
		const reported = await reportClaim({ db: bindings.DB, fanHash, project: project.id, reason: 'already redeemed', now: NOW });
		expect(reported.ok && reported.outcome).toBe('reissued');

		const [detailResponse, detailBody] = await call('GET', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar });
		expect(detailResponse.status).toBe(200);
		const detail = (detailBody as { project: {
			stats: Record<string, number>;
			recentClaims: { claimId: number; code: string; kind: string; codeStatus: string; reissuedAt: string | null }[];
			reports: { reportCount: number; reports: { code: string; reason: string | null; reissued: boolean }[] };
		} }).project;
		expect(detail.stats).toEqual({ total: 5, claimed: 1, available: 3, reported: 1 });
		// Code strings are SHOWN (the artist owns their codes), current first.
		expect(detail.recentClaims).toHaveLength(1);
		expect(detail.recentClaims[0]!.code).not.toBe(deadCode);
		expect(detail.recentClaims[0]).toMatchObject({ kind: 'reissue', codeStatus: 'claimed' });
		expect(detail.recentClaims[0]!.reissuedAt).not.toBeNull();
		expect(detail.reports.reportCount).toBe(1);
		expect(detail.reports.reports[0]).toMatchObject({ code: deadCode, reason: 'already redeemed', reissued: true });
	});
});

describe('artist projects — surface details', () => {
	it('DELETE answers 405 with an allow header (no destructive ops in MVP)', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const [response, body] = await call('DELETE', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar });
		expect(response.status).toBe(405);
		expect((body as { error: string }).error).toBe('method_not_allowed');
		expect(response.headers.get('allow')).toBe('GET, PATCH');
		expect(await projectRow(project.id)).not.toBeNull(); // still there
	});

	it('malformed ids read as 404', async () => {
		const { jar } = await signIn();
		for (const id of ['abc', '1e2', '0', '-1', '']) {
			const [response] = await call('GET', '/api/artist/projects/:id', { params: { id }, jar });
			expect(response.status, `id=${id}`).toBe(404);
		}
	});

	it('PATCH with nothing to update is a 400, unknown fields are not silently applied', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://artist${n}.bandcamp.com/album/x`);
		const [empty] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: {} });
		expect(empty.status).toBe(400);
		const [badStatus, badStatusBody] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { status: 'drained' } });
		expect(badStatus.status).toBe(400);
		expect(badStatusBody).toMatchObject({ error: 'invalid_status' });
		// A bad field value is rejected even when a valid one rides along.
		const [mixed] = await call('PATCH', '/api/artist/projects/:id', { params: { id: String(project.id) }, jar, json: { title: 'Fine', albumUrl: 'https://not-bandcamp.com/x' } });
		expect(mixed.status).toBe(400);
		expect((await projectRow(project.id))!.title).toBe(`Album ${n}`);
	});

	it('an album-URL update re-derives the yum URL', async () => {
		const { jar, n } = await signIn();
		const project = await apiCreateProject(jar, `Album ${n}`, `Artist ${n}`, `https://old${n}.bandcamp.com/album/x`);
		const [response, body] = await call('PATCH', '/api/artist/projects/:id', {
			params: { id: String(project.id) },
			jar,
			json: { albumUrl: `https://new${n}.bandcamp.com/album/y` }
		});
		expect(response.status).toBe(200);
		expect((body as { project: { yumUrl: string } }).project.yumUrl).toBe(`https://new${n}.bandcamp.com/yum`);
		const row = await projectRow(project.id);
		expect(row!.album_url).toBe(`https://new${n}.bandcamp.com/album/y`);
		expect(row!.yum_url).toBe(`https://new${n}.bandcamp.com/yum`);
	});
});
