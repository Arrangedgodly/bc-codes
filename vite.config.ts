import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Cloudflare Workers (Static Assets) + D1 per docs/ultron/research/R1-cloudflare-stack.md.
			// Bindings live in wrangler.jsonc; platformProxy emulates them (incl. local D1 backed by
			// .wrangler/state) during `vite dev` / `vite preview`.
			adapter: adapter({
				config: 'wrangler.jsonc',
				platformProxy: {
					configPath: 'wrangler.jsonc',
					persist: true
				}
			}),

			// QA3 — Content-Security-Policy via SvelteKit's own csp machinery.
			// WHY here and not hand-rolled headers: SvelteKit ships an INLINE
			// hydration bootstrap script on every page (dev AND the production
			// build — `__sveltekit_<id> = { base … }` + dynamic entry imports),
			// so a static `script-src 'self'` breaks hydration in production.
			// mode:'auto' gives dynamically rendered pages a per-request nonce
			// (added both to the script tag and to script-src) and prerendered
			// pages a hash — `script-src` stays 'self' plus ONLY that
			// nonce/hash, in dev and prod alike. In dev SvelteKit additionally
			// injects style 'unsafe-inline' for its HMR styles automatically.
			// Non-page responses (JSON APIs, /art) get the identical STATIC
			// policy from src/hooks.server.ts (they render no scripts).
			//
			// Directive decisions (audited against what the app loads):
			//   img-src 'data:'          — Vite inlines sub-4KB assets (the
			//                              favicon) as data: URIs in dev AND prod.
			//   img-src *.bcbits.com     — BE8's artwork hotlink fallback (the
			//                              verified og:image CDN); primary art is
			//                              same-origin /art/<id>.
			//   style-src 'unsafe-inline'— app.html's no-flash <style> + Svelte
			//                              style attributes (style-src-attr).
			//   everything else 'self'/none — fonts self-hosted, fetches
			//                              same-origin, no plugins/workers used.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'https://*.bcbits.com'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none'],
					'worker-src': ['self'],
					'manifest-src': ['self']
				}
			}
		})
	]
});
