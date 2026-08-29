<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Artwork,
		CodeSlab,
		GhostAction,
		LabeledField,
		Panel,
		PrimaryAction,
		SegmentedMeter,
		SevenSegmentCount,
		StatusChip
	} from '$lib/components';
	import { APP_NAME } from '$lib/brand';
	import type { PageData } from './$types';

	/**
	 * FE3 — the project page + claim flow: the launch sequence.
	 *
	 * SSR-first: every ARRIVAL state renders from the load (slab re-shown for
	 * a returning claimant · drained exhaust · paused hold · active drop with
	 * LAUNCH CLAIM). The interactive part is the launch sequence only —
	 * email → OTP → claim — calling the BE4 endpoints + /api/fan/claim, with
	 * every failure named in-world and every honest state one invalidate away.
	 *
	 * Fairness surfaces: limit-hit IS the revisit re-show (dispense answers
	 * reused=true — same code, never a dead end); the meter stays real by
	 * invalidating after every dispense; nobody else's claim can ever render
	 * (the load + endpoint key everything by the session's fan hash).
	 *
	 * Copy register: gift-launch warmth (the wall is the drama — the fan copy
	 * is warm). No crisis-shouting at the person holding a gift.
	 */

	let { data }: { data: PageData } = $props();

	const project = $derived(data.project);

	// --- claim state: server data is the base, client actions overlay it --------
	/**
	 * The fan's claim as this page renders it: the SSR load's claim (revisit
	 * re-show) until a client action (claim / report) hands back a fresher one.
	 * An overlay (not raw $state synced from data) so the slab can land
	 * instantly on dispense while invalidateAll refreshes counts around it.
	 */
	let claimOverride = $state<{ value: PageData['claim'] } | null>(null);
	const claim = $derived(claimOverride ? claimOverride.value : data.claim);
	/** steps() power-on: only a fresh dispense or reissue launches it. */
	let reveal = $state(false);
	/** true once a claim/reissue landed in THIS browser session (vs SSR re-show). */
	let arrivedHere = $state(false);

	// --- the launch sequence (client) ------------------------------------------
	type Step = 'idle' | 'email' | 'otp' | 'launching';
	let step: Step = $state('idle');
	let email = $state('');
	let otp = $state('');
	let emailError = $state('');
	let otpError = $state('');
	let emailBusy = $state(false);
	let otpBusy = $state(false);
	/** transient console-level note (claim failures, session lapses). */
	let consoleNote = $state('');
	/** transient OTP-step note (resends, cooldowns, lockouts). */
	let otpNote = $state('');
	/** OTP resend gate — server-provided seconds, counted down honestly. */
	let resendAt = $state<number | null>(null);
	let tick = $state(0); // 1 Hz heartbeat while a countdown runs

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

	function launchClaim() {
		consoleNote = '';
		// Verify-once-per-browser (BE4): a live session claims directly.
		if (data.fanHasSession) void doClaim();
		else step = 'email';
	}

	async function submitEmail(event: SubmitEvent) {
		event.preventDefault();
		emailError = '';
		if (email.trim().length === 0) {
			emailError = 'Enter your email first — it is how the code finds you.';
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
		otpBusy = false;
		if (res.ok) {
			otpNote = 'Verified — claiming your code…';
			await doClaim();
			return;
		}
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

	async function doClaim() {
		step = 'launching';
		consoleNote = '';
		const { res, body } = await postJson('/api/fan/claim', { slug: project.slug });
		if (res.ok && body && 'claim' in body) {
			claimOverride = { value: body.claim as NonNullable<PageData['claim']> };
			arrivedHere = true;
			reveal = body.reused !== true;
			step = 'idle';
			focusSlab();
			// The meter must stay real: counts (and possibly status) just changed.
			void invalidateAll();
			return;
		}
		step = 'idle';
		switch ((body as { error?: string } | null)?.error) {
			case 'paused':
				consoleNote = 'The artist paused this drop while you were verifying — the pool is held, not gone.';
				break;
			case 'drained':
				consoleNote = 'The last code was claimed while you were verifying — this pool is empty.';
				break;
			case 'unauthorized':
				step = 'email';
				consoleNote = 'Your session lapsed — enter your email to verify again.';
				break;
			default:
				consoleNote = 'The claim console glitched — try launching again.';
		}
		if (body && 'error' in body && (body.error === 'paused' || body.error === 'drained')) {
			await invalidateAll();
		}
	}

	/** Report delegate for the slab — the page owns the POST + state updates. */
	async function reportDeadCode(): Promise<'reissued' | 'reissue_drained' | 'already_reissued' | 'error'> {
		const { res, body } = await postJson('/api/fan/report', { slug: project.slug });
		if (!res.ok || !body || !('claim' in body)) {
			consoleNote = 'The report did not send — try again in a moment.';
			return 'error';
		}
		claimOverride = { value: body.claim as NonNullable<PageData['claim']> };
		const outcome = body.outcome as 'reissued' | 'reissue_drained' | 'already_reissued';
		if (outcome === 'reissued') {
			reveal = true;
			slabNotice = `Reported ${body.reportedCode} — here is your replacement.`;
		} else if (outcome === 'reissue_drained') {
			slabNotice = 'Report recorded — no codes remain in this pool to replace it.';
		} else {
			slabNotice = 'Your one replacement was already issued — this is it.';
		}
		void invalidateAll();
		return outcome;
	}

	let slabNotice = $state('');

	// --- focus management: email → OTP → slab ----------------------------------
	let stepBox = $state<HTMLDivElement | undefined>(undefined);
	let slabBox = $state<HTMLDivElement | undefined>(undefined);

	$effect(() => {
		if (step === 'email' || step === 'otp') {
			// Next paint: the step just rendered.
			requestAnimationFrame(() => stepBox?.querySelector<HTMLInputElement>('input')?.focus());
		}
	});
	function focusSlab() {
		requestAnimationFrame(() => slabBox?.focus());
	}

	// --- view + status semantics ------------------------------------------------
	const view = $derived.by(() => {
		if (claim) return 'slab';
		if (project.status === 'paused') return 'paused';
		if (project.status === 'drained') return 'drained';
		return 'launch';
	});

	/** Must mirror SegmentedMeter's LOW — one honest low-pool line. */
	const LOW_FRACTION = 0.15;
	const isLow = $derived(project.total > 0 && project.available / project.total <= LOW_FRACTION);

	const chipState = $derived(
		view === 'slab' ? 'claimed' : project.status === 'drained' ? 'drained' : project.status === 'paused' ? 'paused' : 'available'
	);
	const meterState = $derived(project.status === 'drained' || project.status === 'paused' ? project.status : 'active');
	const countTone = $derived(project.status === 'drained' ? 'red' : project.status === 'paused' || isLow ? 'orange' : 'green');
	const panelTone = $derived(project.status === 'drained' ? 'alarm' : project.status === 'paused' ? 'caution' : isLow ? 'caution' : 'nominal');

	const slabLine = $derived.by(() => {
		if (!claim || claim.kind === 'reissue') return ''; // slab default copy covers replacements
		return arrivedHere
			? `One random code from ${project.artistName}'s batch — it is yours.`
			: 'Still yours — this is the code you claimed, kept for whenever you return.';
	});
</script>

<svelte:head>
	<title>{project.title} — {project.artistName} · {APP_NAME}</title>
	<meta
		name="description"
		content="{project.title} by {project.artistName}: a live Bandcamp code drop. One random code per fan, verified by email — claim and redeem on Bandcamp."
	/>
	<link rel="canonical" href="{page.url.origin}/p/{project.slug}" />
</svelte:head>

<a class="back label" href="/">← drop board</a>

<header class="drop">
	<div class="drop__art">
		<Artwork
			title={project.title}
			artistName={project.artistName}
			url={project.artworkUrl}
			status={project.artworkStatus}
		/>
	</div>
	<div class="drop__id">
		<h1 class="display drop__title">{project.title}</h1>
		<p class="drop__artist label">by {project.artistName}</p>
		<StatusChip state={chipState} />
	</div>
</header>

{#if view === 'slab' && claim}
	<div class="slab-focus" bind:this={slabBox} tabindex="-1" role="region" aria-label="your claim">
		<CodeSlab
			code={claim.code}
			kind={claim.kind}
			codeStatus={claim.codeStatus}
			claimedAt={claim.claimedAt}
			reissuedAt={claim.reissuedAt}
			yumUrl={project.yumUrl}
			artistName={project.artistName}
			{reveal}
			line={slabLine}
			notice={slabNotice}
			onreport={claim.codeStatus === 'claimed' && claim.kind === 'original' ? reportDeadCode : null}
		>
			{#snippet meta()}
				<span class="slab-counts label">{project.claimed} of {project.total} codes claimed</span>
			{/snippet}
		</CodeSlab>
	</div>
{:else if view === 'paused'}
	<Panel label="drop status" sublabel="{project.total} codes · held" tone="caution" tag="保留中">
		<!-- The hold copy LEADS (refine #6): "held, not gone" frames the caution
		     readout before it appears — the orange stays held-orange, never danger -->
		<p class="state-copy state-copy--lead">
			This launch is on hold — {project.artistName} paused the drop. The pool is held, not gone:
			every count below is waiting.
		</p>
		<div class="drop-data">
			<SevenSegmentCount
				value={project.available}
				pad={3}
				label="codes held in the pool"
				size="lg"
				tone="orange"
			/>
			<SegmentedMeter
				available={project.available}
				total={project.total}
				state="paused"
				label="{project.title}: codes held"
			/>
		</div>
		<div class="hold-next">
			<GhostAction href="/">back to the drop board</GhostAction>
			{#if project.albumUrl}
				<a class="hold-bandcamp" href={project.albumUrl} target="_blank" rel="noopener noreferrer">
					hear {project.title} on Bandcamp
				</a>
			{/if}
		</div>
		<p class="state-copy state-copy--hold">
			Leave the console light on for this one — check back any time. The moment {project.artistName}
			resumes, this page is a live drop again.
		</p>
	</Panel>
{:else if view === 'drained'}
	<Panel label="drop status" sublabel="{project.total} codes · all claimed" tone="alarm" tag="完売">
		<div class="drop-data">
			<SevenSegmentCount value={0} pad={3} label="codes remaining" size="lg" tone="red" />
			<SegmentedMeter
				available={0}
				total={project.total}
				state="drained"
				label="{project.title}: codes available"
			/>
		</div>
		<p class="state-copy">
			All {project.total} codes from this drop are claimed — every one found a fan. {project.artistName}
			sees these counts and can launch the next batch any time.
		</p>
		{#if project.albumUrl}
			<p class="state-copy">
				<a href={project.albumUrl} target="_blank" rel="noopener noreferrer">
					follow {project.artistName} on Bandcamp
				</a>
				for the next drop.
			</p>
		{/if}
		<div class="hazard drained-band" aria-hidden="true"></div>
	</Panel>
{:else}
	{#snippet launchFoot()}
		<div class="launch-foot">
			<PrimaryAction onclick={launchClaim}>launch claim</PrimaryAction>
			<span class="launch-meta label">one code per fan · one replacement if it is dead</span>
		</div>
	{/snippet}
	<Panel label="drop status" sublabel="{project.total} codes" tone={panelTone} tag="ドロップセル" footer={step === 'idle' ? launchFoot : null}>
		<div class="drop-data">
			<SevenSegmentCount
				value={project.available}
				pad={3}
				label="codes remaining"
				size="lg"
				tone={countTone}
			/>
			<SegmentedMeter
				available={project.available}
				total={project.total}
				state={meterState}
				label="{project.title}: codes available"
			/>
			<span class="claimed-line label">{project.claimed} claimed</span>
		</div>

		{#if step === 'idle'}
			{#if consoleNote}
				<p class="console-note" role="alert">{consoleNote}</p>
			{/if}
		<p class="launch-copy launch-copy--what">A code is a free download of this release — one per fan.</p>
		<p class="launch-copy">
			{#if data.fanHasSession}
				This browser is already verified — launching claims your code directly.
			{:else}
				Verified once by email — then straight to Bandcamp's redeem page.
			{/if}
		</p>
		{:else if step === 'email'}
			<div class="entry" bind:this={stepBox}>
				<p class="entry-copy">Where should the code's key be sent? One 6-digit email code verifies
					this browser — then the drop is one tap away, every time.</p>
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
				<p class="entry-copy">Enter the 6-digit code from the email — verifying claims your code
					from the live pool.</p>
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
						{otpBusy ? 'verifying…' : 'verify + claim'}
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
		{:else if step === 'launching'}
			<p class="launching" role="status">
				<span class="launching__lamp" aria-hidden="true"></span>
				dispensing — picking one random code from the pool…
			</p>
		{/if}
	</Panel>
{/if}

<style>
	.back {
		display: inline-block;
		color: var(--text-muted);
		text-decoration: none;
		border-bottom: 1px solid var(--hairline);
		padding-bottom: 2px;
		transition:
			color 140ms ease-out,
			border-color 140ms ease-out;
	}

	.back:hover {
		color: var(--orange-bright);
		border-color: var(--orange);
	}

	/* --- header: artwork-led identity ----------------------------------------- */
	.drop {
		display: grid;
		grid-template-columns: 160px minmax(0, 1fr);
		gap: var(--gap-4);
		align-items: start;
		margin-bottom: var(--gap-6);
	}

	.drop__art {
		width: 100%;
	}

	.drop__id {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--gap-2);
		min-width: 0;
	}

	.drop__title {
		font-size: clamp(var(--step-3), 7vw, var(--step-5));
		overflow-wrap: anywhere;
	}

	.drop__artist {
		color: var(--text-muted);
	}

	/* --- shared state copy ------------------------------------------------------ */
	.state-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	/* the paused hold's state line LEADS the panel — same weight register as
	   the launch view's what-a-code line and the standby board's what-this-is */
	.state-copy--lead {
		font-weight: 520;
	}

	/* the paused hold's way forward: one ghost control + one honest exit */
	.hold-next {
		display: flex;
		align-items: center;
		gap: var(--gap-3);
		flex-wrap: wrap;
	}

	.hold-bandcamp {
		font-size: var(--step--1);
	}

	.state-copy--hold {
		color: var(--text-muted);
	}

	.drained-band {
		height: 4px;
		opacity: 0.85;
	}

	/* --- launch console ---------------------------------------------------------- */
	/* count + meter: ONE instrument in every state view (the board cell's own
	   grammar, refine #2) — the count's well hugs its zero-padded digits while
	   the meter spans the panel width beneath it, shared left edge. The well
	   never stretches: a full-width readout strands dead space right of the
	   digits (the paused-hold defect refine #6 closes). */
	.drop-data {
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
		align-items: flex-start;
	}

	.drop-data :global(.meter) {
		align-self: stretch;
	}

	.claimed-line {
		color: var(--text-muted);
	}

	.launch-copy,
	.entry-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	/* the first-run anchor: what a code IS leads, the flow line follows */
	.launch-copy--what {
		font-weight: 520;
	}

	.console-note {
		border: 1px solid var(--hairline-alarm);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
		max-width: var(--measure);
	}

	.launch-foot {
		display: flex;
		align-items: center;
		gap: var(--gap-3);
		flex-wrap: wrap;
		width: 100%;
	}

	.launch-meta {
		color: var(--text-muted);
	}

	/* --- entry steps (command-entry console) ------------------------------------- */
	.entry {
		display: flex;
		flex-direction: column;
		gap: var(--gap-4);
		border-top: 1px solid var(--hairline-dim);
		padding-top: var(--gap-4);
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

	/* --- dispensing state ---------------------------------------------------------- */
	.launching {
		display: flex;
		align-items: center;
		gap: var(--gap-2);
		border-top: 1px solid var(--hairline-dim);
		padding-top: var(--gap-4);
		color: var(--text);
	}

	/* the dispensing lamp: a drawn indicator square, not a glyph */
	.launching__lamp {
		width: 0.7em;
		height: 0.7em;
		flex: none;
		background: var(--green);
		box-shadow: var(--glow-green);
	}

	@media (prefers-reduced-motion: no-preference) {
		.launching__lamp {
			animation: launching-tick 0.9s steps(2, jump-none) infinite;
		}

		@keyframes launching-tick {
			to {
				opacity: 0.25;
			}
		}
	}

	/* --- slab arrival ---------------------------------------------------------------- */
	.slab-focus {
		outline: none;
	}

	.slab-counts {
		color: var(--text-muted);
		margin-inline-start: auto;
		white-space: nowrap;
	}

	@media (min-width: 768px) {
		.drop {
			grid-template-columns: 240px minmax(0, 1fr);
			gap: var(--gap-5);
		}

		.drop__title {
			font-size: clamp(var(--step-4), 5vw, var(--step-6));
		}
	}
</style>
