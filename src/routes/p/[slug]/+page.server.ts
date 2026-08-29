/**
 * /p/[slug] load (FE3) — the project page's whole server side.
 *
 * Public project read by share slug (non-draft only; paused and drained stay
 * reachable so their honest states render), PLUS the session fan's claim:
 *
 *   - Revisit semantics: a valid fan session (BE4, verify-once-per-browser)
 *     with an existing claim gets it HERE, SSR — the slab renders directly,
 *     no re-claim, no dead end (limit-hit IS the revisit re-show). The claim
 *     read is keyed by the session's fan_hash (fanClaimForProject), so this
 *     load can only ever return the visitor's OWN claim — never another
 *     fan's code — and no code string exists in the payload without one.
 *   - A session WITHOUT a claim on this project yields claim=null and the
 *     launch sequence starts (direct claim — no OTP re-entry).
 *   - The sliding-session cookie refresh is deliberately NOT re-set here:
 *     SvelteKit forbids cookies.set during client-side data requests, and
 *     every fan API endpoint (/api/fan/claim included) applies the re-set
 *     recipe; the server-side row this read may have extended is what grants
 *     access either way. A purely passive revisit at the far edge of the
 *     180-day window re-verifies at most once — honest and cheap.
 */
import { error } from '@sveltejs/kit';
import { fanClaimForProject } from '$lib/server/fan-identity';
import { getFanFromCookies } from '$lib/server/fan-session';
import { getPublicProjectBySlug } from '$lib/server/public';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, params, cookies }) => {
	if (!platform) {
		error(500, 'server_misconfigured');
	}
	const project = await getPublicProjectBySlug(platform.env.DB, params.slug!);
	if (!project) {
		// Unknown and draft slugs are indistinguishable — both simply absent.
		error(404, 'Drop not found');
	}

	const fan = await getFanFromCookies({
		db: platform.env.DB,
		cookies,
		secret: platform.env.SESSION_SECRET,
		now: new Date()
	});
	const claim = fan ? await fanClaimForProject(platform.env.DB, fan.fanHash, project.id) : null;

	return { project, fanHasSession: fan !== null, claim };
};
