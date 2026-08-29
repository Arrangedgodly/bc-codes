/**
 * QA2 journey 5 — DRAINED: the last code finds its fan.
 *
 * Arranged via the app's own API: a live drop with exactly 2 codes, one
 * already claimed by fan A through the real endpoints (1 available, still
 * active). Fan B claims the LAST code through the real UI → the project
 * auto-drains in the same dispense transaction → the board drops it → a
 * fresh anonymous visitor sees the all-claimed honest state on the project
 * page → the artist console shows drained stats.
 */
import { expect, test, type BrowserContext } from '@playwright/test';
import {
	apiArtistSession,
	apiCreateProject,
	apiFanClaim,
	apiUploadCsv,
	BASE_URL,
	bandcampCsv,
	claimCount,
	claimRow,
	fanHashFor,
	fanLaunchClaimUi,
	prepare,
	projectState,
	resetOtpBudgets,
	sqlRun,
	watchHealth
} from './harness';

const ROUNDS = [1, 2] as const;
const POOL = ['d24n-0001', 'd24n-0002'];

for (const round of ROUNDS) {
	test(`drained journey — last claim auto-drains, board + page + console honest (round ${round})`, async ({
		page,
		browser
	}, testInfo) => {
		const viewport = testInfo.project.name;
		const slug = `qa2-j5-${viewport}-r${round}`;
		const fanA = `qa2-fanA-j5-${viewport}-r${round}@bc-codes.test`;
		const fanB = `qa2-fanB-j5-${viewport}-r${round}@bc-codes.test`;

		await prepare(page);
		await resetOtpBudgets();
		const health = watchHealth(page);

		// --- arrange: 2 codes, fan A holds one (via the real endpoints) ---
		const artistEmail = `qa2-fixture-j5-${viewport}-r${round}@bc-codes.test`;
		const artistCookie = await apiArtistSession(artistEmail);
		const project = await apiCreateProject(artistCookie, {
			title: `QA2 J5 ${viewport} r${round}`,
			artistName: `qa2-j5-${viewport}-r${round}`
		});
		await apiUploadCsv(artistCookie, project.id, bandcampCsv(POOL));
		sqlRun('UPDATE projects SET slug = ? WHERE id = ?', slug, project.id);
		const heldByA = await apiFanClaim(fanA, slug);
		expect(POOL).toContain(heldByA.code);
		const lastCode = POOL.find((code) => code !== heldByA.code)!;
		expect(projectState(slug)).toMatchObject({ status: 'active', available: 1, claimed: 1 });

		// --- act: fan B claims the LAST code through the real UI ---
		await fanLaunchClaimUi(page, slug, fanB);
		await expect(page.locator('.slab__code')).toHaveText(lastCode);
		await health.expectClean('fan B slab (the last code)');

		// --- DB side effects: auto-drained inside the dispense batch ---
		const drained = projectState(slug);
		expect(drained.status).toBe('drained');
		expect(drained.available).toBe(0);
		expect(drained.claimed).toBe(2);
		expect(drained.total).toBe(2);
		const claimB = claimRow(slug, fanHashFor(fanB))!;
		expect(claimB.code).toBe(lastCode);
		expect(claimCount(slug)).toBe(2);

		// --- the board drops it ---
		await page.goto('/');
		await expect(page.locator(`a.cell__link[href="/p/${slug}"]`)).toHaveCount(0);
		await health.expectClean('board without the drained drop');

		// --- a fresh anonymous visitor sees the all-claimed honest state ---
		const anon: BrowserContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
		const anonPage = await anon.newPage();
		try {
			await prepare(anonPage);
			const anonHealth = watchHealth(anonPage);
			await anonPage.goto(`/p/${slug}`);
			await expect(anonPage.locator('.chip__text').filter({ hasText: 'drained' })).toBeVisible();
			await expect(anonPage.getByText('All 2 codes from this drop are claimed', { exact: false })).toBeVisible();
			await expect(anonPage.getByText('every one found a fan', { exact: false })).toBeVisible();
			await expect(anonPage.getByRole('link', { name: /follow .* on bandcamp/i })).toHaveAttribute(
				'href',
				'https://arrangedgodly.bandcamp.com/album/taxed-tolled-and-eternally-trolled'
			);
			await expect(anonPage.getByRole('button', { name: 'launch claim' })).toHaveCount(0);
			await expect(anonPage.locator('.slab__code')).toHaveCount(0);
			await anonHealth.expectClean('drained project page (anonymous)');
		} finally {
			await anon.close();
		}

		// --- the artist console shows drained ---
		const artist: BrowserContext = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
		const artistPage = await artist.newPage();
		try {
			await prepare(artistPage);
			const artistHealth = watchHealth(artistPage);
			await artist.addCookies([
				{
					name: 'bc_artist_session',
					value: artistCookie,
					domain: new URL(BASE_URL).hostname,
					path: '/',
					httpOnly: true,
					sameSite: 'Lax'
				}
			]);
			await artistPage.goto(`/console/${project.id}`);
			await expect(artistPage.locator('.chip__text').filter({ hasText: 'drained' })).toBeVisible();
			await expect(artistPage.locator('[aria-label="codes remaining: 0"]')).toBeVisible();
			await expect(artistPage.getByText('drained — all 2 codes claimed; uploading new codes re-activates')).toBeVisible();
			await expect(artistPage.getByText('2 claimed · 0 reported', { exact: false })).toBeVisible();
			await artistHealth.expectClean('artist console (drained)');
		} finally {
			await artist.close();
		}
	});
}
