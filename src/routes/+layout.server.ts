/**
 * Root layout server load (FE5) — the artist-session probe that lets the
 * header rail render artist nav + identity + sign-out on /console surfaces.
 *
 * Zero-cost for fans: with no `bc_artist_session` cookie the signature
 * check short-circuits before any DB touch. A signed-in artist pays one
 * indexed token-hash lookup per navigation — the same read every artist
 * endpoint already does.
 */
import { getArtistFromCookies } from '$lib/server/artist-session';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform, cookies }) => {
	if (!platform) {
		// Non-Workers context (exotic preview harnesses): the rail simply
		// renders its signed-out form; the console pages gate for real.
		return { artistEmail: null };
	}
	const artist = await getArtistFromCookies({
		db: platform.env.DB,
		cookies,
		secret: platform.env.SESSION_SECRET,
		now: new Date()
	});
	return { artistEmail: artist?.email ?? null };
};
