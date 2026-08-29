/**
 * /console load (FE5) — the artist dashboard: every project of the signed-in
 * artist as a console panel (stats, status, artwork, share link, actions).
 * Route-gated: no valid session → 307 to sign-in with this path as returnTo.
 */
import { error } from '@sveltejs/kit';
import { listProjects } from '$lib/server/project';
import { requireConsoleArtist } from '$lib/server/console-guard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, cookies }) => {
	if (!platform) {
		error(500, 'server_misconfigured');
	}
	const artist = await requireConsoleArtist({
		db: platform.env.DB,
		cookies,
		secret: platform.env.SESSION_SECRET,
		now: new Date(),
		returnTo: '/console'
	});
	return { artistEmail: artist.email, projects: await listProjects(platform.env.DB, artist.artistId) };
};
