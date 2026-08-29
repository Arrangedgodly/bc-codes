import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// R1-committed test path: vitest running inside workerd via @cloudflare/vitest-plugin
// (docs/ultron/research/R1-cloudflare-stack.md — QA1's D1 invariant suites build on this).
// Bindings (DB/ART) come from wrangler.jsonc; BE2's parser tests are pure unit tests,
// so they must not depend on a prior `vite build` — hence the stub main entry below
// instead of wrangler.jsonc's deploy entry (.svelte-kit/cloudflare/_worker.js).
//
// BE3+: integration tests run against the real D1 binding. The test database is
// isolated (per-test storage rollback), so tests apply the migrations themselves:
// readD1Migrations() (Node side, with the proper statement splitter) hands them to
// tests/setup.ts (workerd side) via vitest's provide/inject, which calls the plugin's
// applyD1Migrations against env.DB — recording them in d1_migrations like wrangler does.
export default defineConfig(async () => {
	const migrations = await readD1Migrations('./migrations');
	// QA3: the contrast suite (tests/contrast.test.ts) recomputes FE1's
	// documented ratios from the REAL token hexes in src/app.css — read on the
	// Node side (workerd has no fs) and provided to tests, so a token edit that
	// breaks AA fails the suite instead of silently drifting from the doc table.
	const css = await readFile('./src/app.css', 'utf8');
	const cssTokens: Record<string, string> = {};
	for (const match of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
		cssTokens[match[1]!] = match[2]!.toLowerCase();
	}
	return {
		// The SvelteKit plugin (and its $lib alias) is not loaded here, so endpoint
		// handlers imported directly by tests need the alias mapped by hand.
		resolve: {
			alias: {
				$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
			}
		},
		plugins: [
			cloudflareTest({
				main: './tests/worker-entry.ts',
				wrangler: { configPath: './wrangler.jsonc' }
			})
		],
		test: {
			include: ['tests/**/*.test.ts'],
			setupFiles: ['./tests/setup.ts'],
			provide: { migrations, cssTokens }
		}
	};
});
