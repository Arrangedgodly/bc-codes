// Ambient types for the workerd test runtime.
//
// - The `/// <reference>` pulls in @cloudflare/vitest-plugin's `cloudflare:test`
//   module declaration, whose `env` is typed as `Cloudflare.Env` (defined below
//   to mirror the wrangler.jsonc bindings; secrets are deliberately omitted —
//   every BE3 module takes its peppers/secrets as arguments, so tests pass
//   their own values and never depend on .dev.vars).
// - This file is a module (has export {}) so `declare module 'vitest'` MERGES
//   with the real vitest types instead of replacing them: it types
//   `inject('migrations')` for tests/setup.ts (values provided Node-side by
//   vitest.config.ts's readD1Migrations).
/// <reference types="@cloudflare/vitest-plugin/types" />

declare module 'vitest' {
	interface ProvidedContext {
		migrations: import('@cloudflare/vitest-plugin').D1Migration[];
	}
}

declare global {
	namespace Cloudflare {
		interface Env {
			DB: import('@cloudflare/workers-types').D1Database;
			ART: import('@cloudflare/workers-types').R2Bucket;
		}
	}
}

export {};
