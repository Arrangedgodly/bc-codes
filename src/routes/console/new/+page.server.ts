/**
 * /console/new load (FE5) — the create form's gate (no session → sign-in
 * with this path as returnTo; the form itself posts to BE7's existing
 * POST /api/artist/projects from the client).
 */
import { error } from '@sveltejs/kit';
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
		returnTo: '/console/new'
	});
	return { artistEmail: artist.email };
};
