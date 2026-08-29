/**
 * QA2 journey 3 — FAN MY-CODES on a new device.
 *
 * Arranged via the app's own API: a live drop; device 1 (a real browser
 * context) claims through the real UI — the cross-device premise of FE4.
 * Device 2 is a SECOND, brand-new browser context (fresh profile + cookie
 * jar): /my-codes starts at the entry panel → re-verify the SAME email by
 * OTP → the archive lists the claim with the same code.
 */
import { expect, test, type BrowserContext } from '@playwright/test';
import {
	apiArtistSession,
	apiCreateProject,
	apiUploadCsv,
	bandcampCsv,
	claimCount,
	claimRow,
	clearOtpPending,
	clickUntil,
	FIXTURE_YUM_URL,
	fanHashFor,
	fanLaunchClaimUi,
	prepare,
	resetOtpBudgets,
	solveOtp,
	sqlOne,
	sqlRun,
	waitForAutofocus,
	watchHealth
} from './harness';

const ROUNDS = [1, 2] as const;

for (const round of ROUNDS) {
	test(`fan my-codes journey — new device → re-verify → archive (round ${round})`, async ({
		page,
		browser
	}, testInfo) => {
		const viewport = testInfo.project.name;
		const slug = `qa2-j3-${viewport}-r${round}`;
		const fanEmail = `qa2-fan-j3-${viewport}-r${round}@bc-codes.test`;
		const fanHash = fanHashFor(fanEmail);

		await prepare(page);
		await resetOtpBudgets();
		const health = watchHealth(page);

		// --- arrange: a live drop; device 1 claims it through the real UI ---
		const artistEmail = `qa2-fixture-j3-${viewport}-r${round}@bc-codes.test`;
		const artistCookie = await apiArtistSession(artistEmail);
		const project = await apiCreateProject(artistCookie, {
			title: `QA2 J3 ${viewport} r${round}`,
			artistName: `qa2-j3-${viewport}-r${round}`
		});
		await apiUploadCsv(artistCookie, project.id, bandcampCsv(['j3a0-0001', 'j3a0-0002']));
		sqlRun('UPDATE projects SET slug = ? WHERE id = ?', slug, project.id);
		await fanLaunchClaimUi(page, slug, fanEmail);
		const deviceOneCode = (await page.locator('.slab__code').textContent())?.trim();
		expect(deviceOneCode).toMatch(/^j3a0-\d{4}$/);
		await health.expectClean('device-1 claim (UI)');

		// --- act: device 2 — a brand-new browser context (fresh profile) ---
		const device2: BrowserContext = await browser.newContext({
			viewport: page.viewportSize() ?? undefined
		});
		const page2 = await device2.newPage();
		try {
			await prepare(page2);
			const health2 = watchHealth(page2);
			clearOtpPending('fan', fanHash); // clean re-verify (no 60 s subject cooldown)
			resetOtpBudgets();

			await page2.goto('/my-codes');
			await expect(page2.getByText('claim archive · verify to open')).toBeVisible();
			// Zero code strings before verification — the archive is locked.
			expect(await page2.content()).not.toContain(deviceOneCode!);
			await health2.expectClean('my-codes entry (unverified, device 2)');

			// Re-verify the same email through the entry panel.
			await page2.fill('input[name="email"]', fanEmail);
			await clickUntil(
				page2,
				'button:has-text("send my code")',
				() => page2.locator('input[name="code"]').count().then((n) => n > 0),
				'otp step renders (device 2)'
			);
			await waitForAutofocus(page2, 'input[name="code"]');
			const code = await solveOtp('fan', fanHash);
			await page2.fill('input[name="code"]', code);
			const archive = page2.locator('[role="region"][aria-label="your claim archive"]');
			await clickUntil(
				page2,
				'button:has-text("verify + open archive")',
				() => archive.isVisible(),
				'archive opens (device 2)'
			);
			await expect(archive).toBeVisible();
			await health2.expectClean('my-codes archive (verified, device 2)');

			// --- the archive lists the claim with the SAME code ---
			const row = archive.locator('article.claim', { hasText: 'QA2 J3' });
			await expect(row.locator('.claim__code')).toHaveText(deviceOneCode!);
			await expect(row.locator('a.claim__artist')).toHaveAttribute('href', `/p/${slug}`);
			await expect(row.locator('.chip__text')).toHaveText('claimed — yours');
			await expect(row.locator('a.claim__redeem')).toHaveAttribute(
				'href',
				`${FIXTURE_YUM_URL}?code=${deviceOneCode}`
			);

			// --- DB side effects: still one claim; the new device has its own session ---
			expect(claimCount(slug)).toBe(1);
			const claim = claimRow(slug, fanHash)!;
			expect(claim.code).toBe(deviceOneCode);
			const sessions = sqlOne<{ n: number }>(
				`SELECT COUNT(*) AS n FROM fan_sessions s JOIN fan_identities f ON f.id = s.fan_id WHERE f.email_hash = ?`,
				fanHash
			)!;
			expect(sessions.n).toBeGreaterThanOrEqual(2); // device 1 + device 2
		} finally {
			await device2.close();
		}
	});
}
