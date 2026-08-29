/**
 * POST /api/artist/projects/[id]/refresh-artwork (BE8) — the manual artwork
 * refresh surface.
 *
 * Why manual exists: the create/PATCH hooks defer via waitUntil and SKIP when
 * no execution context is available (see artwork.ts's header), and any
 * automatic fetch can have failed transiently (Bandcamp hiccup, timeout).
 * The artist console (FE5) calls this after create, after an album-URL
 * change, or from a "retry artwork" affordance when artwork_status reads
 * 'fallback'. Unlike the hooks it is AWAITED — the caller gets the settled
 * outcome (worst case two tight ~5s fetches).
 *
 * Idempotent by construction: the refresh is a bounded pipeline ending in
 * ONE UPDATE of the same artwork columns (plus an in-place R2 overwrite),
 * so repeating the call converges on the same state — no new rows anywhere.
 *
 * Auth + scoping like every artist endpoint: BE3 session (401), and another
 * artist's project id is a 404 indistinguishable from a missing one.
 */

import { json } from '@sveltejs/kit';
import { getArtistFromCookies } from '$lib/server/artist-session';
import { refreshProjectArtwork } from '$lib/server/artwork';
import type { RequestHandler } from './$types';

/** Same strict positive-integer parse as the sibling [id] endpoints. */
function projectIdParam(param: string | undefined): number | null {
	return typeof param === 'string' && /^\d+$/.test(param) && Number(param) > 0 ? Number(param) : null;
}

export const POST: RequestHandler = async (event) => {
	if (!event.platform) {
		return json({ error: 'server_misconfigured' }, { status: 500 });
	}
	const env = event.platform.env;

	const artist = await getArtistFromCookies({
		db: env.DB,
		cookies: event.cookies,
		secret: env.SESSION_SECRET,
		now: new Date()
	});
	if (!artist) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	const projectId = projectIdParam(event.params.id);
	if (projectId === null) {
		return json({ error: 'not_found' }, { status: 404 });
	}

	// Ownership first — the refresh's own scoping would only ever see not-found.
	const project = await env.DB
		.prepare('SELECT album_url FROM projects WHERE id = ?1 AND artist_id = ?2')
		.bind(projectId, artist.artistId)
		.first<{ album_url: string }>();
	if (!project) {
		return json({ error: 'not_found' }, { status: 404 });
	}

	const result = await refreshProjectArtwork({
		db: env.DB,
		art: env.ART ?? null,
		artistId: artist.artistId,
		projectId,
		albumUrl: project.album_url,
		now: new Date()
	});
	// not-found cannot happen here (ownership was just checked) — map it anyway.
	if (!result.ok) return json({ error: 'not_found' }, { status: 404 });

	return json({
		ok: true,
		artwork: {
			status: result.artworkStatus,
			url: result.artworkStatus === 'fetched' ? result.artworkUrl : null,
			source: result.artworkStatus === 'fetched' ? result.source : null
		}
	});
};
