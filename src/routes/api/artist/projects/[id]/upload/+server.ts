/**
 * POST /api/artist/projects/[id]/upload (BE7) — CSV upload → batch + codes.
 *
 * Body: either multipart/form-data (a `file` field — a File, or any File
 * field by fallback) or the raw CSV text (any non-multipart content type,
 * e.g. text/csv). Hard size cap ~2MB (UPLOAD_MAX_BYTES) → 413.
 *
 * Wiring (the BE2-documented recipe): parseBandcampCsv (within-file dedupe)
 * → fetchExistingCodes + dedupeAgainstExisting (cross-batch dedupe) → one
 * transactional db.batch inserting the batch's fresh codes + the status flip
 * (draft/drained → active; drained re-activation is BE5's note honored — the
 * auto-flip only ever fires FROM 'active' inside the dispense batch, so the
 * way back is owned here; a paused project keeps its pause).
 *
 * Response: parsed/inserted counts, duplicates skipped (in-file + already
 * present), invalid lines, the CSV's album-title/yum-URL harvest — offered as
 * `autofill` candidates for the FE to CONFIRM (values that differ from the
 * stored ones); artist-entered values are never silently overwritten.
 *
 * Auth: BE3 artist session (401 otherwise). Another artist's project id: 404.
 */

import { json } from '@sveltejs/kit';
import { getArtistFromCookies } from '$lib/server/artist-session';
import { UPLOAD_MAX_BYTES, uploadCodes } from '$lib/server/project';
import type { RequestHandler } from './$types';

function projectIdParam(param: string | undefined): number | null {
	return typeof param === 'string' && /^\d+$/.test(param) && Number(param) > 0 ? Number(param) : null;
}

/** Pulled upload content: the CSV text (+ filename when the transport carried one). */
interface UploadedCsv {
	text: string;
	filename: string | null;
}

async function readUpload(request: Request): Promise<UploadedCsv | null | 'too-large'> {
	// Cheap early rejection when the client declares an oversized body.
	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > UPLOAD_MAX_BYTES + 8 * 1024) {
		return 'too-large'; // + slack for multipart framing around the file
	}

	let text: string;
	let filename: string | null = null;
	const contentType = request.headers.get('content-type') ?? '';
	if (contentType.includes('multipart/form-data')) {
		const form = await request.formData().catch(() => null);
		if (!form) return null;
		let value: FormDataEntryValue | null = form.get('file');
		if (!(value instanceof File)) {
			// Fallback: the first File under any field name (FE5 may pick another label).
			for (const candidate of form.values()) {
				if (candidate instanceof File) {
					value = candidate;
					break;
				}
			}
		}
		if (value instanceof File) {
			filename = value.name.length > 0 ? value.name.slice(0, 255) : null;
			text = await value.text();
		} else if (typeof value === 'string' && value.trim().length > 0) {
			text = value; // a plain form field carrying the CSV text
		} else {
			return null;
		}
	} else {
		text = await request.text();
	}

	// Authoritative cap on what was actually read (UTF-8 byte length, ~2MB).
	if (new TextEncoder().encode(text).length > UPLOAD_MAX_BYTES) {
		return 'too-large';
	}
	return { text, filename };
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

	const uploaded = await readUpload(event.request);
	if (uploaded === 'too-large') {
		return json({ error: 'file_too_large', maxBytes: UPLOAD_MAX_BYTES, message: 'CSV uploads are limited to about 2 MB.' }, { status: 413 });
	}
	if (uploaded === null) {
		return json({ error: 'invalid_upload', message: 'Send the Bandcamp CSV export as multipart form data (a file field) or as the raw request body.' }, { status: 400 });
	}

	const result = await uploadCodes({
		db: env.DB,
		artistId: artist.artistId,
		projectId,
		csvText: uploaded.text,
		filename: uploaded.filename,
		now: new Date()
	});

	if (!result.ok) {
		if (result.reason === 'not-found') return json({ error: 'not_found' }, { status: 404 });
		if (result.reason === 'invalid-csv') {
			// message is BE2's human-readable, artist-safe text — shown verbatim by FE5.
			return json({ error: 'invalid_csv', message: result.message }, { status: 400 });
		}
		return json(
			{ error: 'conflict', message: 'Some of these codes were uploaded concurrently; upload again to pick up the rest.' },
			{ status: 409 }
		);
	}

	return json({
		ok: true,
		batchId: result.batchId,
		// BE2's parsed count: unique valid codes in the file = inserted + skipped-as-already-present.
		parsed: result.inserted + result.alreadyPresent.length,
		inserted: result.inserted,
		duplicatesInFile: result.duplicatesInFile,
		duplicatesExisting: result.alreadyPresent,
		invalidLines: result.invalidLines,
		albumTitle: result.albumTitle,
		yumUrl: result.yumUrl,
		autofill: result.autofill,
		projectStatus: result.status
	});
};
