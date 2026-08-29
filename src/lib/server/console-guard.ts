/**
 * Console route gate (FE5) — every /console page load calls this before
 * touching any artist data. A valid BE3 artist session passes; anything
 * else 307-redirects to /console/sign-in with the attempted path riding
 * along as `returnTo`, so a session that lapses mid-task returns the
 * artist to exactly where they were after re-verifying.
 *
 * Redirect (not error): an unauthenticated console visit is the normal
 * sign-in entry, not a failure state.
 */

import { redirect } from '@sveltejs/kit';
import { getArtistFromCookies, type ArtistSession } from './artist-session';

export async function requireConsoleArtist(deps: {
	db: Parameters<typeof getArtistFromCookies>[0]['db'];
	cookies: { get(name: string): string | undefined };
	secret: string;
	now: Date;
	/** The path to come back to after sign-in (already console-scoped). */
	returnTo: string;
}): Promise<ArtistSession> {
	const artist = await getArtistFromCookies({
		db: deps.db,
		cookies: deps.cookies,
		secret: deps.secret,
		now: deps.now
	});
	if (!artist) {
		redirect(307, `/console/sign-in?returnTo=${encodeURIComponent(deps.returnTo)}`);
	}
	return artist;
}

/**
 * Sanitize a user-supplied returnTo: only same-app /console paths survive
 * (a leading `//` would be protocol-relative — an open redirect). Used by
 * the sign-in load; the client-side 401 handler only ever passes the
 * current pathname, which is console-scoped by construction.
 */
export function safeReturnTo(raw: string | null): string {
	if (!raw || !raw.startsWith('/console') || raw.startsWith('//')) return '/console';
	return raw;
}
