/**
 * /api/artist/projects (BE7) — the artist console's project collection.
 *
 *   GET  — every project of the signed-in artist, newest first, each with
 *          derived stats (total/claimed/available/reported), status, and the
 *          artwork fields (nullable until BE8 fills them).
 *   POST — create a draft project. Required: title, artistName, albumUrl (a
 *          bandcamp.com URL — the yum URL is derived from its subdomain per
 *          the CSV pattern https://<subdomain>.bandcamp.com/yum). The slug is
 *          derived from artist+title and unique-ified; codes are not expected
 *          yet — uploading the CSV (POST /:id/upload) is what activates.
 *
 * Auth: BE3's artist session cookie on every call (401 otherwise). DELETE is
 * deliberately absent — no destructive ops in the MVP (plan non-goals); the
 * framework answers it 405.
 */

import { json } from '@sveltejs/kit';
import { getArtistFromCookies } from '$lib/server/artist-session';
import { fireArtworkRefresh } from '$lib/server/artwork';
import {
	createProject,
	listProjects,
	normalizeArtistName,
	normalizeTitle,
	parseAlbumUrl
} from '$lib/server/project';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
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

	const projects = await listProjects(env.DB, artist.artistId);
	return json({ projects });
};

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

	const body = await event.request.json().catch(() => null);
	const raw = body as { title?: unknown; artistName?: unknown; albumUrl?: unknown } | null;
	// Present-but-invalid fields are rejected individually so the FE can point
	// at the exact input (missing counts as invalid here — all three are required).
	const title = normalizeTitle(raw?.title);
	if (title === null) {
		return json({ error: 'invalid_title', maxChars: 200 }, { status: 400 });
	}
	const artistName = normalizeArtistName(raw?.artistName);
	if (artistName === null) {
		return json({ error: 'invalid_artist_name', maxChars: 200 }, { status: 400 });
	}
	const albumUrl = parseAlbumUrl(raw?.albumUrl);
	if (albumUrl === null) {
		return json({ error: 'invalid_album_url', message: 'The album URL must be a bandcamp.com page, e.g. https://yourname.bandcamp.com/album/your-album.' }, { status: 400 });
	}

	const project = await createProject({
		db: env.DB,
		artistId: artist.artistId,
		title,
		artistName,
		albumUrl,
		now: new Date()
	});

	// BE8: fire-and-forget artwork fetch (og:image) for the new project —
	// deferred via waitUntil so it never delays or fails the create. Where no
	// execution context exists the hook skips loudly (artwork.ts explains why);
	// the manual refresh endpoint covers that case. The response already
	// carries artwork_status 'pending', which is exactly what this leaves behind.
	fireArtworkRefresh({
		db: env.DB,
		art: env.ART ?? null,
		artistId: artist.artistId,
		projectId: project.id,
		albumUrl: albumUrl.albumUrl,
		now: new Date(),
		context: event.platform.ctx ?? event.platform.context
	});

	return json({ ok: true, project }, { status: 201 });
};
