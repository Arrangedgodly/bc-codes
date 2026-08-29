/**
 * QA2 harness — the shared machinery every journey spec uses.
 *
 * Three channels, all validated live against this stack:
 *
 * 1. BROWSER — Playwright chromium driving the real UI (the journeys).
 * 2. DB — node:sqlite direct to the dev D1's WAL file (global-setup located
 *    it). SELECTs for assertions; short writes for fixture arrangement and
 *    the OTP rate-budget resets (dev-rate state only — the repo's convention).
 * 3. API — plain fetch against the app's own endpoints for ARRANGEMENT
 *    (artist project create / CSV upload / fan claim). Sessions are real
 *    cookies from the real verify endpoints.
 *
 * OTP recovery: the ConsoleMailer dev driver never sends mail, and its log
 * line is nondeterministically buffered through vite's workerd forwarding
 * (V-FE4's finding). Instead of parsing logs, the harness reads the pending
 * row's `code_hash` (HMAC-SHA256(code, OTP_PEPPER), hex — at rest) and
 * brute-forces the 10^6 candidates with the same pepper from .dev.vars
 * (~0.9 s). Deterministic, no log flake. The code is then typed into the
 * real UI exactly as a fan/artist would.
 *
 * Hydration discipline (T-FE5-retry's lesson): an init script installs a
 * capture-phase `submit` preventDefault so a pre-hydration submit can never
 * native-navigate; step forms are only driven after their autofocus effect
 * fired (which only exists post-hydration); stateless buttons use
 * clickUntil — click, poll for the expected state, retry.
 */
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

/** Repo root (e2e/ lives one level down). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5317';
export const DB_PATH = process.env.E2E_DB_PATH!;
const SECRETS = JSON.parse(process.env.E2E_SECRETS ?? '{}') as Record<string, string>;
export const OTP_PEPPER = SECRETS.OTP_PEPPER ?? '';
export const EMAIL_PEPPER = SECRETS.EMAIL_PEPPER ?? '';

if (!DB_PATH || !OTP_PEPPER || !EMAIL_PEPPER) {
	throw new Error('e2e harness: E2E_DB_PATH / E2E_SECRETS missing — global-setup must run first');
}

/** The bandcamp.com album page every fixture project uses (yum derives from it). */
export const FIXTURE_ALBUM_URL = 'https://arrangedgodly.bandcamp.com/album/taxed-tolled-and-eternally-trolled';
/** yum_url BE7 derives from FIXTURE_ALBUM_URL. */
export const FIXTURE_YUM_URL = 'https://arrangedgodly.bandcamp.com/yum';

// --- DB channel ----------------------------------------------------------------

let connection: DatabaseSync | undefined;

/** One long-lived sqlite handle per worker process (WAL + busy timeout). */
export function db(): DatabaseSync {
	if (!connection) {
		connection = new DatabaseSync(DB_PATH, { timeout: 10_000 });
		connection.exec('PRAGMA busy_timeout = 10000');
	}
	return connection;
}

export function sql<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[] {
	return db().prepare(query).all(...params) as T[];
}

export function sqlOne<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T | undefined {
	return db().prepare(query).get(...params) as T | undefined;
}

export function sqlRun(query: string, ...params: (string | number | null)[]): void {
	db().prepare(query).run(...params);
}

/** The canonical fan hash for an email (mirrors hashFanEmail: HMAC-SHA256 hex). */
export function fanHashFor(email: string): string {
	return createHmac('sha256', EMAIL_PEPPER).update(email.trim().toLowerCase()).digest('hex');
}

/** Dev rate-state reset — the suite's OTP sends never trip the real windows. */
export function resetOtpBudgets(): void {
	sqlRun('DELETE FROM otp_rate_counters');
}

/** Drop a subject's pending (resets its 60 s resend cooldown for a clean re-verify). */
export function clearOtpPending(purpose: 'artist' | 'fan', subject: string): void {
	sqlRun('DELETE FROM otp_pendings WHERE purpose = ? AND subject = ?', purpose, subject);
}

/**
 * Recover the 6-digit OTP for a subject: poll the pending row, then
 * brute-force its HMAC. The row is stored before the mailer is called
 * (BE3's store-then-send), so it exists the moment the endpoint returned.
 */
export async function solveOtp(purpose: 'artist' | 'fan', subject: string): Promise<string> {
	const deadline = Date.now() + 15_000;
	let row: { code_hash: string } | undefined;
	while (Date.now() < deadline) {
		row = sqlOne<{ code_hash: string }>(
			'SELECT code_hash FROM otp_pendings WHERE purpose = ? AND subject = ?',
			purpose,
			subject
		);
		if (row) break;
		await sleep(150);
	}
	if (!row) throw new Error(`solveOtp: no otp_pendings row for ${purpose} subject ${subject.slice(0, 16)}…`);
	for (let value = 0; value < 1_000_000; value++) {
		const code = String(value).padStart(6, '0');
		if (createHmac('sha256', OTP_PEPPER).update(code).digest('hex') === row.code_hash) return code;
	}
	throw new Error('solveOtp: brute force exhausted without a match (pepper mismatch?)');
}

// --- API arrangement channel ------------------------------------------------------

async function apiPost(path: string, body: unknown, cookie?: string, contentType = 'application/json') {
	const headers: Record<string, string> = { 'content-type': contentType };
	if (cookie) headers.cookie = cookie;
	return fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

function cookieFrom(response: Response, name: string): string {
	const lines = response.headers.getSetCookie?.() ?? [];
	const joined = lines.length > 0 ? lines.join('\n') : (response.headers.get('set-cookie') ?? '');
	const match = new RegExp(`${name}=([^;]+)`).exec(joined);
	if (!match) throw new Error(`no ${name} cookie in response`);
	return match[1]!;
}

/** A real artist session cookie, obtained through the real endpoints. */
export async function apiArtistSession(email: string): Promise<string> {
	resetOtpBudgets();
	const request = await apiPost('/api/artist/request-otp', { email });
	if (!request.ok) throw new Error(`artist request-otp failed: ${request.status}`);
	const code = await solveOtp('artist', email);
	const verify = await apiPost('/api/artist/verify-otp', { email, code });
	if (!verify.ok) throw new Error(`artist verify-otp failed: ${verify.status}`);
	return cookieFrom(verify, 'bc_artist_session');
}

/** Create a project via BE7 (returns its id + slug read back from D1). */
export async function apiCreateProject(
	artistCookie: string,
	opts: { title: string; artistName: string; albumUrl?: string }
): Promise<{ id: number; slug: string }> {
	const response = await apiPost(
		'/api/artist/projects',
		{ title: opts.title, artistName: opts.artistName, albumUrl: opts.albumUrl ?? FIXTURE_ALBUM_URL },
		`bc_artist_session=${artistCookie}`
	);
	const body = (await response.json().catch(() => null)) as { project?: { id?: number } } | null;
	const id = body?.project?.id;
	if (!response.ok || typeof id !== 'number') {
		throw new Error(`apiCreateProject failed: ${response.status} ${JSON.stringify(body)}`);
	}
	const row = sqlOne<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', id);
	if (!row) throw new Error(`project ${id} missing after create`);
	return { id, slug: row.slug };
}

/** Upload codes as a raw CSV body (BE7 accepts non-multipart text/csv). */
export async function apiUploadCsv(artistCookie: string, projectId: number, csvText: string): Promise<{ inserted: number }> {
	const response = await apiPost(
		`/api/artist/projects/${projectId}/upload`,
		csvText,
		`bc_artist_session=${artistCookie}`,
		'text/csv'
	);
	const body = (await response.json().catch(() => null)) as { inserted?: number } | null;
	if (!response.ok) throw new Error(`apiUploadCsv failed: ${response.status} ${JSON.stringify(body)}`);
	return { inserted: body?.inserted ?? 0 };
}

/**
 * A real fan claim through the real endpoints: OTP → verify (session cookie)
 * → dispense. Returns the claimed code + the fan session cookie.
 */
export async function apiFanClaim(email: string, slug: string): Promise<{ code: string; cookie: string; claimId: number }> {
	resetOtpBudgets();
	const hash = fanHashFor(email);
	const request = await apiPost('/api/fan/request-otp', { email });
	if (!request.ok) throw new Error(`fan request-otp failed: ${request.status}`);
	const code = await solveOtp('fan', hash);
	const verify = await apiPost('/api/fan/verify-otp', { email, code });
	if (!verify.ok) throw new Error(`fan verify-otp failed: ${verify.status}`);
	const cookie = cookieFrom(verify, 'bc_fan_session');
	const claim = await apiPost('/api/fan/claim', { slug }, `bc_fan_session=${cookie}`);
	const claimBody = (await claim.json().catch(() => null)) as
		| { ok?: boolean; claim?: { code?: string; claimId?: number } }
		| null;
	if (!claim.ok || !claimBody?.claim?.code) {
		throw new Error(`apiFanClaim failed: ${claim.status} ${JSON.stringify(claimBody)}`);
	}
	return { code: claimBody.claim.code, cookie, claimId: claimBody.claim.claimId ?? 0 };
}

/** A minimal Bandcamp-shaped CSV (same shape as tests/fixtures/bandcamp-export.csv). */
export function bandcampCsv(codes: string[]): string {
	return ['name of code set: qa2 e2e', 'date created: Aug-28-2026', '', 'code', ...codes].join('\n') + '\n';
}

// --- DB read helpers for assertions ------------------------------------------------

export interface ProjectState {
	id: number;
	slug: string;
	status: string;
	artworkStatus: string;
	total: number;
	available: number;
	claimed: number;
	reported: number;
}

export function projectState(slug: string): ProjectState {
	const row = sqlOne<{
		id: number;
		slug: string;
		status: string;
		artwork_status: string;
		total: number;
		available: number;
		claimed: number;
		reported: number;
	}>(
		`SELECT p.id, p.slug, p.status, p.artwork_status,
			COUNT(c.id) AS total,
			COALESCE(SUM(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END), 0) AS available,
			COALESCE(SUM(CASE WHEN c.status = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed,
			COALESCE(SUM(CASE WHEN c.status = 'reported' THEN 1 ELSE 0 END), 0) AS reported
		FROM projects p LEFT JOIN codes c ON c.project_id = p.id WHERE p.slug = ? GROUP BY p.id`,
		slug
	);
	if (!row) throw new Error(`project ${slug} not found`);
	return {
		id: row.id,
		slug: row.slug,
		status: row.status,
		artworkStatus: row.artwork_status,
		total: row.total,
		available: row.available,
		claimed: row.claimed,
		reported: row.reported
	};
}

export function claimRow(slug: string, fanHash: string) {
	return sqlOne<{
		id: number;
		kind: string;
		code_id: number;
		code: string;
		code_status: string;
		reissued_at: string | null;
		reported_at: string | null;
	}>(
		`SELECT cl.id, cl.kind, cl.code_id, c.code, c.status AS code_status, cl.reissued_at, c.reported_at
		FROM claims cl JOIN projects p ON p.id = cl.project_id JOIN codes c ON c.id = cl.code_id
		WHERE p.slug = ? AND cl.fan_hash = ?`,
		slug,
		fanHash
	);
}

export function claimCount(slug: string): number {
	return sqlOne<{ n: number }>(
		'SELECT COUNT(*) AS n FROM claims WHERE project_id = (SELECT id FROM projects WHERE slug = ?)',
		slug
	)!.n;
}

export function reportCount(slug: string): number {
	return sqlOne<{ n: number }>(
		`SELECT COUNT(*) AS n FROM reports WHERE claim_id IN (
			SELECT id FROM claims WHERE project_id = (SELECT id FROM projects WHERE slug = ?))`,
		slug
	)!.n;
}

// --- Browser discipline -----------------------------------------------------------

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Install the journey-wide guards: a capture-phase submit preventDefault so a
 * pre-hydration native submit can never navigate (Svelte's own handlers are
 * unaffected — they call preventDefault themselves).
 */
export async function prepare(page: Page): Promise<void> {
	await page.addInitScript(() => {
		document.addEventListener('submit', (event) => event.preventDefault(), true);
	});
}

/**
 * Console-error + horizontal-overflow health for a page. Errors accumulate
 * across the whole journey (nothing may EVER error); overflow is probed at
 * each call site (per surface).
 */
export function watchHealth(page: Page) {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(`console: ${message.text()}`);
	});
	return {
		async expectClean(tag: string) {
			const overflow = await page.evaluate(() => {
				const doc = document.documentElement;
				const body = document.body;
				return Math.max(doc.scrollWidth - doc.clientWidth, body ? body.scrollWidth - body.clientWidth : 0);
			});
			if (overflow > 0) errors.push(`horizontal overflow at "${tag}": ${overflow}px`);
			expect(errors, `page health at "${tag}"`).toEqual([]);
		}
	};
}

/** The autofocus effect only runs post-hydration — the strongest step-form signal. */
export async function waitForAutofocus(page: Page, selector: string): Promise<void> {
	await page.waitForFunction(
		(sel) => document.activeElement instanceof HTMLElement && document.activeElement.matches(sel),
		selector,
		{ timeout: 20_000 }
	);
}

/** Click until `until` holds — a pre-hydration click is a harmless no-op. */
export async function clickUntil(page: Page, selector: string, until: () => Promise<boolean>, tag: string): Promise<void> {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		await page.locator(selector).first().click({ timeout: 5_000 }).catch(() => undefined);
		for (let probe = 0; probe < 6; probe++) {
			if (await until()) return;
			await sleep(120);
		}
	}
	throw new Error(`clickUntil: condition "${tag}" never met for ${selector}`);
}

// --- Shared UI walkers --------------------------------------------------------------

/** Artist sign-in through the real console UI; lands on /console with the rail identity. */
export async function artistSignInUi(page: Page, email: string): Promise<void> {
	await page.goto('/console');
	await page.waitForURL(/\/console\/sign-in/);
	await waitForAutofocus(page, 'input[name="email"]');
	await page.fill('input[name="email"]', email);
	await clickUntil(
		page,
		'button:has-text("send my code")',
		() => page.locator('input[name="code"]').count().then((n) => n > 0),
		'otp step renders'
	);
	await waitForAutofocus(page, 'input[name="code"]');
	const code = await solveOtp('artist', email);
	await page.fill('input[name="code"]', code);
	await clickUntil(
		page,
		'button:has-text("verify + enter")',
		() => Promise.resolve(!page.url().includes('sign-in')),
		'console dashboard lands'
	);
	await expect(page.locator('.rail-nav__who')).toHaveText(email);
	await expect(page.locator('.rail-nav__out')).toBeVisible();
}

/** The fan launch sequence: LAUNCH CLAIM → email → OTP → the slab. */
export async function fanLaunchClaimUi(page: Page, slug: string, email: string): Promise<void> {
	await page.goto(`/p/${slug}`);
	await clickUntil(
		page,
		'button:has-text("launch claim")',
		() => page.locator('input[name="email"]').count().then((n) => n > 0),
		'email step renders'
	);
	await waitForAutofocus(page, 'input[name="email"]');
	await page.fill('input[name="email"]', email);
	await clickUntil(
		page,
		'button:has-text("send my code")',
		() => page.locator('input[name="code"]').count().then((n) => n > 0),
		'otp step renders'
	);
	await waitForAutofocus(page, 'input[name="code"]');
	const code = await solveOtp('fan', fanHashFor(email));
	await page.fill('input[name="code"]', code);
	await clickUntil(
		page,
		'button:has-text("verify + claim")',
		() => page.locator('.slab__code').count().then((n) => n > 0),
		'code slab renders'
	);
	// The steps() power-on settles ~1.4 s after a fresh dispense.
	await sleep(1_600);
}
