/**
 * /console/sign-in load (FE5) — the artist console's entry.
 *
 * Already signed in? Then this page has nothing to offer: 307 to the
 * returnTo path (sanitized below — only same-app /console paths may ride
 * along, so a crafted ?returnTo=//evil.example can never turn the console
 * into an open redirect). Signed out: render the email → OTP command-entry
 * flow (BE3 endpoints; the OTP mail is the ConsoleMailer's dev channel).
 */
import { error, redirect } from '@sveltejs/kit';
import { getArtistFromCookies } from '$lib/server/artist-session';
import { safeReturnTo } from '$lib/server/console-guard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, cookies, url }) => {
	if (!platform) {
		error(500, 'server_misconfigured');
	}
	const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
	const artist = await getArtistFromCookies({
		db: platform.env.DB,
		cookies,
		secret: platform.env.SESSION_SECRET,
		now: new Date()
	});
	if (artist) {
		redirect(307, returnTo);
	}
	return { returnTo };
};
