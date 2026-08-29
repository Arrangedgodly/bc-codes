/**
 * QA3 — security verification against the live server (request-level; no
 * browser needed for the header work). Two CSP tiers exist by design:
 *
 *   PAGES: SvelteKit's csp machinery (vite.config.ts kit.csp, mode 'auto')
 *          sets the header and adds a per-request nonce to script-src —
 *          required because SvelteKit ships an inline hydration bootstrap
 *          on every page (dev AND production build).
 *   NON-PAGE responses (JSON APIs, /art): src/hooks.server.ts sets the
 *          identical STATIC policy (no scripts there, so no nonce needed).
 *
 * Plus: the rest of the QA3 header set on every surface, the raw Set-Cookie
 * posture of the fan verify endpoint (HttpOnly + SameSite=Lax + Path +
 * Max-Age; the Secure flag needs an https origin and is pinned in
 * tests/security-hardening.test.ts), and the {@html} audit.
 *
 * CSRF note (documented in hooks.server.ts): every state-changing endpoint
 * is a same-origin JSON POST; SameSite=Lax withholds session cookies from
 * cross-site POSTs, and SvelteKit form actions (unused) add origin checks.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
	apiArtistSession,
	apiCreateProject,
	apiUploadCsv,
	bandcampCsv,
	BASE_URL,
	fanHashFor,
	resetOtpBudgets,
	solveOtp,
	sqlRun
} from './harness';

let VIEWPORT = '';
let artistCookie = '';
let activeSlug = '';

test.beforeAll(async () => {
	VIEWPORT = test.info().project.name;

	// Idempotence: purge any qa3-sec residue a previously aborted run may have
	// left (mirrors a11y.spec.ts's fixture discipline).
	sqlRun(`DELETE FROM reports WHERE claim_id IN (
		SELECT cl.id FROM claims cl JOIN projects p ON p.id = cl.project_id WHERE p.slug LIKE 'qa3-sec-%')`);
	sqlRun(`DELETE FROM claims WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE 'qa3-sec-%')`);
	sqlRun('DELETE FROM codes WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE \'qa3-sec-%\')');
	sqlRun(`DELETE FROM code_batches WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE 'qa3-sec-%')`);
	sqlRun(`DELETE FROM projects WHERE slug LIKE 'qa3-sec-%'`);
	sqlRun(`DELETE FROM artist_sessions WHERE artist_id IN (SELECT id FROM artists WHERE email LIKE 'qa3-sec-%')`);
	sqlRun(`DELETE FROM artists WHERE email LIKE 'qa3-sec-%'`);

	resetOtpBudgets();
	artistCookie = await apiArtistSession(`qa3-sec-${VIEWPORT}@bc-codes.test`);
	const project = await apiCreateProject(artistCookie, {
		title: `QA3 Sec ${VIEWPORT}`,
		artistName: `qa3-sec-${VIEWPORT}`
	});
	await apiUploadCsv(artistCookie, project.id, bandcampCsv(['qa3s-0001']));
	sqlRun('UPDATE projects SET slug = ? WHERE id = ?', `qa3-sec-${VIEWPORT}`, project.id);
	activeSlug = `qa3-sec-${VIEWPORT}`;
	resetOtpBudgets();
});

/** The full non-CSP QA3 header set, exactly as hooks.server.ts writes it. */
async function expectBaseHeaders(path: string): Promise<{ csp: string; status: number }> {
	const response = await fetch(`${BASE_URL}${path}`);
	const headers = response.headers;
	expect(headers.get('x-frame-options'), `${path} XFO`).toBe('DENY');
	expect(headers.get('x-content-type-options'), `${path} XCTO`).toBe('nosniff');
	expect(headers.get('referrer-policy'), `${path} Referrer-Policy`).toBe('strict-origin-when-cross-origin');
	expect(headers.get('permissions-policy'), `${path} Permissions-Policy`).toBe(
		'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
	);
	expect(headers.get('cross-origin-opener-policy'), `${path} COOP`).toBe('same-origin');
	expect(headers.get('strict-transport-security'), `${path} HSTS`).toBe('max-age=31536000; includeSubDomains');
	return { csp: headers.get('content-security-policy') ?? '', status: response.status };
}

/** The shared directive shape (both tiers) + the hard nos. */
function expectCommonCsp(path: string, csp: string) {
	expect(csp, `${path} CSP`).toContain("default-src 'self'");
	expect(csp).toContain("style-src 'self' 'unsafe-inline'");
	expect(csp).toContain("img-src 'self' data: https://*.bcbits.com");
	expect(csp).toContain("font-src 'self'");
	expect(csp).toContain("connect-src 'self'");
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain("object-src 'none'");
	expect(csp).toContain("base-uri 'self'");
	expect(csp, `${path} CSP must not allow 'unsafe-eval'`).not.toContain('unsafe-eval');
	expect(csp, `${path} script-src must never allow inline scripts`).not.toMatch(/script-src[^;]*unsafe-inline/);
}

test('security headers — every surface the worker renders', async () => {
	// PAGES — SvelteKit's nonce CSP: script-src is 'self' PLUS the nonce that
	// also lands on its inline hydration bootstrap.
	for (const path of ['/', `/p/${activeSlug}`, '/console', '/console/sign-in', '/my-codes', '/no/such/page']) {
		const { csp } = await expectBaseHeaders(path);
		expectCommonCsp(path, csp);
		expect(csp, `${path} page CSP carries the SvelteKit nonce`).toMatch(/script-src [^;]*nonce-/);
	}

	// NON-PAGE responses — the static policy from hooks.server.ts: exactly
	// "script-src 'self'", nothing else in that directive.
	const api = await expectBaseHeaders('/api/artist/projects');
	expect(api.status).toBe(401);
	expectCommonCsp('/api/artist/projects', api.csp);
	expect(api.csp).toContain("script-src 'self';");

	const art = await expectBaseHeaders('/art/999999999');
	expect(art.status).toBe(404);
	expectCommonCsp('/art/999999999', art.csp);
	expect(art.csp).toContain("script-src 'self';");
});

test('CSP sources — the two tiers are declared exactly once, identically (kit + hooks)', async () => {
	const vite = readFileSync('vite.config.ts', 'utf8');
	// kit.csp drives page CSP: mode auto (nonce) + a strictly-self script-src.
	expect(vite).toContain("csp: {\n\t\t\t\tmode: 'auto'");
	expect(vite).toContain("'script-src': ['self'],");
	const hooks = readFileSync('src/hooks.server.ts', 'utf8');
	// The static tier mirrors the kit directive set for script-src exactly.
	expect(hooks).toContain('"script-src \'self\'"');
});

test('cookie posture on the wire — fan verify sets HttpOnly + SameSite=Lax + Path + Max-Age', async () => {
	await resetOtpBudgets();
	const email = `qa3-sec-fan-${VIEWPORT}@bc-codes.test`;
	const request = await fetch(`${BASE_URL}/api/fan/request-otp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email })
	});
	expect(request.status).toBe(200);
	const code = await solveOtp('fan', fanHashFor(email));
	const verify = await fetch(`${BASE_URL}/api/fan/verify-otp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, code })
	});
	expect(verify.status).toBe(200);
	const setCookie = (verify.headers.getSetCookie?.() ?? []).join('\n');
	expect(setCookie).toMatch(/bc_fan_session=/);
	expect(setCookie).toMatch(/HttpOnly/i);
	expect(setCookie).toMatch(/SameSite=Lax/i);
	expect(setCookie).toMatch(/Path=\//);
	expect(setCookie).toMatch(/Max-Age=/);
});

test('{@html} audit — the one usage is a static direction-contract comment, nothing else', async ({ page }) => {
	// Source level: exactly one {@html} USAGE in the tree (the layout's own
	// doc-comment mentioning "{@html}" doesn't count); its argument is a const
	// string literal (no interpolation, no script markup, no user data).
	const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
	expect((layout.match(/\{@html\s+[A-Za-z_]/g) ?? []).length).toBe(1);
	const contract = /const DIRECTION_CONTRACT = `([\s\S]*?)`;/.exec(layout)?.[1] ?? '';
	expect(contract.length).toBeGreaterThan(100);
	expect(contract).not.toContain('<script');
	expect(contract).not.toContain('${');

	// DOM level: the rendered marker is a comment node; SvelteKit's inline
	// bootstrap is the ONLY inline script (dev and prod alike — it is what the
	// nonce in the page CSP exists for), and it is kit-authored, not ours.
	await page.goto('/');
	const audit = await page.evaluate(() => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
		const comments: string[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node.textContent ?? '');
		const inlineScripts = [...document.querySelectorAll('script:not([src])')].map((s) => s.textContent ?? '');
		return { hasContract: comments.some((c) => c.includes('FE1 DIRECTION CONTRACT')), inlineScripts };
	});
	expect(audit.hasContract).toBe(true);
	for (const script of audit.inlineScripts) {
		expect(script).toContain('__sveltekit');
	}
});
