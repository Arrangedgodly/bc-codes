/**
 * Console route-guard tests (FE5) — the /console page LOADS against the real
 * D1 binding (vitest inside workerd; migrations applied by tests/setup.ts),
 * driven by a hand-rolled load event (platform/cookies/url/params are all
 * the loads touch). Route-level session gates are FE5's new server surface;
 * the BE7 endpoints behind them are already pinned by artist-projects.test.ts.
 *
 * Coverage contract (plan.md FE5, task brief):
 *   - every console page redirects (307) to /console/sign-in with the
 *     attempted path as returnTo when no artist session exists;
 *   - sign-in bounces an already-signed-in artist to returnTo;
 *   - returnTo is sanitized: only same-app /console paths survive, so the
 *     sign-in redirect can never be turned into an open redirect;
 *   - dashboard lists only the session artist's projects;
 *   - detail: malformed id → 404, another artist's project → 404 (no
 *     existence leak), own project → full console payload (claims WITH code
 *     strings — the artist owns their codes — + BE6 reports view).
 *
 * Storage persists across test files (unique emails/titles per test).
 */

import { env as bindings } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import type { Redirect } from '@sveltejs/kit';
import type { Cookies, ServerLoadEvent } from '@sveltejs/kit';
import * as dashboard from '../src/routes/console/+page.server';
import * as newDrop from '../src/routes/console/new/+page.server';
import * as signIn from '../src/routes/console/sign-in/+page.server';
import * as detail from '../src/routes/console/[id]/+page.server';
import { ARTIST_SESSION_COOKIE, artistSessionCookieOptions, issueArtistSession } from '../src/lib/server/artist-session';
import { safeReturnTo } from '../src/lib/server/console-guard';
const SESSION_SECRET = 'test-session-secret';

/** Records cookie reads/writes (loads only read). */
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

interface LoadOptions {
	params?: Record<string, string>;
	jar?: CookieJar;
	url?: string;
}

function makeLoadEvent(opts: LoadOptions = {}): ServerLoadEvent {
	return {
		url: new URL(opts.url ?? 'http://app.test/console'),
		params: opts.params ?? {},
		cookies: (opts.jar ?? new CookieJar()).cookies,
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
	} as unknown as ServerLoadEvent;
}

/**
 * Typed loads demand their exact route's event shape; tests hand-roll one
 * generic event — the established loose-handler pattern from the endpoint
 * suites (artist-projects.test.ts).
 */
type AnyLoad = (event: ServerLoadEvent) => Promise<unknown>;
const loadDashboard = dashboard.load as unknown as AnyLoad;
const loadNewDrop = newDrop.load as unknown as AnyLoad;
const loadSignIn = signIn.load as unknown as AnyLoad;
const loadDetail = detail.load as unknown as AnyLoad;

/** Artist row + a session cookie in a jar, via BE3's issueArtistSession. */
let seq = 0;
async function signedInArtist() {
	const email = `fe5-artist-${++seq}@example.test`;
	await bindings.DB.prepare('INSERT INTO artists (email) VALUES (?1) ON CONFLICT (email) DO NOTHING').bind(email).run();
	const artist = await bindings.DB.prepare('SELECT id FROM artists WHERE email = ?1').bind(email).first<{ id: number }>();
	const session = await issueArtistSession({ db: bindings.DB, artistId: artist!.id, secret: SESSION_SECRET, now: new Date() });
	const jar = new CookieJar();
	jar.cookies.set(ARTIST_SESSION_COOKIE, session.cookieValue, artistSessionCookieOptions(true));
	return { artistId: artist!.id, jar };
}

/** A draft project owned by the given artist (direct createProject — no artwork hook). */
async function seedProject(artistId: number, title: string) {
	const { createProject } = await import('../src/lib/server/project');
	return createProject({
		db: bindings.DB,
		artistId,
		title,
		artistName: `fe5 artist ${++seq}`,
		albumUrl: { albumUrl: 'https://fe5test.bandcamp.com/album/fixture', yumUrl: 'https://fe5test.bandcamp.com/yum', subdomain: 'fe5test' },
		now: new Date()
	});
}

describe('console route gates (FE5)', () => {
	it('dashboard: no session → 307 to sign-in with /console as returnTo', async () => {
		try {
			await loadDashboard(makeLoadEvent());
			expect.unreachable('load should have redirected');
		} catch (error) {
			expect(isRedirect(error)).toBe(true);
			expect((error as Redirect).status).toBe(307);
			expect((error as Redirect).location).toBe('/console/sign-in?returnTo=%2Fconsole');
		}
	});

	it('new: no session → 307 with /console/new as returnTo', async () => {
		try {
			await loadNewDrop(makeLoadEvent({ url: 'http://app.test/console/new' }));
			expect.unreachable('load should have redirected');
		} catch (error) {
			expect(isRedirect(error)).toBe(true);
			expect((error as Redirect).location).toBe('/console/sign-in?returnTo=%2Fconsole%2Fnew');
		}
	});

	it('detail: no session → 307 with /console/:id as returnTo', async () => {
		try {
			await loadDetail(makeLoadEvent({ params: { id: '7' }, url: 'http://app.test/console/7' }));
			expect.unreachable('load should have redirected');
		} catch (error) {
			expect(isRedirect(error)).toBe(true);
			expect((error as Redirect).location).toBe('/console/sign-in?returnTo=%2Fconsole%2F7');
		}
	});

	it('dashboard: signed in → exactly that artist\'s projects with stats', async () => {
		const { artistId, jar } = await signedInArtist();
		const mine = await seedProject(artistId, 'fe5 gate mine');
		const other = await seedProject((await signedInArtist()).artistId, 'fe5 gate other');
		const data = (await loadDashboard(makeLoadEvent({ jar }))) as { projects: { id: number; stats: { total: number } }[] };
		const ids = data.projects.map((p) => p.id);
		expect(ids).toContain(mine.id);
		expect(ids).not.toContain(other.id);
		expect(data.projects.find((p) => p.id === mine.id)?.stats.total).toBe(0); // draft: honest zero
	});

	it('detail: signed in + own project → console payload (claims code strings + reports view)', async () => {
		const { artistId, jar } = await signedInArtist();
		const project = await seedProject(artistId, 'fe5 gate detail');
		const data = (await loadDetail(makeLoadEvent({ params: { id: String(project.id) }, url: `http://app.test/console/${project.id}`, jar }))) as {
			project: { id: number; slug: string; status: string; recentClaims: unknown[]; reports: { reportCount: number } };
		};
		expect(data.project.id).toBe(project.id);
		expect(data.project.status).toBe('draft');
		expect(data.project.recentClaims).toEqual([]);
		expect(data.project.reports.reportCount).toBe(0);
	});

	it('detail: another artist\'s project → 404 indistinguishable from missing', async () => {
		const { jar } = await signedInArtist();
		const foreign = await seedProject((await signedInArtist()).artistId, 'fe5 gate foreign');
		try {
			await loadDetail(makeLoadEvent({ params: { id: String(foreign.id) }, url: `http://app.test/console/${foreign.id}`, jar }));
			expect.unreachable('load should have 404ed');
		} catch (error) {
			expect(isHttpError(error)).toBe(true);
			expect((error as { status: number }).status).toBe(404);
		}
	});

	it('detail: malformed id → 404 (no session leak either — gate runs first)', async () => {
		const { jar } = await signedInArtist();
		for (const id of ['abc', '1e2', '0', '-1']) {
			try {
				await loadDetail(makeLoadEvent({ params: { id }, url: `http://app.test/console/${id}`, jar }));
				expect.unreachable(`id ${id} should have 404ed`);
			} catch (error) {
				expect(isHttpError(error)).toBe(true);
				expect((error as { status: number }).status).toBe(404);
			}
		}
	});

	it('sign-in: signed out → renders with the sanitized returnTo', async () => {
		const data = (await loadSignIn(makeLoadEvent({ url: 'http://app.test/console/sign-in?returnTo=%2Fconsole%2F7' }))) as { returnTo: string };
		expect(data.returnTo).toBe('/console/7');
	});

	it('sign-in: unsafe returnTo values collapse to /console (no open redirect)', async () => {
		// Direct unit pin of the sanitizer + the load's use of it below.
		expect(safeReturnTo('//evil.example')).toBe('/console');
		expect(safeReturnTo('https://evil.example')).toBe('/console');
		expect(safeReturnTo('/fan/board')).toBe('/console');
		expect(safeReturnTo(null)).toBe('/console');
		expect(safeReturnTo('/console/7')).toBe('/console/7');
		for (const bad of ['//evil.example', 'https://evil.example', '/fan', '', null]) {
			const url = new URL('http://app.test/console/sign-in');
			if (bad !== null && bad !== '') url.searchParams.set('returnTo', bad);
			const data = (await loadSignIn(makeLoadEvent({ url: url.toString() }))) as { returnTo: string };
			expect(data.returnTo).toBe('/console');
		}
	});

	it('sign-in: already signed in → 307 to returnTo', async () => {
		const { jar } = await signedInArtist();
		try {
			await loadSignIn(makeLoadEvent({ jar, url: 'http://app.test/console/sign-in?returnTo=%2Fconsole%2Fnew' }));
			expect.unreachable('load should have redirected');
		} catch (error) {
			expect(isRedirect(error)).toBe(true);
			expect((error as Redirect).location).toBe('/console/new');
		}
	});
});
