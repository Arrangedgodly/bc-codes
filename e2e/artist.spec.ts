/**
 * QA2 journey 1 — ARTIST: CSV → shareable link.
 *
 * sign-in (email → OTP recovered from the OTP table, typed into the real
 * command-entry UI) → create project with a REAL bandcamp album URL (artwork
 * fetch fails gracefully in the dev sandbox — asserted honest, never a
 * crash) → upload the REAL fixture CSV (tests/fixtures/bandcamp-export.csv,
 * exactly one code: lqq8-cvw2) → parse feedback shows 1 imported and the
 * drop going live → share link copies → the project page shows active +
 * available, and the board carries the drop.
 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
	artistSignInUi,
	clickUntil,
	FIXTURE_ALBUM_URL,
	prepare,
	projectState,
	resetOtpBudgets,
	ROOT,
	sqlOne,
	watchHealth
} from './harness';

const ROUNDS = [1, 2] as const;

for (const round of ROUNDS) {
	test(`artist journey — console sign-in → create → CSV upload → share link (round ${round})`, async ({
		page,
		context
	}, testInfo) => {
		const viewport = testInfo.project.name; // desktop | mobile
		const email = `qa2-artist-j1-${viewport}-r${round}@bc-codes.test`;
		const title = `QA2 J1 ${viewport} r${round}`;
		const artistName = `qa2-j1-${viewport}-r${round}`;

		await prepare(page);
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await resetOtpBudgets();
		const health = watchHealth(page);

		// --- sign-in: /console bounces to sign-in with returnTo, then OTP in ---
		await artistSignInUi(page, email);
		await expect(page).toHaveURL(/\/console$/);
		await health.expectClean('console dashboard (signed in)');

		// The dashboard must show the artist's own drop(s) only — this fresh
		// artist starts honest-empty.
		await expect(page.getByText('No drops yet')).toBeVisible();

		// --- create the project (real bandcamp URL) ---
		await page.goto('/console/new');
		await page.fill('input[name="title"]', title);
		await page.fill('input[name="artistName"]', artistName);
		await page.fill('input[name="albumUrl"]', FIXTURE_ALBUM_URL);
		await clickUntil(
			page,
			'button:has-text("create drop")',
			() => Promise.resolve(/\/console\/\d+$/.test(page.url())),
			'detail page lands'
		);
		const projectId = Number(page.url().match(/\/console\/(\d+)$/)?.[1]);
		expect(projectId).toBeGreaterThan(0);
		const { slug } = sqlOne<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', projectId)!;
		expect(slug.startsWith('qa2-j1')).toBe(true);

		// Draft honesty: draft chip, no share link yet.
		await expect(page.locator('.chip__text').filter({ hasText: 'draft' })).toBeVisible();
		await expect(page.getByText('share link activates when the drop goes live', { exact: false })).toBeVisible();
		await health.expectClean('detail (draft)');

		// Artwork fails gracefully in the dev sandbox: the album page 404s from
		// here, so BE8 settles to the honest fallback (or stays pending while
		// its ~5 s fetch times out) — either way the page never breaks.
		const artworkDeadline = Date.now() + 25_000;
		for (;;) {
			const state = projectState(slug);
			if (state.artworkStatus !== 'pending' || Date.now() > artworkDeadline) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		expect(['fallback', 'pending']).toContain(projectState(slug).artworkStatus);

		// --- upload the REAL fixture CSV through the native input ---
		const csvPath = path.join(ROOT, 'tests/fixtures/bandcamp-export.csv');
		await page.setInputFiles('input.dropzone__native', csvPath);
		const feedback = page.locator('[role="region"][aria-label="upload feedback"]');
		await expect(feedback).toBeVisible();
		// The seven-segment readout carries the real number in its aria-label.
		await expect(feedback.locator('.sevenseg[aria-label="codes imported: 1"]')).toBeVisible();
		await expect(feedback).toContainText('1 of 1 parsed code imported — the drop is now live on the wall');
		await health.expectClean('detail (upload feedback)');

		// --- share link copies ---
		const shareInput = page.locator('input[aria-label="share link"]');
		await expect(shareInput).toHaveValue(`${new URL(page.url()).origin}/p/${slug}`);
		await page.click('button[aria-label="copy share link"]');
		await expect(page.getByText('copied — paste it anywhere')).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			`${new URL(page.url()).origin}/p/${slug}`
		);

		// --- project page: active + available ---
		await page.goto(`/p/${slug}`);
		await expect(page.locator('.chip__text').filter({ hasText: 'available' })).toBeVisible();
		await expect(page.locator('[aria-label="codes remaining: 1"]')).toBeVisible();
		await expect(page.getByRole('button', { name: 'launch claim' })).toBeVisible();
		await health.expectClean('project page (active)');

		// --- board carries the drop ---
		await page.goto('/');
		await expect(page.locator(`a.cell__link[href="/p/${slug}"]`)).toBeVisible();
		await health.expectClean('board with the new drop');

		// --- DB side effects ---
		const state = projectState(slug);
		expect(state.status).toBe('active');
		expect(state.total).toBe(1);
		expect(state.available).toBe(1);
		const codeRow = sqlOne<{ code: string; status: string }>(
			'SELECT code, status FROM codes WHERE project_id = ?',
			projectId
		)!;
		expect(codeRow.code).toBe('lqq8-cvw2');
		expect(codeRow.status).toBe('available');
		const artistRow = sqlOne<{ id: number }>('SELECT id FROM artists WHERE email = ?', email)!;
		expect(sqlOne<{ n: number }>('SELECT COUNT(*) AS n FROM projects WHERE artist_id = ?', artistRow.id)!.n).toBe(1);

		// The artist browser is a fan-side nobody: no fan session cookie exists.
		expect((await context.cookies()).filter((cookie) => cookie.name === 'bc_fan_session')).toEqual([]);
	});
}
