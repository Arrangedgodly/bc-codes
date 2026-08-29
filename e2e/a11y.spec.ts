/**
 * QA3 — accessibility audit (WCAG 2.1 AA) over every surface/state, at both
 * contract viewports (1440×900 + 390×844), in two layers:
 *
 * AUTOMATED — axe-core (@axe-core/playwright) with the wcag2a/wcag2aa/
 * wcag21a/wcag21aa tag sets scans every surface in every state:
 *   board (populated + EMPTY), project (active/paused/drained), claim steps
 *   (email/otp/slab fresh + slab SSR revisit), my-codes (entry/archive/empty),
 *   console (sign-in/dashboard/new/detail). axe's color-contrast rule IS the
 *   live-DOM half of FE1's contrast re-audit (the token-table half is
 *   recomputed in tests/contrast.test.ts).
 *
 * MANUAL PROTOCOL, formalized as executable checks:
 *   - keyboard-only full journeys (fan claim; artist sign-in → create →
 *     upload) — Tab/Enter/typing only, never a mouse click;
 *   - focus visibility everywhere (every tab stop must draw a visible
 *     indicator: outline, glow, or drawn focus brackets);
 *   - reduced-motion renders settled states (emulated reduce: zero running
 *     animations on the board and the slab, code fully opaque);
 *   - aria spelling of codes (screen readers read characters, dash as a word);
 *   - JP micro-labels are aria-hidden decorative-only;
 *   - heading hierarchy per page (exactly one h1, no skipped levels).
 *
 * Health (zero console/page errors — QA2's baseline) is asserted at every
 * scan, which also proves the QA3 security-headers CSP breaks nothing.
 *
 * Fixtures are qa3- prefixed and cleaned by global-setup (setup + teardown).
 * The empty-board state pauses EVERY active project (baseline included) for
 * the duration of one scan and restores the exact prior rows in finally.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
	apiArtistSession,
	apiCreateProject,
	apiFanClaim,
	apiUploadCsv,
	BASE_URL,
	bandcampCsv,
	clickUntil,
	fanHashFor,
	FIXTURE_ALBUM_URL,
	prepare,
	resetOtpBudgets,
	solveOtp,
	sql,
	sqlOne,
	sqlRun,
	watchHealth
} from './harness';

// --- the audit helpers ------------------------------------------------------------

/** Every scanned surface gets all three: axe, JP-decorative, headings. */
async function scan(page: Page, name: string) {
	const health = watchHealth(page);
	// The slab/my-codes GHOST layers (DSEG7 "unlit segments", ~1.1:1 by design,
	// aria-hidden) are purely decorative text — exempt from WCAG 1.4.3 — so
	// they are excluded from the contrast check with that justification.
	const results = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.exclude('.slab__ghost')
		.exclude('.claim__ghost')
		.analyze();
	const summary = results.violations.map((v) => ({
		id: v.id,
		impact: v.impact,
		nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' '))
	}));
	expect(summary, `axe violations at "${name}"`).toEqual([]);

	await checkJpDecorative(page, name);
	await checkHeadings(page, name);
	await health.expectClean(name);
}

/** Every element containing Japanese micro-label text sits inside an aria-hidden subtree. */
async function checkJpDecorative(page: Page, name: string) {
	const offenders = await page.evaluate(() => {
		const jp = /[\u3040-\u30ff\u4e00-\u9fff]/;
		const offenders: string[] = [];
		for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
			const ownText = Array.from(el.childNodes)
				.filter((n) => n.nodeType === Node.TEXT_NODE)
				.map((n) => n.textContent ?? '')
				.join('');
			if (!jp.test(ownText)) continue;
			if (!el.closest('[aria-hidden="true"]')) {
				offenders.push(`${el.tagName.toLowerCase()}.${el.className}: "${ownText.trim()}"`);
			}
		}
		return offenders;
	});
	expect(offenders, `JP micro-labels decorative-only at "${name}"`).toEqual([]);
}

/** Exactly one h1 per page; heading levels never skip. */
async function checkHeadings(page: Page, name: string) {
	const report = await page.evaluate(() => {
		const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
		const levels = headings.map((h) => Number(h.tagName.slice(1)));
		const skips: string[] = [];
		for (let i = 1; i < levels.length; i++) {
			if (levels[i]! > levels[i - 1]! + 1) {
				skips.push(`h${levels[i - 1]} → h${levels[i]}`);
			}
		}
		return { h1: levels.filter((l) => l === 1).length, skips };
	});
	expect(report.h1, `exactly one h1 at "${name}"`).toBe(1);
	expect(report.skips, `no skipped heading levels at "${name}"`).toEqual([]);
}

/**
 * Tab through the page; every interactive tab stop must draw a visible focus
 * indicator. The design system uses four grammar shapes, all accepted:
 * an outline (element or ::after/::before), a glow (box-shadow), drawn focus
 * brackets (a pseudo-element with background-image that becomes visible), or
 * an outline on a DESCENDANT while focused (the console's drop title links
 * trace the child title, not the anchor box).
 */
async function tabFocusAudit(page: Page, name: string, maxTabs = 16) {
	const problems: string[] = [];
	for (let i = 0; i < maxTabs; i++) {
		await page.keyboard.press('Tab');
		const result = await page.evaluate(() => {
			const el = document.activeElement;
			if (!el || el === document.body || !(el instanceof HTMLElement)) return null;
			if (!el.closest('a, button, input, select, textarea, [tabindex]')) return null;
			const cs = getComputedStyle(el);
			const after = getComputedStyle(el, '::after');
			const before = getComputedStyle(el, '::before');
			const outline = (s: CSSStyleDeclaration) => s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1.5;
			const drawn = (s: CSSStyleDeclaration) => parseFloat(s.opacity) > 0 && s.backgroundImage !== 'none';
			const childOutlined = Array.from(el.querySelectorAll<HTMLElement>('*')).some((child) => {
				const ccs = getComputedStyle(child);
				return ccs.outlineStyle !== 'none' && parseFloat(ccs.outlineWidth) >= 1.5;
			});
			const visible =
				outline(cs) || cs.boxShadow !== 'none' || outline(after) || outline(before) || drawn(after) || drawn(before) || childOutlined;
			const cls = typeof el.className === 'string' ? el.className : '';
			return { tag: el.tagName.toLowerCase(), cls, text: (el.textContent ?? '').trim().slice(0, 30), visible };
		});
		if (result && !result.visible) problems.push(JSON.stringify(result));
	}
	expect(problems, `visible focus indicators at "${name}"`).toEqual([]);
}

/** Keyboard-walk until the active element matches a plain-CSS selector. */
async function tabUntil(page: Page, selector: string, maxTabs = 25): Promise<void> {
	for (let i = 0; i < maxTabs; i++) {
		const focused = await page.evaluate(
			(sel) => document.activeElement instanceof HTMLElement && document.activeElement.matches(sel),
			selector
		);
		if (focused) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`tabUntil: ${selector} never received focus`);
}

/**
 * Keyboard-only hydration guard: press Enter on the focused control until
 * `until` holds (a pre-hydration Enter is a harmless no-op — the same
 * discipline as the harness's clickUntil, keyboard flavor).
 */
async function enterUntil(page: Page, until: () => Promise<boolean>, tag: string): Promise<void> {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		await page.keyboard.press('Enter');
		for (let probe = 0; probe < 6; probe++) {
			if (await until()) return;
			await page.waitForTimeout(120);
		}
	}
	throw new Error(`enterUntil: condition "${tag}" never met`);
}

/** A verified fan session cookie WITHOUT any claim (my-codes empty state). */
async function verifyFanWithoutClaim(email: string): Promise<string> {
	resetOtpBudgets();
	const request = await fetch(`${BASE_URL}/api/fan/request-otp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email })
	});
	if (!request.ok) throw new Error(`fan request-otp failed: ${request.status}`);
	const code = await solveOtp('fan', fanHashFor(email));
	const verify = await fetch(`${BASE_URL}/api/fan/verify-otp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, code })
	});
	if (!verify.ok) throw new Error(`fan verify-otp failed: ${verify.status}`);
	const setCookie = verify.headers.getSetCookie?.().join('\n') ?? '';
	const match = /bc_fan_session=([^;]+)/.exec(setCookie);
	if (!match) throw new Error('no fan session cookie in verify response');
	return match[1]!;
}

/** Pause a project through the real PATCH endpoint (real status machine). */
async function pauseProject(artistCookieValue: string, projectId: number): Promise<void> {
	const response = await fetch(`${BASE_URL}/api/artist/projects/${projectId}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', cookie: `bc_artist_session=${artistCookieValue}` },
		body: JSON.stringify({ status: 'paused' })
	});
	if (!response.ok) throw new Error(`pause PATCH failed: ${response.status}`);
}

const installCookie = (name: string, value: string) => [
	{ name, value, domain: new URL(BASE_URL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' as const }
];

// --- fixtures ----------------------------------------------------------------------

let VIEWPORT = '';
let artistEmail = '';
let artistCookie = '';
let activeSlug = '';
let pausedSlug = '';
let drainedSlug = '';
let draftId = 0;
let fanACookie = '';
let fanBCookie = '';

test.beforeAll(async () => {
	VIEWPORT = test.info().project.name;
	artistEmail = `qa3-artist-${VIEWPORT}@bc-codes.test`;

	// Idempotence: purge any qa3 residue a previously aborted run may have
	// left (global-setup cleans too, but a mid-run crash can outrun it).
	sqlRun(`DELETE FROM reports WHERE claim_id IN (
		SELECT cl.id FROM claims cl JOIN projects p ON p.id = cl.project_id WHERE p.slug LIKE 'qa3-%')`);
	sqlRun(`DELETE FROM claims WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE 'qa3-%')`);
	sqlRun('DELETE FROM codes WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE \'qa3-%\')');
	sqlRun(`DELETE FROM code_batches WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE 'qa3-%')`);
	sqlRun(`DELETE FROM projects WHERE slug LIKE 'qa3-%'`);
	sqlRun(`DELETE FROM artist_sessions WHERE artist_id IN (SELECT id FROM artists WHERE email LIKE 'qa3-%')`);
	sqlRun(`DELETE FROM artists WHERE email LIKE 'qa3-%'`);

	resetOtpBudgets();
	artistCookie = await apiArtistSession(artistEmail);

	const active = await apiCreateProject(artistCookie, {
		title: `QA3 Active ${VIEWPORT}`,
		artistName: `qa3-active-${VIEWPORT}`
	});
	await apiUploadCsv(artistCookie, active.id, bandcampCsv(['qa3a-0001', 'qa3a-0002']));
	sqlRun('UPDATE projects SET slug = ? WHERE id = ?', `qa3-active-${VIEWPORT}`, active.id);
	activeSlug = `qa3-active-${VIEWPORT}`;

	const paused = await apiCreateProject(artistCookie, {
		title: `QA3 Paused ${VIEWPORT}`,
		artistName: `qa3-paused-${VIEWPORT}`
	});
	await apiUploadCsv(artistCookie, paused.id, bandcampCsv(['qa3p-0001', 'qa3p-0002']));
	sqlRun('UPDATE projects SET slug = ? WHERE id = ?', `qa3-paused-${VIEWPORT}`, paused.id);
	await pauseProject(artistCookie, paused.id);
	pausedSlug = `qa3-paused-${VIEWPORT}`;

	const drained = await apiCreateProject(artistCookie, {
		title: `QA3 Drained ${VIEWPORT}`,
		artistName: `qa3-drained-${VIEWPORT}`
	});
	await apiUploadCsv(artistCookie, drained.id, bandcampCsv(['qa3d-0001']));
	sqlRun('UPDATE projects SET slug = ? WHERE id = ?', `qa3-drained-${VIEWPORT}`, drained.id);
	drainedSlug = `qa3-drained-${VIEWPORT}`;
	const claim = await apiFanClaim(`qa3-fan-a-${VIEWPORT}@bc-codes.test`, drainedSlug);
	fanACookie = claim.cookie;

	const draft = await apiCreateProject(artistCookie, {
		title: `QA3 Draft ${VIEWPORT}`,
		artistName: `qa3-draft-${VIEWPORT}`
	});
	draftId = draft.id;

	fanBCookie = await verifyFanWithoutClaim(`qa3-fan-b-${VIEWPORT}@bc-codes.test`);
	resetOtpBudgets();
});

// --- automated scans: every surface, every state ------------------------------------

test('board — populated', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator(`a.cell__link[href="/p/${activeSlug}"]`)).toBeVisible();
	await scan(page, 'board (populated)');
	await tabFocusAudit(page, 'board (populated)');
});

test('board — empty (every active drop paused for the scan, then restored)', async ({ page }) => {
	const actives = sql<{ id: number }>('SELECT id FROM projects WHERE status = ?', 'active');
	try {
		for (const row of actives) sqlRun("UPDATE projects SET status = 'paused' WHERE id = ?", row.id);
		await page.goto('/');
		await expect(page.getByText('No live drops')).toBeVisible();
		await scan(page, 'board (empty)');
	} finally {
		for (const row of actives) sqlRun("UPDATE projects SET status = 'active' WHERE id = ?", row.id);
	}
});

test('project — active (launch view)', async ({ page }) => {
	await page.goto(`/p/${activeSlug}`);
	await expect(page.getByRole('button', { name: 'launch claim' })).toBeVisible();
	await scan(page, 'project (active)');
	await tabFocusAudit(page, 'project (active)');
});

test('project — paused', async ({ page }) => {
	await page.goto(`/p/${pausedSlug}`);
	await expect(page.getByText('on hold', { exact: false })).toBeVisible();
	await scan(page, 'project (paused)');
});

test('project — drained', async ({ page }) => {
	await page.goto(`/p/${drainedSlug}`);
	await expect(page.getByText('every one found a fan', { exact: false })).toBeVisible();
	await scan(page, 'project (drained)');
});

test('claim — email step', async ({ page }) => {
	await prepare(page);
	await resetOtpBudgets();
	await page.goto(`/p/${activeSlug}`);
	await clickUntil(
		page,
		'button:has-text("launch claim")',
		() => page.locator('input[name="email"]').count().then((n) => n > 0),
		'email step renders'
	);
	await scan(page, 'claim (email step)');
	await tabFocusAudit(page, 'claim (email step)');
});

test('claim — otp step', async ({ page }) => {
	await prepare(page);
	await resetOtpBudgets();
	await page.goto(`/p/${activeSlug}`);
	await clickUntil(
		page,
		'button:has-text("launch claim")',
		() => page.locator('input[name="email"]').count().then((n) => n > 0),
		'email step renders'
	);
	await page.locator('input[name="email"]').fill(`qa3-otp-${VIEWPORT}@bc-codes.test`);
	await clickUntil(
		page,
		'button:has-text("send my code")',
		() => page.locator('input[name="code"]').count().then((n) => n > 0),
		'otp step renders'
	);
	await scan(page, 'claim (otp step)');
	await tabFocusAudit(page, 'claim (otp step)');
});

test('keyboard journey — fan claim, Tab/Enter only → slab + spelled-out aria', async ({ page }) => {
	await prepare(page);
	await resetOtpBudgets();
	const email = `qa3-kb-fan-${VIEWPORT}@bc-codes.test`;
	await page.goto(`/p/${activeSlug}`);

	// LAUNCH CLAIM by keyboard (Enter retried until hydration catches it).
	await tabUntil(page, '.panel__foot button');
	await enterUntil(
		page,
		() => page.locator('input[name="email"]').count().then((n) => n > 0),
		'email step renders'
	);
	await page.waitForFunction(
		() => document.activeElement instanceof HTMLElement && document.activeElement.matches('input[name="email"]')
	);

	// Email step: type, Tab to the submit, Enter.
	await page.keyboard.type(email);
	await tabUntil(page, '.entry-form button[type="submit"]');
	await enterUntil(
		page,
		() => page.locator('input[name="code"]').count().then((n) => n > 0),
		'otp step renders'
	);
	await page.waitForFunction(
		() => document.activeElement instanceof HTMLElement && document.activeElement.matches('input[name="code"]')
	);

	// OTP step: the real code, typed like a human.
	const code = await solveOtp('fan', fanHashFor(email));
	await page.keyboard.type(code);
	await tabUntil(page, '.entry-form button[type="submit"]');
	await enterUntil(
		page,
		() => page.locator('.slab__code').count().then((n) => n > 0),
		'code slab renders'
	);
	await expect(page.locator('.slab__code')).toHaveAttribute(
		'aria-label',
		/spelled out: .*dash/
	);

	// The slab is a keyboard surface: copy works without a mouse.
	await tabUntil(page, 'button.slab__copy');
	await page.keyboard.press('Enter');
	await expect(page.locator('button.slab__copy')).toHaveText(/copied|selected/);

	// Let the steps() power-on settle (motion-gated; 1.7 s total) before scanning.
	await page.waitForTimeout(1_800);
	await scan(page, 'slab (fresh keyboard claim)');
	await tabFocusAudit(page, 'slab (fresh keyboard claim)');
});

test('slab — SSR revisit (holder session)', async ({ page, context }) => {
	await context.addCookies(installCookie('bc_fan_session', fanACookie));
	await page.goto(`/p/${drainedSlug}`);
	await expect(page.locator('.slab__code')).toBeVisible();
	await expect(page.getByText('Still yours', { exact: false })).toBeVisible();
	await scan(page, 'slab (SSR revisit)');
});

test('my codes — entry (signed out)', async ({ page }) => {
	await page.goto('/my-codes');
	await expect(page.getByText('verify to open', { exact: false })).toBeVisible();
	await scan(page, 'my codes (entry)');
	await tabFocusAudit(page, 'my codes (entry)');
});

test('my codes — archive (holder session)', async ({ page, context }) => {
	await context.addCookies(installCookie('bc_fan_session', fanACookie));
	await page.goto('/my-codes');
	await expect(page.locator('.claim__code')).toBeVisible();
	// The archive's code is spelled out for screen readers too.
	await expect(page.locator('.claim__code')).toHaveAttribute(
		'aria-label',
		/spelled out: .*dash/
	);
	await scan(page, 'my codes (archive)');
	await tabFocusAudit(page, 'my codes (archive)');
});

test('my codes — empty (verified session, zero claims)', async ({ page, context }) => {
	await context.addCookies(installCookie('bc_fan_session', fanBCookie));
	await page.goto('/my-codes');
	await expect(page.getByText('No codes yet')).toBeVisible();
	await scan(page, 'my codes (empty)');
});

test('console — sign-in', async ({ page }) => {
	await page.goto('/console');
	await page.waitForURL(/\/console\/sign-in/);
	await expect(page.locator('input[name="email"]')).toBeVisible();
	await scan(page, 'console (sign-in)');
	await tabFocusAudit(page, 'console (sign-in)');
});

test('console — dashboard', async ({ page, context }) => {
	await context.addCookies(installCookie('bc_artist_session', artistCookie));
	await page.goto('/console');
	await expect(page.locator(`a.drop__title-link[href="/console/${draftId}"]`)).toBeVisible();
	await scan(page, 'console (dashboard)');
	await tabFocusAudit(page, 'console (dashboard)');
});

test('console — new drop', async ({ page, context }) => {
	await context.addCookies(installCookie('bc_artist_session', artistCookie));
	await page.goto('/console/new');
	await expect(page.locator('input[name="title"]')).toBeVisible();
	await scan(page, 'console (new drop)');
	await tabFocusAudit(page, 'console (new drop)');
});

test('console — detail (draft, no codes yet)', async ({ page, context }) => {
	await context.addCookies(installCookie('bc_artist_session', artistCookie));
	await page.goto(`/console/${draftId}`);
	await expect(page.locator('.chip[data-state="draft"]')).toBeVisible();
	await scan(page, 'console (detail draft)');
	await tabFocusAudit(page, 'console (detail draft)');
});

// --- keyboard journey: artist sign-in → create → upload -----------------------------

test('keyboard journey — artist sign-in → create drop → CSV upload (Tab/Enter/typing)', async ({ page }) => {
	await prepare(page);
	await resetOtpBudgets();
	await page.goto('/console/sign-in');

	// Sign-in: email (autofocused post-hydration) → Tab → Enter.
	await page.waitForFunction(
		() => document.activeElement instanceof HTMLElement && document.activeElement.matches('input[name="email"]')
	);
	await page.keyboard.type(artistEmail);
	await tabUntil(page, '.entry-form button[type="submit"]');
	await enterUntil(
		page,
		() => page.locator('input[name="code"]').count().then((n) => n > 0),
		'otp step renders'
	);
	await page.waitForFunction(
		() => document.activeElement instanceof HTMLElement && document.activeElement.matches('input[name="code"]')
	);
	const code = await solveOtp('artist', artistEmail);
	await page.keyboard.type(code);
	await tabUntil(page, '.entry-form button[type="submit"]');
	await enterUntil(
		page,
		() => Promise.resolve(!page.url().includes('sign-in')),
		'console dashboard lands'
	);

	// New drop via the rail link, reached by keyboard.
	await tabUntil(page, 'a[href="/console/new"]');
	await page.keyboard.press('Enter');
	await page.waitForURL(/\/console\/new$/);
	await expect(page.locator('input[name="title"]')).toBeVisible();

	await page.locator('input[name="title"]').focus();
	await page.keyboard.type(`QA3 KB ${VIEWPORT}`);
	await page.keyboard.press('Tab');
	await page.keyboard.type(`qa3-kb-${VIEWPORT}`);
	await page.keyboard.press('Tab');
	await page.keyboard.type(FIXTURE_ALBUM_URL);
	await tabUntil(page, 'button[type="submit"]');
	await page.keyboard.press('Enter');
	await page.waitForURL(/\/console\/\d+$/);

	// The CSV upload goes through the native input — an OS file picker is the
	// one control outside the browser's keyboard sandbox, so the file is
	// attached programmatically (documented deviation; every step around it
	// stayed keyboard-only).
	const detailId = Number(/\/console\/(\d+)$/.exec(page.url())![1]);
	const csv = ['name of code set: qa3 kb', 'date created: Aug-28-2026', '', 'code', 'qa3k-0001'].join('\n') + '\n';
	await page.setInputFiles('input.dropzone__native', {
		name: `qa3-kb-${VIEWPORT}.csv`,
		mimeType: 'text/csv',
		buffer: Buffer.from(csv, 'utf8')
	});
	const feedback = page.locator('[role="region"][aria-label="upload feedback"]');
	await expect(feedback).toBeVisible();
	await expect(feedback).toContainText('the drop is now live on the wall');
	await scan(page, 'console (detail after keyboard upload)');

	// The drop really exists: the public project page carries it.
	const slug = sqlOne<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', detailId)!.slug;
	await page.goto(`/p/${slug}`);
	await expect(page.getByRole('button', { name: 'launch claim' })).toBeVisible();
});

// --- reduced motion: settled states, zero running animations ------------------------

test.describe('reduced motion', () => {
	test('board and slab render settled (no running animations)', async ({ page, context }) => {
		// Emulate prefers-reduced-motion directly (test.use({reducedMotion}) was
		// verified NOT to reach Chromium's media emulation on this machine).
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await context.addCookies(installCookie('bc_fan_session', fanACookie));
		await page.goto('/');
		await expect(page.locator('a.cell__link').first()).toBeVisible();
		const boardAnimated = await page.evaluate(() => {
			const animated: string[] = [];
			for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
				const cs = getComputedStyle(el);
				if (cs.animationName !== 'none' && cs.animationPlayState !== 'paused' && cs.animationIterationCount !== '0') {
					animated.push(`${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className : ''}`);
				}
			}
			return animated;
		});
		expect(boardAnimated, 'zero running animations on the board under prefers-reduced-motion').toEqual([]);

		await page.goto(`/p/${drainedSlug}`);
		await expect(page.locator('.slab__code')).toBeVisible();
		const slabState = await page.evaluate(() => {
			const code = document.querySelector<HTMLElement>('.slab__code');
			const animated: string[] = [];
			for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
				const cs = getComputedStyle(el);
				if (cs.animationName !== 'none' && cs.animationPlayState !== 'paused' && cs.animationIterationCount !== '0') {
					animated.push(`${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className : ''}`);
				}
			}
			return { animated, codeOpacity: code ? getComputedStyle(code).opacity : 'missing' };
		});
		expect(slabState.animated, 'zero running animations on the slab under prefers-reduced-motion').toEqual([]);
		expect(slabState.codeOpacity, 'the code renders settled (fully opaque)').toBe('1');
	});
});
