/**
 * QA2 journey 2 — FAN CLAIM: board → project → LAUNCH CLAIM → email → OTP →
 * the code slab.
 *
 * Arranged via the app's own API (a real artist session creates a drop whose
 * pool is EXACTLY one code, lqq8-cvw2, so the random dispense is
 * deterministic). The fan then claims entirely through the real UI: the board
 * shows the drop → project page → LAUNCH CLAIM → email → OTP → slab renders
 * the seeded code exactly → copy affordance present → redeem href exact
 * `<yum>?code=lqq8-cvw2` → revisit re-shows the SAME code with no second
 * dispense (claims count 1).
 */
import { expect, test } from '@playwright/test';
import {
	apiArtistSession,
	apiCreateProject,
	apiUploadCsv,
	bandcampCsv,
	claimCount,
	claimRow,
	FIXTURE_YUM_URL,
	fanHashFor,
	fanLaunchClaimUi,
	prepare,
	projectState,
	resetOtpBudgets,
	sqlRun,
	watchHealth
} from './harness';

const ROUNDS = [1, 2] as const;
const SEEDED_CODE = 'lqq8-cvw2';

for (const round of ROUNDS) {
	test(`fan claim journey — board → launch claim → slab → revisit (round ${round})`, async ({
		page,
		context
	}, testInfo) => {
		const viewport = testInfo.project.name;
		const slug = `qa2-j2-${viewport}-r${round}`;
		const fanEmail = `qa2-fan-j2-${viewport}-r${round}@bc-codes.test`;
		const fanHash = fanHashFor(fanEmail);

		await prepare(page);
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await resetOtpBudgets();
		const health = watchHealth(page);

		// --- arrange: a real artist + a live drop with exactly one code ---
		const artistEmail = `qa2-fixture-j2-${viewport}-r${round}@bc-codes.test`;
		const artistCookie = await apiArtistSession(artistEmail);
		const project = await apiCreateProject(artistCookie, {
			title: `QA2 J2 ${viewport} r${round}`,
			artistName: `qa2-j2-${viewport}-r${round}`
		});
		await apiUploadCsv(artistCookie, project.id, bandcampCsv([SEEDED_CODE]));
		// Pin the fixture at this round's exact slug so journeys never collide.
		sqlRun('UPDATE projects SET slug = ? WHERE id = ?', slug, project.id);
		const arranged = projectState(slug);
		expect(arranged.status).toBe('active');
		expect(arranged.available).toBe(1);

		// --- act: the board shows the drop ---
		await page.goto('/');
		await expect(page.locator(`a.cell__link[href="/p/${slug}"]`)).toBeVisible();
		await health.expectClean('board shows the arranged drop');

		// --- the project page → launch claim through the real UI ---
		await page.click(`a.cell__link[href="/p/${slug}"]`);
		await page.waitForURL(new RegExp(`/p/${slug}$`));
		await fanLaunchClaimUi(page, slug, fanEmail);

		// --- the slab: the seeded code exactly ---
		await expect(page.locator('.slab__code')).toHaveText(SEEDED_CODE);
		const redeem = page.locator('a.slab__redeem');
		await expect(redeem).toHaveAttribute('href', `${FIXTURE_YUM_URL}?code=${SEEDED_CODE}`);
		await expect(redeem).toHaveAttribute('target', '_blank');
		await expect(redeem).toHaveAttribute('rel', 'noopener noreferrer');
		// The spelled-out aria label (dash as a word).
		await expect(page.locator('.slab__code')).toHaveAttribute(
			'aria-label',
			'Your download code, spelled out: l, q, q, 8, dash, c, v, w, 2'
		);
		await health.expectClean('code slab (fresh claim)');

		// --- copy affordance present + works ---
		await expect(page.locator('button.slab__copy')).toBeVisible();
		// Pointer-honest wording (refine 1): "click" on fine pointers, "tap" on coarse.
		await expect(
			page.getByText(`${viewport === 'mobile' ? 'tap' : 'click'} the code to select it`)
		).toBeVisible();
		await page.click('button.slab__copy');
		await expect(page.locator('button.slab__copy')).toHaveText(/copied/);
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SEEDED_CODE);

		// --- revisit: same code, no second dispense ---
		await page.reload();
		await expect(page.locator('.slab__code')).toHaveText(SEEDED_CODE);
		await expect(page.getByText('Still yours', { exact: false })).toBeVisible();
		await health.expectClean('code slab (SSR revisit)');

		// --- DB side effects: exactly one claim, the code claimed ---
		expect(claimCount(slug)).toBe(1);
		const claim = claimRow(slug, fanHash)!;
		expect(claim.code).toBe(SEEDED_CODE);
		expect(claim.code_status).toBe('claimed');
		expect(claim.kind).toBe('original');
		const state = projectState(slug);
		expect(state.claimed).toBe(1);
		expect(state.available).toBe(0);
		// The single-code pool auto-drained on its only dispense (BE5).
		expect(state.status).toBe('drained');
	});
}
