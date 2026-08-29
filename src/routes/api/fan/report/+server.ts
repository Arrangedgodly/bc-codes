/**
 * POST /api/fan/report — the fan reports their dispensed code dead (BE6).
 *
 * Auth: fan session cookie (BE4). Body: exactly one of `{ projectId: number }`
 * or `{ slug: string }`, plus an optional `note` (clamped server-side to
 * REASON_MAX_CHARS, stored as reports.reason). The session's fan_hash IS the
 * owner check — reportClaim keys everything by it, so a fan who never claimed
 * the project gets `no_claim`, and one claim can never be reported by anyone
 * else. Responses never echo the fan hash (or ip metadata).
 *
 * Outcome mapping (FE3 renders these):
 *   200 outcome=reissued         — report recorded + replacement dispensed
 *   200 outcome=reissue_drained  — report recorded, pool had nothing left
 *   200 outcome=already_reissued — the one report was already spent (re-show)
 *   404 not_found                — unknown/unpublished project
 *   409 no_claim                 — this fan holds no claim on the project
 */

import { json } from '@sveltejs/kit';
import { getFanFromCookies, FAN_SESSION_COOKIE, fanSessionCookieOptions } from '$lib/server/fan-session';
import { reportClaim, type ReportClaimView } from '$lib/server/report';
import type { RequestHandler } from './$types';

/** Fan-facing claim body — strips ip_hash/source (internal metadata). */
function claimBody(claim: ReportClaimView) {
	return {
		claimId: claim.claimId,
		codeId: claim.codeId,
		code: claim.code,
		kind: claim.kind,
		codeStatus: claim.codeStatus,
		claimedAt: claim.claimedAt,
		reissuedAt: claim.reissuedAt
	};
}

export const POST: RequestHandler = async (event) => {
	if (!event.platform) {
		return json({ error: 'server_misconfigured' }, { status: 500 });
	}
	const env = event.platform.env;

	const fan = await getFanFromCookies({
		db: env.DB,
		cookies: event.cookies,
		secret: env.SESSION_SECRET,
		now: new Date()
	});
	if (!fan) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	if (fan.refreshed) {
		// Sliding-window recipe (fan-session.ts module header).
		event.cookies.set(FAN_SESSION_COOKIE, event.cookies.get(FAN_SESSION_COOKIE)!, fanSessionCookieOptions(event.url.protocol === 'https:'));
	}

	const body = await event.request.json().catch(() => null);
	const raw = body as { projectId?: unknown; slug?: unknown; note?: unknown } | null;
	// Present-but-malformed fields are REJECTED, never silently ignored, and
	// exactly one project reference is required (no ambiguity about the target).
	const hasId = raw?.projectId !== undefined;
	const hasSlug = raw?.slug !== undefined;
	const projectId =
		typeof raw?.projectId === 'number' && Number.isInteger(raw.projectId) && raw.projectId > 0 ? raw.projectId : null;
	const slug = typeof raw?.slug === 'string' && raw.slug.trim().length > 0 ? raw.slug.trim() : null;
	if ((hasId && projectId === null) || (hasSlug && slug === null) || (projectId !== null) === (slug !== null)) {
		return json({ error: 'invalid_request' }, { status: 400 });
	}
	const note = typeof raw?.note === 'string' ? raw.note : null;

	const result = await reportClaim({
		db: env.DB,
		fanHash: fan.fanHash,
		project: projectId ?? slug!,
		reason: note,
		now: new Date()
	});

	if (!result.ok) {
		if (result.reason === 'no-claim') return json({ error: 'no_claim' }, { status: 409 });
		return json({ error: 'not_found' }, { status: 404 });
	}
	switch (result.outcome) {
		case 'reissued':
			return json({ ok: true, outcome: 'reissued', reportedCode: result.reportedCode, claim: claimBody(result.claim) });
		case 'reissue-drained':
			return json({ ok: true, outcome: 'reissue_drained', reportedCode: result.reportedCode, claim: claimBody(result.claim) });
		case 'already-reissued':
			return json({ ok: true, outcome: 'already_reissued', claim: claimBody(result.claim) });
	}
};
