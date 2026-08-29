/**
 * QA2 journey 4 — REPORT a dead code → replacement → honest refusal.
 *
 * Arranged via the app's own API: a live drop with 3 codes; the fan claims
 * one through the real endpoints (session cookie captured — a REAL cookie
 * from the real verify endpoint, installed into the browser so the journey
 * starts exactly where a code-holder starts: their slab). Through the UI:
 * report the dead code (inline confirm) → the replacement slab renders a
 * code from the REMAINING pool → the old code is reported in the DB → a
 * second report is refused honestly (UI affordance gone + note; the stale
 * API attempt answers already_reissued and writes nothing).
 */
import { expect, test } from '@playwright/test';
import {
	apiArtistSession,
	apiCreateProject,
	apiFanClaim,
	apiUploadCsv,
	BASE_URL,
	bandcampCsv,
	claimCount,
	claimRow,
	clickUntil,
	fanHashFor,
	FIXTURE_YUM_URL,
	prepare,
	projectState,
	reportCount,
	resetOtpBudgets,
	sql,
	sqlRun,
	watchHealth
} from './harness';

const ROUNDS = [1, 2] as const;
const POOL = ['r3p0-aaaa', 'r3p0-bbbb', 'r3p0-cccc'];

for (const round of ROUNDS) {
	test(`report journey — dead code → replacement → honest refusal (round ${round})`, async ({
		page,
		context
	}, testInfo) => {
		const viewport = testInfo.project.name;
		const slug = `qa2-j4-${viewport}-r${round}`;
		const fanEmail = `qa2-fan-j4-${viewport}-r${round}@bc-codes.test`;
		const fanHash = fanHashFor(fanEmail);

		await prepare(page);
		await resetOtpBudgets();
		const health = watchHealth(page);

		// --- arrange: live drop (3 codes) + the fan holds one claim ---
		const artistEmail = `qa2-fixture-j4-${viewport}-r${round}@bc-codes.test`;
		const artistCookie = await apiArtistSession(artistEmail);
		const project = await apiCreateProject(artistCookie, {
			title: `QA2 J4 ${viewport} r${round}`,
			artistName: `qa2-j4-${viewport}-r${round}`
		});
		await apiUploadCsv(artistCookie, project.id, bandcampCsv(POOL));
		sqlRun('UPDATE projects SET slug = ? WHERE id = ?', slug, project.id);
		const held = await apiFanClaim(fanEmail, slug);
		expect(POOL).toContain(held.code);
		await context.addCookies([
			{
				name: 'bc_fan_session',
				value: held.cookie,
				domain: new URL(BASE_URL).hostname,
				path: '/',
				httpOnly: true,
				sameSite: 'Lax'
			}
		]);
		// The remaining pool = the two codes the fan does NOT hold.
		const remaining = POOL.filter((code) => code !== held.code);

		// --- act: the holder's project page SSR re-shows their slab ---
		await page.goto(`/p/${slug}`);
		await expect(page.locator('.slab__code')).toHaveText(held.code);
		await expect(page.getByText('Still yours', { exact: false })).toBeVisible();
		await health.expectClean('slab (holder re-show)');

		// --- report the dead code: inline two-step confirm ---
		await clickUntil(
			page,
			'button.slab__report-link',
			() => page.locator('.slab__confirm').count().then((n) => n > 0),
			'report confirm renders'
		);
		await expect(page.locator('.slab__confirm')).toContainText(`report ${held.code} as already redeemed?`);
		const replacement = page.locator('.slab__code');
		await clickUntil(
			page,
			'button.slab__report-go',
			() => replacement.textContent().then((text) => text?.trim() !== held.code),
			'replacement slab renders'
		);
		await expect(replacement).not.toHaveText(held.code);
		const replacementCode = (await replacement.textContent())?.trim();
		// The replacement comes from the remaining pool — never the dead code,
		// never a fabrication.
		expect(remaining).toContain(replacementCode!);
		await expect(page.locator('.slab__notice')).toContainText(`Reported ${held.code} — here is your replacement.`);
		await expect(page.locator('a.slab__redeem')).toHaveAttribute('href', `${FIXTURE_YUM_URL}?code=${replacementCode}`);
		await health.expectClean('slab (replacement)');

		// --- exactly-one honesty in the UI ---
		await expect(page.getByText('your one replacement was already issued')).toBeVisible();
		await expect(page.locator('button.slab__report-link')).toHaveCount(0);

		// --- a stale second report is refused honestly, writing nothing ---
		const second = await page.request.post('/api/fan/report', { data: { slug } });
		expect(second.ok()).toBe(true);
		const secondBody = (await second.json()) as { outcome?: string };
		expect(secondBody.outcome).toBe('already_reissued');
		expect(reportCount(slug)).toBe(1);

		// --- DB side effects ---
		expect(claimCount(slug)).toBe(1); // the SAME claim row, re-pointed — never a second
		const claim = claimRow(slug, fanHash)!;
		expect(claim.kind).toBe('reissue');
		expect(claim.code).toBe(replacementCode);
		expect(claim.reissued_at).not.toBeNull();
		const deadRow = sql<{ code: string; status: string; reported_at: string }>(
			'SELECT code, status, reported_at FROM codes WHERE project_id = ? AND code = ?',
			project.id,
			held.code
		)[0]!;
		expect(deadRow.status).toBe('reported');
		expect(deadRow.reported_at).not.toBeNull();
		const reportRow = sql<{ code: string }>(
			`SELECT c.code FROM reports r JOIN codes c ON c.id = r.code_id WHERE r.claim_id = ?`,
			claim.id
		)[0]!;
		expect(reportRow.code).toBe(held.code);
		const state = projectState(slug);
		// Pool ledger after the report: one dead (reported), one live with the
		// fan (claimed), one untouched (available).
		expect(state.reported).toBe(1);
		expect(state.claimed).toBe(1);
		expect(state.available).toBe(1);
		expect(state.total).toBe(3);
		expect(state.status).toBe('active');
	});
}
