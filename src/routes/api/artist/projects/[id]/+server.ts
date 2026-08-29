/**
 * /api/artist/projects/[id] (BE7) — one project of the signed-in artist.
 *
 *   GET   — console detail: summary + stats + the 20 most recent claims
 *           (code strings SHOWN — the artist owns their codes) + reports
 *           (BE6's projectReports).
 *   PATCH — field updates (title / artistName / albumUrl — yum URL re-derived
 *           from a new album URL) and pause/resume (`status: 'paused' |
 *           'active'`). Slug is derived, never client-set: it re-derives only
 *           when an input changes while the project is still draft, and is
 *           stable after that. Status transitions are guarded to
 *           active↔paused; draft/drained are system-governed (uploading codes
 *           activates / re-activates), so hand transitions out of them are
 *           409 with an explanatory message. A same-state pause/resume is an
 *           idempotent success.
 *   DELETE — explicit 405: no destructive ops in the MVP (plan non-goal).
 *
 * Scoping: another artist's project id is indistinguishable from a missing
 * one (404) — no existence leak. Auth: BE3 artist session (401 otherwise).
 */

import { json } from '@sveltejs/kit';
import { getArtistFromCookies } from '$lib/server/artist-session';
import { fireArtworkRefresh } from '$lib/server/artwork';
import {
	normalizeArtistName,
	normalizeTitle,
	parseAlbumUrl,
	projectDetail,
	updateProject,
	type ProjectPatch
} from '$lib/server/project';
import type { RequestHandler } from './$types';

/** Strict positive-integer param parse — `Number('1e2')` must not resolve to id 100. */
function projectIdParam(param: string | undefined): number | null {
	return typeof param === 'string' && /^\d+$/.test(param) && Number(param) > 0 ? Number(param) : null;
}

const TRANSITION_MESSAGES: Record<string, string> = {
	draft: 'Draft projects activate automatically when codes are uploaded — nothing to pause or resume yet.',
	drained: 'A drained project re-activates automatically when new codes are uploaded; there is nothing to hand-switch while the pool is empty.'
};

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

	const projectId = projectIdParam(event.params.id);
	if (projectId === null) {
		return json({ error: 'not_found' }, { status: 404 });
	}

	const detail = await projectDetail(env.DB, artist.artistId, projectId);
	if (!detail) {
		return json({ error: 'not_found' }, { status: 404 });
	}
	return json({ project: detail });
};

export const PATCH: RequestHandler = async (event) => {
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

	const body = await event.request.json().catch(() => null);
	const raw = body as { title?: unknown; artistName?: unknown; albumUrl?: unknown; status?: unknown; slug?: unknown } | null;
	// The slug is server-derived; a client attempting to set it is a bug worth rejecting, not ignoring.
	if (raw?.slug !== undefined) {
		return json({ error: 'slug_immutable', message: 'The share slug is derived from the artist and album names and cannot be set directly.' }, { status: 400 });
	}

	// Present-but-invalid fields are REJECTED, never silently ignored; at
	// least one of the four known fields must be present at all.
	const patch: ProjectPatch = {};
	let known = 0;
	if (raw?.title !== undefined) {
		const title = normalizeTitle(raw.title);
		if (title === null) return json({ error: 'invalid_title', maxChars: 200 }, { status: 400 });
		patch.title = title;
		known++;
	}
	if (raw?.artistName !== undefined) {
		const artistName = normalizeArtistName(raw.artistName);
		if (artistName === null) return json({ error: 'invalid_artist_name', maxChars: 200 }, { status: 400 });
		patch.artistName = artistName;
		known++;
	}
	if (raw?.albumUrl !== undefined) {
		const albumUrl = parseAlbumUrl(raw.albumUrl);
		if (albumUrl === null) return json({ error: 'invalid_album_url', message: 'The album URL must be a bandcamp.com page, e.g. https://yourname.bandcamp.com/album/your-album.' }, { status: 400 });
		patch.albumUrl = albumUrl;
		known++;
	}
	if (raw?.status !== undefined) {
		if (raw.status !== 'active' && raw.status !== 'paused') {
			return json({ error: 'invalid_status', message: "Status requests accept only 'paused' (pause) or 'active' (resume)." }, { status: 400 });
		}
		patch.requestStatus = raw.status;
		known++;
	}
	if (known === 0) {
		return json({ error: 'invalid_request', message: 'Nothing to update — provide title, artistName, albumUrl, or status.' }, { status: 400 });
	}

	const result = await updateProject({
		db: env.DB,
		artistId: artist.artistId,
		projectId,
		patch,
		now: new Date()
	});
	if (!result.ok) {
		if (result.reason === 'not-found') return json({ error: 'not_found' }, { status: 404 });
		return json(
			{
				error: 'invalid_transition',
				from: result.from,
				to: result.to,
				message: TRANSITION_MESSAGES[result.from] ?? 'This status change is not allowed.'
			},
			{ status: 409 }
		);
	}

	// BE8: a genuinely new album URL reset the artwork to 'pending' (in the
	// same UPDATE) — now fetch the new cover, deferred via waitUntil, exactly
	// like the create hook. A re-send of the identical URL refetches nothing.
	if (result.albumUrlChanged) {
		fireArtworkRefresh({
			db: env.DB,
			art: env.ART ?? null,
			artistId: artist.artistId,
			projectId,
			albumUrl: result.project.albumUrl,
			now: new Date(),
			context: event.platform.ctx ?? event.platform.context
		});
	}

	return json({ ok: true, project: result.project });
};

export const DELETE: RequestHandler = () => {
	// Explicit (rather than relying on the framework's automatic 405) so the
	// non-goal is legible to the FE and testable: projects are never deleted.
	return json(
		{ error: 'method_not_allowed', message: 'Projects cannot be deleted in this MVP.' },
		{ status: 405, headers: { allow: 'GET, PATCH' } }
	);
};
