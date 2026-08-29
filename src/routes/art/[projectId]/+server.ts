/**
 * GET /art/[projectId] (BE8) — serve a project's R2-backed artwork.
 *
 * Public (fans' board needs it; the cover is public data) and aggressively
 * cacheable: the object behind a project id only changes when the artist
 * changes the album URL, and refreshes overwrite the same key. One day
 * fresh + seven days stale-while-revalidate keeps the board instant while
 * bounding staleness after an art swap — no `immutable`, deliberately,
 * because the bytes at a key CAN be replaced.
 *
 * Content-type comes from the R2 object's httpMetadata (stored by the
 * refresh's magic-byte sniff, never from a remote header), so this route can
 * never be talked into serving active content. 404 for anything unknown,
 * malformed, or not yet fetched — the FE's artwork_status is the source of
 * truth for whether to render an image at all.
 */

import { json } from '@sveltejs/kit';
import { artworkR2Key } from '$lib/server/artwork';
import type { RequestHandler } from './$types';

/** Same strict positive-integer parse as the artist project endpoints. */
function projectIdParam(param: string | undefined): number | null {
	return typeof param === 'string' && /^\d+$/.test(param) && Number(param) > 0 ? Number(param) : null;
}

export const GET: RequestHandler = async (event) => {
	if (!event.platform) {
		return json({ error: 'server_misconfigured' }, { status: 500 });
	}

	const projectId = projectIdParam(event.params.projectId);
	if (projectId === null) {
		return json({ error: 'not_found' }, { status: 404 });
	}

	const object = await event.platform.env.ART.get(artworkR2Key(projectId));
	if (!object || !object.body) {
		return json({ error: 'not_found' }, { status: 404 });
	}

	// workers-types' ReadableStream vs the DOM BodyInit variance — same stream
	// at runtime (the worker serves R2 bodies straight through).
	return new Response(object.body as unknown as BodyInit, {
		headers: {
			'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'cache-control': 'public, max-age=86400, stale-while-revalidate=604800'
		}
	});
};
