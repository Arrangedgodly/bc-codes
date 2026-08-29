/**
 * /my-codes load (FE4) — the fan's claim archive, SSR-first.
 *
 * Three arrival states, all decided HERE (the page renders, it never guesses):
 *
 *   - No session (or an expired/garbage cookie — readFanSession collapses
 *     both to null): `claims: null` → the email + OTP entry renders. The fan
 *     verifies identity to retrieve claims ACROSS DEVICES — the same BE4
 *     endpoints the claim flow uses (/api/fan/request-otp + verify-otp,
 *     purpose 'fan'); verifying re-runs this load and the archive appears.
 *   - Session, claims: the full cross-project list via listFanClaims — keyed
 *     by the session's fan_hash, so this load can only ever return the
 *     visitor's OWN claims, never another fan's codes.
 *   - Session, no claims: `claims: []` → the honest empty state (the board is
 *     live; nothing claimed yet).
 *
 * The sliding-session cookie refresh is deliberately NOT re-set here (same
 * reasoning as the FE3 load): SvelteKit forbids cookies.set during
 * client-side data requests, every fan endpoint applies the re-set recipe,
 * and a passive archive visit at the far edge of the 180-day window
 * re-verifies at most once — honest and cheap.
 */
import { error } from '@sveltejs/kit';
import { listFanClaims } from '$lib/server/fan-identity';
import { getFanFromCookies } from '$lib/server/fan-session';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, cookies }) => {
	if (!platform) {
		error(500, 'server_misconfigured');
	}
	const fan = await getFanFromCookies({
		db: platform.env.DB,
		cookies,
		secret: platform.env.SESSION_SECRET,
		now: new Date()
	});
	if (!fan) return { fanHasSession: false, claims: null };
	return { fanHasSession: true, claims: await listFanClaims(platform.env.DB, fan.fanHash) };
};
