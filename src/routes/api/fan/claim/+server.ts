/**
 * POST /api/fan/claim — dispense (or re-show) this fan's code for one project
 * (the endpoint behind FE3's LAUNCH CLAIM — the launch sequence's landing).
 *
 * Auth: fan session cookie (BE4). Body: exactly one of `{ projectId: number }`
 * or `{ slug: string }` (same validation grammar as /api/fan/report). The
 * session's fan_hash IS the identity — dispenseCode keys the pick, the
 * 1+1-per-email constraint, and the revisit re-show entirely by it, so the
 * response can only ever contain THIS session fan's claim (never another
 * fan's code), and a fan with no session is told to verify first (401).
 *
 * Response mapping (FE3 renders these):
 *   200 outcome=claimed  reused=false — fresh dispense (the launch moment)
 *   200 outcome=revisit  reused=true  — the fan already claimed: the SAME code
 *        re-shown. This is also the honest "limit hit" state — one code per
 *        fan per drop means the limit IS your claim, never a dead end.
 *   401 unauthorized — no/invalid fan session (the flow starts email+OTP)
 *   400 invalid_request — malformed body
 *   404 not_found — unknown or draft project (indistinguishable, no leak)
 *   409 paused / 409 drained — honest pool states (BE5's typed guards)
 *
 * R3 constraint honored structurally: this handler never performs any outbound
 * HTTP fetch — it cannot touch /yum?code=<real> (the redeem deep-link is built
 * and followed client-side only).
 */

import { json } from '@sveltejs/kit';
import { fanClaimForProject, type FanClaimView } from '$lib/server/fan-identity';
import { getFanFromCookies, FAN_SESSION_COOKIE, fanSessionCookieOptions } from '$lib/server/fan-session';
import { dispenseCode, hashIp } from '$lib/server/dispense';
import type { RequestHandler } from './$types';

/** Fan-facing claim body — same shape as the SSR load's claim (FanClaimView minus nothing: it never carried fan_hash). */
function claimBody(claim: FanClaimView) {
	return {
		claimId: claim.claimId,
		projectId: claim.projectId,
		slug: claim.slug,
		title: claim.title,
		artistName: claim.artistName,
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
	const raw = body as { projectId?: unknown; slug?: unknown } | null;
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

	let ip = 'unknown';
	try {
		ip = event.getClientAddress();
	} catch {
		// No forwarding context (odd preview environments): bucket together.
	}
	const ipHash = await hashIp(ip, env.EMAIL_PEPPER);

	const result = await dispenseCode({
		db: env.DB,
		fanHash: fan.fanHash,
		project: projectId ?? slug!,
		ipHash,
		source: 'web',
		now: new Date()
	});

	if (!result.ok) {
		if (result.reason === 'paused') return json({ error: 'paused' }, { status: 409 });
		if (result.reason === 'drained') return json({ error: 'drained' }, { status: 409 });
		return json({ error: 'not_found' }, { status: 404 });
	}

	// Re-read via the SSR's own helper so the response body is byte-shaped like
	// the page load's claim (codeStatus/reissuedAt included for the slab states).
	const claim = await fanClaimForProject(env.DB, fan.fanHash, projectId ?? slug!);
	if (!claim) {
		// Unreachable after a committed dispense (same key, one transaction);
		// failing loudly beats fabricating a claim body.
		console.error('fan claim read-back missing after ok dispense', { projectId, slug });
		return json({ error: 'claim_read_failed' }, { status: 500 });
	}

	return json({ ok: true, outcome: result.reused ? 'revisit' : 'claimed', reused: result.reused, claim: claimBody(claim) });
};
