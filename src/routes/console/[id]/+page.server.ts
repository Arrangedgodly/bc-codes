/**
 * /console/[id] load (FE5) — one project's console: BE7's projectDetail
 * (summary + stats + the 20 most recent claims WITH code strings — the
 * artist owns their codes — + BE6's reports). Route-gated like every
 * console page; another artist's id and a missing one are the same 404.
 */
import { error } from '@sveltejs/kit';
import { projectDetail } from '$lib/server/project';
import { requireConsoleArtist } from '$lib/server/console-guard';
import type { PageServerLoad } from './$types';

/** Strict positive-integer param parse — `Number('1e2')` must not resolve to id 100. */
function projectIdParam(param: string | undefined): number | null {
	return typeof param === 'string' && /^\d+$/.test(param) && Number(param) > 0 ? Number(param) : null;
}

export const load: PageServerLoad = async ({ platform, cookies, params }) => {
	if (!platform) {
		error(500, 'server_misconfigured');
	}
	const projectId = projectIdParam(params.id);
	const returnTo = projectId !== null ? `/console/${params.id}` : '/console';
	const artist = await requireConsoleArtist({
		db: platform.env.DB,
		cookies,
		secret: platform.env.SESSION_SECRET,
		now: new Date(),
		returnTo
	});
	if (projectId === null) {
		error(404, 'Project not found');
	}
	const project = await projectDetail(platform.env.DB, artist.artistId, projectId);
	if (!project) {
		// Another artist's project is indistinguishable from a missing one.
		error(404, 'Project not found');
	}
	return { artistEmail: artist.email, project };
};
