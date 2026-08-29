/**
 * Security headers (QA3) — applied to EVERY response this server renders;
 * the Content-Security-Policy specifically behaves in two tiers:
 *
 *   PAGES (HTML documents): SvelteKit's own csp machinery (vite.config.ts,
 *   `csp.mode: 'auto'`) sets the header and mints a per-request nonce that
 *   it adds BOTH to its inline hydration bootstrap and to `script-src`. This
 *   is required: SvelteKit ships that inline bootstrap on every page in dev
 *   AND in the production build, so a static `script-src 'self'` would break
 *   hydration in production (found live during QA3's preview audit). This
 *   hook therefore only sets the CSP when SvelteKit hasn't (non-page
 *   responses: JSON API endpoints, the /art/<id> artwork route, endpoint
 *   404s — none of which render scripts) — the static policy below is
 *   byte-identical to the kit directive set minus the nonce.
 *
 * Other headers set here unconditionally (documents + endpoints alike):
 *   X-Frame-Options: DENY        (legacy UAs; frame-ancestors covers modern)
 *   X-Content-Type-Options: nosniff
 *   Referrer-Policy: strict-origin-when-cross-origin
 *   Permissions-Policy: no camera/mic/location/payment/usb (nothing uses them)
 *   Cross-Origin-Opener-Policy: same-origin
 *   Strict-Transport-Security: max-age=31536000 (ignored over plain http, so
 *                               dev is unaffected; Workers serves https)
 *
 * CSP decisions, each justified (audited 2026-08-28 against what the app
 * actually loads):
 *   default-src 'self'        — the base posture; nothing third-party.
 *   script-src 'self'         — plus ONLY SvelteKit's nonce/hash on pages.
 *                               No 'unsafe-inline', no 'unsafe-eval' anywhere.
 *   style-src 'self' 'unsafe-inline'
 *                             — 'unsafe-inline' is required for styles, not a
 *                               lapse: app.html ships one inline <style> (the
 *                               pre-CSS dark-ground no-flash guard) and Svelte
 *                               components set style attributes (CSS custom
 *                               properties like --bracket-color, --i, --char-
 *                               count), which CSP governs via style-src-attr.
 *                               Style injection cannot execute script in any
 *                               current browser; script-src stays fully tight.
 *   img-src 'self' data: https://*.bcbits.com
 *                             — artwork is served same-origin via /art/<id>
 *                               (BE8's R2 primary); bcbits.com is Bandcamp's
 *                               image CDN, the ONLY external the graceful
 *                               hotlink fallback ever writes into
 *                               projects.artwork_url (BE8 writes the verified
 *                               og:image URL when R2 is unavailable). data:
 *                               covers Vite's asset inlining of sub-4KB files
 *                               (the favicon ships as a data: URI in BOTH dev
 *                               and the production build); artwork itself is
 *                               never a data: URI. If a future og:image host
 *                               appears outside bcbits, the <img> simply
 *                               fails and Artwork.svelte degrades to the
 *                               text card — honest, never broken.
 *   font-src 'self'           — all three faces are self-hosted woff2
 *                               (src/lib/fonts), OFL-licensed.
 *   connect-src 'self'        — every fetch the UI makes is to own endpoints
 *                               (/api/...); dev's Vite HMR websocket is
 *                               same-origin ws (CSP3 'self' matches it).
 *   object-src 'none', base-uri 'self', form-action 'self',
 *   frame-ancestors 'none', worker-src 'self', manifest-src 'self'
 *                             — nothing here uses any of these; deny by
 *                               default so nothing can start.
 *
 * CSRF posture (documented, QA3): every state-changing endpoint is a JSON
 * POST issued by own-page fetch. Session cookies are SameSite=Lax, so a
 * cross-site page can neither POST with the cookie attached (Lax withholds
 * it on cross-site subresource requests) nor top-level-navigate a POST
 * (Lax sends cookies on GET navigations only). SvelteKit form actions
 * (unused here) additionally carry built-in origin checks. Residual risk:
 * browsers without SameSite support (pre-2019) — accepted at MVP scale.
 *
 * Static assets served by the Workers assets binding before the worker
 * (immutable /_app files) get the adapter's `_headers` rules; documents and
 * endpoints always pass through here.
 */

import type { Handle } from '@sveltejs/kit';

/** Static policy for non-page responses — mirrors vite.config.ts's kit.csp
 *  directive set exactly (pages get that set PLUS the SvelteKit nonce). */
const STATIC_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https://*.bcbits.com",
	"font-src 'self'",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"worker-src 'self'",
	"manifest-src 'self'"
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
	'x-frame-options': 'DENY',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	'cross-origin-opener-policy': 'same-origin',
	'strict-transport-security': 'max-age=31536000; includeSubDomains'
};

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}
	// SvelteKit's csp machinery already set the header on page renders
	// (with its nonce); everything else gets the static policy.
	if (!response.headers.has('content-security-policy')) {
		response.headers.set('content-security-policy', STATIC_CSP);
	}
	return response;
};
