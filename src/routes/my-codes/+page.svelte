<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import {
		Artwork,
		GhostAction,
		LabeledField,
		Panel,
		PrimaryAction,
		StatusChip
	} from '$lib/components';
	import { APP_NAME } from '$lib/brand';
	import type { PageData } from './$types';

	/**
	 * FE4 — my codes: the fan's claim archive.
	 *
	 * SSR-first, three arrival states from the load (never guessed here):
	 * no session → email + OTP entry (the SAME BE4 endpoints + FE3 command-
	 * entry pattern as the claim flow — verifying retrieves claims ACROSS
	 * DEVICES; the email is the identity, the browser is new); session → the
	 * full cross-project list via listFanClaims (keyed by the session's
	 * fan_hash — only ever the visitor's own codes); session + none → the
	 * honest empty state (the board is live, nothing claimed yet).
	 *
	 * Each claim renders as its own mini code slab: the seven-segment readout,
	 * the selectable mono code (spelled out for screen readers — the FE3
	 * pattern), copy with select-fallback, the R3-verified redeem deep-link
	 * built CLIENT-side only, the claim date, and the dead-code report with
	 * its exactly-one replacement — reusing FE3's inline-confirm affordance.
	 * A report updates the row in place from the response, then invalidateAll
	 * re-reads the archive so every status stays real.
	 *
	 * Session expiry mid-action (401): the entry returns INLINE (same page,
	 * archive preserved behind it) — re-verify and the archive comes back.
	 *
	 * Copy register: gift-archive warmth (FE3) — no crisis-shouting at the
	 * person holding gifts; the wall is the drama.
	 */

	let { data }: { data: PageData } = $props();

	// --- entry (no session / lapsed): FE3's launch-sequence pattern ---------
	type Step = 'email' | 'otp';
	let step: Step = $state('email');
	let email = $state('');
	let otp = $state('');
	let emailError = $state('');
	let otpError = $state('');
	let emailBusy = $state(false);
	let otpBusy = $state(false);
	/** transient console-level note (session lapses; never shouts). */
	let entryNote = $state('');
	/** transient OTP-step note (sends, resends, cooldowns). */
	let otpNote = $state('');
	/** true when an action's 401 contradicted a session the load still holds. */
	let sessionLapsed = $state(false);

	const showEntry = $derived(!data.fanHasSession || sessionLapsed);

	async function postJson(path: string, body: unknown) {
		const res = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = (await res.json().catch(() => null)) as
			| (Record<string, unknown> & { error?: string; retryAfterSeconds?: number; resendInSeconds?: number })
			| null;
		return { res, body: data };
	}

	// OTP resend gate — server-provided seconds, counted down honestly.
	let resendAt = $state<number | null>(null);
	let tick = $state(0); // 1 Hz heartbeat while a countdown runs

	function startCooldown(seconds: number) {
		resendAt = Date.now() + Math.max(0, seconds) * 1000;
	}

	const resendIn = $derived.by(() => {
		void tick;
		return resendAt === null ? 0 : Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
	});
	const resendLabel = $derived(
		resendIn >= 60 ? `${Math.floor(resendIn / 60)}:${String(resendIn % 60).padStart(2, '0')}` : `${resendIn}s`
	);

	$effect(() => {
		if (step !== 'otp' || resendAt === null) return;
		const id = setInterval(() => {
			tick++;
			if (Date.now() >= resendAt!) resendAt = null;
		}, 500);
		return () => clearInterval(id);
	});

	async function submitEmail(event: SubmitEvent) {
		event.preventDefault();
		emailError = '';
		if (email.trim().length === 0) {
			emailError = 'Enter your email first — it is the key to your codes.';
			return;
		}
		emailBusy = true;
		const { res, body } = await postJson('/api/fan/request-otp', { email });
		emailBusy = false;
		if (res.ok) {
			step = 'otp';
			otpNote = `Code sent to ${email.trim()} — it arrives in a moment (spam folder, just in case).`;
			startCooldown(typeof body?.resendInSeconds === 'number' ? body.resendInSeconds : 60);
			return;
		}
		switch (body?.error) {
			case 'invalid_email':
				emailError = 'That email does not look right — check it and send again.';
				break;
			case 'otp_cooldown':
				// A live pending exists for this address — go enter it, honestly gated.
				step = 'otp';
				startCooldown(body?.retryAfterSeconds ?? 60);
				otpNote = `A code was already sent to ${email.trim()} — the next one unlocks in ${resendLabel}.`;
				break;
			case 'rate_limited':
				emailError = `Too many codes sent from this network — the console cools down for ${body?.retryAfterSeconds ?? 60}s.`;
				break;
			case 'email_throttled':
				emailError = 'The mail system is at capacity right now — try again in a few minutes.';
				break;
			default:
				emailError = 'The send failed — wait a moment and try again.';
		}
	}

	async function submitOtp(event: SubmitEvent) {
		event.preventDefault();
		otpError = '';
		// Digits only (inputmode + maxlength guide, but the console trusts nothing).
		const code = otp.replace(/\D/g, '').slice(0, 6);
		if (code.length < 6) {
			otpError = 'Enter the 6-digit code from the email.';
			return;
		}
		otpBusy = true;
		const { res, body } = await postJson('/api/fan/verify-otp', { email: email.trim(), code });
		if (res.ok) {
			otpNote = 'Verified — opening your archive…';
			sessionLapsed = false;
			// The fresh session cookie makes the re-run load return the claims.
			await invalidateAll();
			otpBusy = false;
			focusArchive();
			return;
		}
		otpBusy = false;
		switch (body?.error) {
			case 'expired_code':
				otpError = 'That code expired — send a fresh one below.';
				break;
			case 'too_many_attempts':
				otpError = 'Too many tries — this code is locked. Send a fresh one below.';
				break;
			case 'invalid_code':
			default:
				otpError = 'Wrong code — check the email and retype the digits.';
		}
	}

	async function resendCode() {
		otpNote = '';
		const { res, body } = await postJson('/api/fan/request-otp', { email: email.trim() });
		if (res.ok) {
			startCooldown(typeof body?.resendInSeconds === 'number' ? body.resendInSeconds : 60);
			otpNote = 'Fresh code sent — check your inbox.';
		} else if (typeof body?.retryAfterSeconds === 'number') {
			startCooldown(body.retryAfterSeconds);
			otpNote = `The mailer is pacing this address — next send in ${resendLabel}.`;
		} else {
			otpNote = 'The send failed — try again in a moment.';
		}
	}

	// --- the archive (session): claims with in-place report updates ----------
	type Claim = NonNullable<PageData['claims']>[number];
	/** Row overlays from report responses (code flips land instantly). */
	let claimOverrides = $state<Record<number, Partial<Claim>>>({});
	/** Per-row transient notices (report outcomes). */
	let claimNotes = $state<Record<number, string>>({});

	const claims = $derived(
		data.claims === null ? null : data.claims.map((claim) => ({ ...claim, ...claimOverrides[claim.claimId] }))
	);
	const heldCount = $derived(claims?.length ?? 0);

	/** Report delegate — the page owns the POST + row update (FE3 pattern). */
	async function reportDeadCode(claim: Claim): Promise<void> {
		const { res, body } = await postJson('/api/fan/report', { slug: claim.slug });
		if (res.status === 401) {
			// Session expired mid-visit: re-verify inline; the archive returns.
			sessionLapsed = true;
			step = 'email';
			entryNote = 'Your session lapsed — enter your email to verify again.';
			return;
		}
		if (!res.ok || !body || !('claim' in body)) {
			claimNotes = { ...claimNotes, [claim.claimId]: 'The report did not send — try again in a moment.' };
			return;
		}
		const updated = (body as { claim: Partial<Claim> }).claim;
		claimOverrides = { ...claimOverrides, [claim.claimId]: updated };
		const outcome = (body as { outcome?: string }).outcome;
		if (outcome === 'reissued') {
			claimNotes = {
				...claimNotes,
				[claim.claimId]: `Reported ${(body as { reportedCode?: string }).reportedCode} — here is your replacement.`
			};
		} else if (outcome === 'reissue_drained') {
			claimNotes = { ...claimNotes, [claim.claimId]: 'Report recorded — no codes remain in this pool to replace it.' };
		} else {
			claimNotes = { ...claimNotes, [claim.claimId]: 'Your one replacement was already issued — this is it.' };
		}
		// The archive must stay real: statuses (and any counts) just changed.
		void invalidateAll();
	}

	// --- per-row state (keyed — many rows live at once) -----------------------
	const copyStates = $state<Record<number, 'idle' | 'copied' | 'selected'>>({});
	const reportViews = $state<Record<number, 'idle' | 'confirm'>>({});
	const reportSending = $state<Record<number, boolean>>({});
	const codeEls = new Map<number, HTMLParagraphElement>();
	const copyTimers = new Map<number, ReturnType<typeof setTimeout>>();
	$effect(() => () => copyTimers.forEach((timer) => clearTimeout(timer)));

	/** @attach registrar for the per-row code elements (select-fallback targets). */
	function bindCodeEl(claimId: number, el: Element) {
		codeEls.set(claimId, el as HTMLParagraphElement);
	}

	async function copyCode(claim: Claim) {
		clearTimeout(copyTimers.get(claim.claimId));
		let copied = false;
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			try {
				await navigator.clipboard.writeText(claim.code);
				copied = true;
			} catch {
				copied = false; // permission denied / not allowed — fall through
			}
		}
		if (copied) {
			copyStates[claim.claimId] = 'copied';
		} else {
			// Manual-select fallback: the code text itself is the affordance.
			const el = codeEls.get(claim.claimId);
			if (el && typeof document !== 'undefined') {
				const range = document.createRange();
				range.selectNodeContents(el);
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
				copyStates[claim.claimId] = 'selected';
			}
		}
		copyTimers.set(
			claim.claimId,
			setTimeout(() => (copyStates[claim.claimId] = 'idle'), 4000)
		);
	}

	async function sendReport(claim: Claim) {
		if (reportSending[claim.claimId]) return;
		reportSending[claim.claimId] = true;
		try {
			await reportDeadCode(claim);
		} finally {
			reportSending[claim.claimId] = false; // outcomes land as new props + overlay
			reportViews[claim.claimId] = 'idle';
		}
	}

	// --- view helpers -----------------------------------------------------------
	const dateFmt = new Intl.DateTimeFormat('en', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC'
	});
	function formatDate(sqlUtc: string | null): string {
		if (!sqlUtc) return '';
		const ms = Date.parse(`${sqlUtc.replace(' ', 'T')}Z`);
		return Number.isFinite(ms) ? dateFmt.format(new Date(ms)) : sqlUtc;
	}

	/** Panel-head data line: when this claim's code was dispensed. */
	function sublabelFor(claim: Claim): string {
		return claim.kind === 'reissue'
			? `replaced ${formatDate(claim.reissuedAt) || formatDate(claim.claimedAt)}`
			: `claimed ${formatDate(claim.claimedAt)}`;
	}

	/** The honest history line (replacements + dead codes carry one; originals don't). */
	function historyFor(claim: Claim): string {
		if (claim.kind === 'reissue') {
			return `Your original code didn't work — this replacement was issued ${formatDate(claim.reissuedAt) || formatDate(claim.claimedAt)}, drawn from what remained in the pool.`;
		}
		if (claim.codeStatus === 'reported') {
			return 'You reported this code dead — it is kept here for your records. No code remained in this pool to replace it.';
		}
		return '';
	}

	const ghostFor = (claim: Claim) => claim.code.replace(/[a-z0-9]/gi, '8');
	const charsFor = (claim: Claim) => [...claim.code];
	/** Spelled out for screen readers — dash as a word, characters separated. */
	const spelledFor = (claim: Claim) =>
		`Your ${claim.title} code, spelled out: ${[...claim.code].map((c) => (c === '-' ? 'dash' : c)).join(', ')}`;
	const redeemUrlFor = (claim: Claim) =>
		claim.yumUrl && claim.codeStatus !== 'reported'
			? `${claim.yumUrl}?code=${encodeURIComponent(claim.code)}`
			: null;

	// --- focus management: entry steps → archive -------------------------------
	let stepBox = $state<HTMLDivElement | undefined>(undefined);
	let archiveBox = $state<HTMLDivElement | undefined>(undefined);

	$effect(() => {
		if (showEntry && (step === 'email' || step === 'otp')) {
			// Next paint: the step just rendered.
			requestAnimationFrame(() => stepBox?.querySelector<HTMLInputElement>('input')?.focus());
		}
	});
	function focusArchive() {
		requestAnimationFrame(() => archiveBox?.focus());
	}
</script>

<svelte:head>
	<title>My codes · {APP_NAME}</title>
	<meta
		name="description"
		content="Every Bandcamp code you've claimed, across projects and devices — look them up with your email and a one-time code."
	/>
	<meta name="robots" content="noindex" />
</svelte:head>

<h1 class="display title">My codes</h1>
<p class="label sub">
	{#if showEntry}
		claim archive · verify to open
	{:else if heldCount > 0}
		{heldCount} {heldCount === 1 ? 'code' : 'codes'} held · every project, every device
	{:else}
		claim archive · nothing held
	{/if}
</p>

{#if showEntry}
	<Panel label="archive access" sublabel="one-time verify" tag="認証">
		{#if entryNote}
			<p class="console-note" role="alert">{entryNote}</p>
		{/if}

		{#if step === 'email'}
			<div class="entry" bind:this={stepBox}>
				<p class="entry-copy">
					Every code you've claimed gathers here — on any device, for any project. Enter the
					email you claimed with: one 6-digit code verifies this browser and the archive opens.
				</p>
				<form class="entry-form" onsubmit={submitEmail} novalidate>
					<LabeledField
						label="your email"
						hint="stored as a salted hash — never readable, never shared"
						error={emailError}
						bind:value={email}
						type="email"
						name="email"
						autocomplete="email"
						inputmode="email"
						placeholder="fan@example.com"
					/>
					<PrimaryAction class="entry-submit" type="submit" disabled={emailBusy}>
						{emailBusy ? 'sending…' : 'send my code'}
					</PrimaryAction>
				</form>
			</div>
		{:else if step === 'otp'}
			<div class="entry" bind:this={stepBox}>
				<p class="entry-copy">
					Enter the 6-digit code from the email — the archive unlocks the moment it verifies.
				</p>
				<form class="entry-form" onsubmit={submitOtp} novalidate>
					<div class="otp-wrap">
						<LabeledField
							label="6-digit code"
							error={otpError}
							bind:value={otp}
							type="text"
							name="code"
							autocomplete="one-time-code"
							inputmode="numeric"
							placeholder="6 digits"
							maxlength={6}
						/>
					</div>
					<PrimaryAction class="entry-submit" type="submit" disabled={otpBusy}>
						{otpBusy ? 'opening…' : 'verify + open archive'}
					</PrimaryAction>
				</form>
				<div class="otp-afters">
					{#if otpNote}
						<p class="otp-note" role="status">{otpNote}</p>
					{/if}
					{#if resendAt !== null}
						<span class="resend label">resend unlocks in {resendLabel}</span>
					{:else}
						<button class="resend-link" type="button" onclick={resendCode}>send a fresh code</button>
					{/if}
					<button class="change-link" type="button" onclick={() => ((step = 'email'), (otp = ''))}>
						use a different email
					</button>
				</div>
			</div>
		{/if}
	</Panel>
{:else}
	<div class="archive" bind:this={archiveBox} tabindex="-1" role="region" aria-label="your claim archive">
		{#if claims !== null && claims.length > 0}
			<ul class="claims">
				{#each claims as claim (claim.claimId)}
					{@const dead = claim.codeStatus === 'reported'}
					{@const chars = charsFor(claim)}
					{@const history = historyFor(claim)}
					{@const redeemUrl = redeemUrlFor(claim)}
					<li class="claims__slot">
						<article class="claim" aria-label="Your claim: {claim.title} by {claim.artistName}">
							<Panel
								label={claim.title}
								sublabel={sublabelFor(claim)}
								tone={dead ? 'alarm' : 'nominal'}
								tag="保持コード"
							>
								<div class="claim__row">
									<div class="claim__art">
										<Artwork
											title={claim.title}
											artistName={claim.artistName}
											url={claim.artworkUrl}
											status={claim.artworkStatus}
										/>
									</div>
									<div class="claim__who">
										<a class="claim__artist display" href="/p/{claim.slug}">
											by {claim.artistName}
										</a>
										<span class="claim__open label" aria-hidden="true">open drop →</span>
									</div>
								</div>

								<div class="claim__well" class:claim__well--dead={dead}>
									<span class="claim__readout" aria-hidden="true" style="--char-count: {chars.length}">
										<span class="claim__ghost">{ghostFor(claim)}</span>
										<span class="claim__display">
											{#each chars as ch, i (i)}
												<span class="claim__char">{ch}</span>
											{/each}
										</span>
									</span>
<p class="claim__code" {@attach (el) => bindCodeEl(claim.claimId, el)} aria-label={spelledFor(claim)}>
	{claim.code}
</p>
									<span class="claim__hint label">
										<span class="claim__hint-fine">click the code to select it</span>
										<span class="claim__hint-coarse">tap the code to select it</span>
									</span>
								</div>

								{#if history}
									<p class="claim__history">{history}</p>
								{/if}

								{#if claimNotes[claim.claimId]}
									<p class="claim__notice" role="status">{claimNotes[claim.claimId]}</p>
								{/if}

								<div class="claim__actions">
									<GhostAction onclick={() => copyCode(claim)}>
										{copyStates[claim.claimId] === 'copied'
											? 'copied'
											: copyStates[claim.claimId] === 'selected'
												? 'code selected'
												: 'copy code'}
									</GhostAction>
									{#if redeemUrl}
										<GhostAction
											class="claim__redeem"
											href={redeemUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											redeem on bandcamp
										</GhostAction>
									{:else if dead}
										<span class="claim__none label">redeem disabled — this code is dead</span>
									{:else}
										<span class="claim__none label">no direct redeem link — copy the code and redeem it on the artist's Bandcamp</span>
									{/if}
								</div>

								<p class="claim__copynote label" role="status">
									{#if copyStates[claim.claimId] === 'copied'}
										code copied — paste it into Bandcamp's redeem page
									{:else if copyStates[claim.claimId] === 'selected'}
										code selected — press Cmd/Ctrl + C to copy it
									{/if}
								</p>

								{#snippet footer()}
									<StatusChip
										state={dead ? 'reported' : 'claimed'}
										text={dead ? 'reported — dead' : claim.kind === 'reissue' ? 'replacement — yours' : 'claimed — yours'}
									/>
									{#if !dead && claim.kind === 'original'}
										{#if reportViews[claim.claimId] === 'confirm'}
											<span class="claim__confirm">
												<span class="claim__confirm-copy">
													report <strong class="claim__confirm-code">{claim.code}</strong> as already redeemed?
													the artist sees the report — you get one replacement if any codes remain.
												</span>
												<span class="claim__confirm-row">
													<button
														class="claim__report-go"
														type="button"
														onclick={() => sendReport(claim)}
														disabled={reportSending[claim.claimId]}
													>
														{reportSending[claim.claimId] ? 'sending…' : 'report it'}
													</button>
													<button
														class="claim__report-keep"
														type="button"
														onclick={() => (reportViews[claim.claimId] = 'idle')}
														disabled={reportSending[claim.claimId]}
													>
														keep this code
													</button>
												</span>
											</span>
										{:else}
											<button
												class="claim__report-link"
												type="button"
												onclick={() => (reportViews[claim.claimId] = 'confirm')}
											>
												code didn't work? report it
											</button>
										{/if}
									{:else if !dead && claim.kind === 'reissue'}
										<span class="label">your one replacement was already issued</span>
									{/if}
								{/snippet}
							</Panel>
						</article>
					</li>
				{/each}
			</ul>
			<p class="archive-note label">same email, same codes — verify once on a new device and this archive follows you</p>
		{:else}
			<Panel label="archive status" sublabel="empty" tag="アーカイブ">
				<h2 class="empty-title display">No codes yet</h2>
				<p class="empty-copy">
					Nothing claimed from this email — and the board is live: every drop on it shows its
					real codes-remaining count. Claim your first and it gathers here, on every device.
				</p>
				{#snippet footer()}
					<PrimaryAction href="/">browse the board</PrimaryAction>
				{/snippet}
			</Panel>
			<div class="hazard empty-band" aria-hidden="true"></div>
		{/if}
	</div>
{/if}

<style>
	.title {
		font-size: clamp(var(--step-4), 8vw, var(--step-6));
		margin-bottom: var(--gap-2);
	}

	.sub {
		margin-bottom: var(--gap-6);
	}

	/* --- entry (command-entry console — FE3's pattern) ------------------------ */
	.entry {
		display: flex;
		flex-direction: column;
		gap: var(--gap-4);
	}

	.entry-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	.entry-form {
		display: flex;
		flex-direction: column;
		gap: var(--gap-4);
		align-items: flex-start;
		max-width: 30rem;
		width: 100%;
	}

	.entry-form :global(input) {
		font-size: var(--step-2);
	}

	/* the OTP command line: digits arrive tracked + centered like a readout entry */
	.otp-wrap :global(input) {
		text-align: center;
		letter-spacing: 0.6em;
		text-indent: 0.6em;
		font-weight: 620;
	}

	/* class lands inside PrimaryAction's root — reach it globally */
	:global(.entry-submit) {
		min-width: min(100%, 12rem);
	}

	.otp-afters {
		display: flex;
		align-items: baseline;
		gap: var(--gap-4);
		flex-wrap: wrap;
	}

	.otp-note {
		font-size: var(--step--1);
		color: var(--text);
		max-width: 46ch;
	}

	.resend {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.resend-link,
	.change-link {
		background: none;
		border: none;
		padding: 0;
		color: var(--orange);
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 460;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		text-decoration: underline;
		text-underline-offset: 0.22em;
		text-decoration-thickness: 1px;
		cursor: pointer;
		transition: color 140ms ease-out;
	}

	.resend-link:hover,
	.change-link:hover {
		color: var(--orange-bright);
	}

	.resend-link:focus-visible,
	.change-link:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: 3px;
	}

	.console-note {
		border: 1px solid var(--hairline-alarm);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
		max-width: var(--measure);
	}

	/* --- the archive: one mini slab per claim ---------------------------------- */
	.archive {
		outline: none;
	}

	.claims {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--gap-4);
	}

	.claims__slot {
		display: flex;
	}

	.claim {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.claim :global(.panel) {
		flex: 1;
	}

	.claim__row {
		display: flex;
		gap: var(--gap-3);
		align-items: stretch;
	}

	.claim__art {
		flex: none;
		width: 96px; /* the cover is the payload's face, not a favicon */
	}

	.claim__who {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--gap-2);
		padding-block: var(--gap-1);
	}

	.claim__artist {
		font-size: var(--step-2);
		line-height: 1.04;
		color: var(--text);
		text-decoration: none;
		overflow-wrap: anywhere;
		transition: color 140ms ease-out;
	}

	.claim__artist:hover {
		color: var(--orange-bright);
	}

	.claim__artist:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: 3px;
	}

	.claim__open {
		color: var(--orange);
		transition: transform 140ms ease-out;
	}

	.claim__who:hover .claim__open {
		transform: translateX(3px);
	}

	/* --- the mini slab: a claim's code at readout scale ------------------------ */
	.claim__well {
		container-type: inline-size;
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--gap-2);
		padding: clamp(0.85rem, 3cqw, 1.75rem) clamp(0.6rem, 2.5cqw, 1.5rem);
		background: var(--panel-inset);
		border: 1px solid var(--hairline-green);
		overflow: hidden;
	}

	.claim__readout {
		position: relative;
		display: inline-flex;
		font-family: var(--font-seg);
		font-weight: 700;
		/* DSEG7 monospaced advance 0.816em + 0.12em tracking = 0.936em per glyph
		   (CodeSlab's verified math): the run sizes to ~84% of the well width at
		   every code length — structurally unable to overflow. Endpoints are ramp
		   steps (the formula itself is DESIGN.md's Code-Readout Formula). */
		font-size: clamp(
			var(--step-2),
			calc(84cqw / 0.936 / var(--char-count, 9)),
			var(--step-6)
		);
		line-height: 1.05;
		letter-spacing: 0.12em;
		white-space: nowrap;
		font-kerning: none;
	}

	.claim__display {
		color: var(--green);
		text-shadow: var(--glow-green);
	}

	/* the unlit segments under the code */
	.claim__ghost {
		position: absolute;
		inset: 0;
		color: rgba(57, 211, 83, 0.085);
		text-shadow: none;
	}

	.claim__char {
		display: inline-block;
	}

	.claim__code {
		font-family: var(--font-mono);
		/* readable-but-subordinate: the archive's reading layer rides the ramp
		   (emphasis floor → section-display ceiling), one tier under the slab's */
		font-size: clamp(var(--step-1), 4.5cqw, var(--step-2));
		font-weight: 640;
		letter-spacing: 0.24em;
		translate: 0.12em; /* re-center: tracking hangs one gap past the last glyph */
		color: var(--text);
		overflow-wrap: anywhere;
		-webkit-user-select: all;
		user-select: all;
	}

	.claim__hint {
		color: var(--text-muted);
	}

	/* pointer-honest wording (CodeSlab's pattern) */
	.claim__hint-coarse {
		display: none;
	}

	@media (pointer: coarse) {
		.claim__hint-fine {
			display: none;
		}

		.claim__hint-coarse {
			display: inline;
		}
	}

	/* dead code: the readout goes to alarm (CodeSlab grammar) */
	.claim__well--dead {
		border-color: var(--hairline-alarm);
	}

	.claim__well--dead .claim__display {
		color: var(--alarm-bright);
		text-shadow: var(--glow-alarm);
	}

	.claim__well--dead .claim__ghost {
		color: rgba(232, 16, 42, 0.09);
	}

	.claim__history {
		font-size: var(--step--1);
		color: var(--text);
		max-width: var(--measure);
	}

	.claim__notice {
		border: 1px solid var(--hairline-dim);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
	}

	.claim__actions {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--gap-2);
		flex-wrap: wrap;
	}

	.claim__none {
		max-width: 40ch;
	}

	.claim__copynote {
		min-height: 1.4em; /* the row never shifts when a note lands */
		text-align: center;
		color: var(--green);
	}

	/* --- report affordance (CodeSlab's inline confirm, row-scaled) ------------- */
	.claim__report-link {
		background: none;
		border: none;
		padding: 0;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 460;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		text-decoration: underline;
		text-underline-offset: 0.22em;
		text-decoration-thickness: 1px;
		cursor: pointer;
		transition: color 140ms ease-out;
	}

	.claim__report-link:hover {
		color: var(--alarm-bright);
	}

	.claim__report-link:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: 3px;
	}

	.claim__confirm {
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
		flex: 1 1 32ch;
		min-width: 0;
	}

	.claim__confirm-copy {
		font-size: var(--step--1);
		color: var(--text);
		max-width: 60ch;
	}

	.claim__confirm-code {
		font-family: var(--font-mono);
		color: var(--alarm-bright);
		font-weight: 640;
		letter-spacing: 0.08em;
	}

	.claim__confirm-row {
		display: flex;
		gap: var(--gap-2);
		flex-wrap: wrap;
	}

	.claim__report-go,
	.claim__report-keep {
		min-height: 2.5rem;
		padding: 0.35rem 0.9rem;
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 560;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		cursor: pointer;
	}

	.claim__report-go {
		background: var(--alarm);
		border: 1px solid var(--alarm-bright);
		color: var(--ink); /* large-text-equivalent weight on red: chip fill grammar */
	}

	.claim__report-go:hover {
		background: var(--alarm-bright);
	}

	.claim__report-go:focus-visible {
		outline: 2px solid var(--alarm-bright);
		outline-offset: 3px;
	}

	.claim__report-keep {
		background: var(--panel-inset);
		border: 1px solid var(--hairline);
		color: var(--text);
	}

	.claim__report-keep:hover {
		border-color: var(--orange);
	}

	.archive-note {
		margin-top: var(--gap-4);
		color: var(--text-muted);
	}

	/* --- honest empty state ------------------------------------------------------ */
	.empty-title {
		font-size: var(--step-3);
		margin-bottom: var(--gap-3);
	}

	.empty-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	.empty-band {
		height: 4px;
		opacity: 0.35;
		margin-top: var(--gap-4);
	}

	@media (min-width: 768px) {
		.claims {
			gap: var(--gap-5);
		}

		.claim__art {
			width: 120px;
		}
	}
</style>
