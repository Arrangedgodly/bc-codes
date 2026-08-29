/**
 * QA2 — E2E happy-path suite (Playwright, chromium).
 *
 * Harness choice (documented per the QA2 task): Playwright drives a REAL
 * Chromium against the REAL dev server (`vite dev` with the wrangler
 * platformProxy local D1 — the same stack production runs on adapter-
 * cloudflare). The live-browser path was proven feasible on this machine
 * (ms-playwright chromium cache + network for the npm package), so the
 * route-level fetch fallback was not needed.
 *
 *   npm run test:e2e          — this suite
 *   npm test                  — the 234 unit/integration tests (untouched)
 *
 * Directory note: e2e/ sits at the repo root OUTSIDE the generated
 * .svelte-kit/tsconfig.json include (like vitest.config.ts) — it is not part
 * of `svelte-check`, and vitest's include (tests/ *.test.ts globs) does not
 * see it either. Playwright transpiles these files itself.
 *
 * Structure: two projects — desktop 1440×900 and mobile 390×844 (the two
 * contract viewports) — every journey spec runs against BOTH, and each spec
 * runs its journey TWICE internally (round 1 / round 2, disjoint fixture
 * slugs/emails) per the QA2 flake-hardening requirement.
 *
 * Everything is sequential (workers: 1, fullyParallel: false, retries: 0):
 * the journeys share one D1, and flake-hardening here means determinism, not
 * retries. The dev server + DB channel are owned by global-setup.ts.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	outputDir: '../test-results',
	timeout: 90_000,
	globalTimeout: 30 * 60_000,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5317',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'desktop',
			use: { viewport: { width: 1440, height: 900 } }
		},
		{
			name: 'mobile',
			use: {
				viewport: { width: 390, height: 844 },
				isMobile: true,
				hasTouch: true,
				deviceScaleFactor: 2
			}
		}
	],
	globalSetup: './global-setup'
});
