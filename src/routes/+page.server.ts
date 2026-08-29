/**
 * Fan board load (FE2): the public drop list, SSR-first. Availability is
 * read once per page load / invalidate — the "live feel" is real counts at
 * render time plus a focus-gated client refresh in +page.svelte (60s
 * throttle), never a polling loop hammering D1 (design brief: "the wall
 * must feel live without polling spam").
 */
import { error } from '@sveltejs/kit';
import { listPublicDrops } from '$lib/server/public';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform) {
		error(500, 'server_misconfigured');
	}
	return { drops: await listPublicDrops(platform.env.DB) };
};
