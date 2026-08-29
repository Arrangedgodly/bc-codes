<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { LabeledField, Panel, PrimaryAction } from '$lib/components';
	import { APP_NAME } from '$lib/brand';
	import { postConsoleJson } from '$lib/console-client';
	import type { PageData } from './$types';

	/**
	 * FE5 — artist console sign-in: email → 6-digit OTP, the same
	 * command-entry grammar the fan flow uses (FE3's launch console), wired
	 * to BE3's artist endpoints. Every refusal is named honestly with its
	 * recovery: wrong code, expired, locked (5 tries void the code), pacing
	 * cooldowns, mail capacity. The resend gate counts the SERVER's seconds
	 * — readiness is never fabricated.
	 *
	 * Enumeration-safe by construction below (BE3): request answers the same
	 * 200 for any well-formed address, so this UI never learns or implies
	 * whether an account exists — first sign-in IS account creation.
	 */

	let { data }: { data: PageData } = $props();

	type Step = 'email' | 'otp' | 'entering';
	let step: Step = $state('email');
	let email = $state('');
	let otp = $state('');
	let emailError = $state('');
	let otpError = $state('');
	let emailBusy = $state(false);
	let otpBusy = $state(false);
	/** transient OTP-step note (sends, resends, cooldowns). */
	let otpNote = $state('');
	/** OTP resend gate — server-provided seconds, counted down at 1 Hz. */
	let resendAt = $state<number | null>(null);
	let tick = $state(0);

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

	// Focus lands in the command line the moment a step renders.
	let stepBox = $state<HTMLDivElement | undefined>(undefined);
	$effect(() => {
		if (step === 'email' || step === 'otp') {
			requestAnimationFrame(() => stepBox?.querySelector<HTMLInputElement>('input')?.focus());
		}
	});

	async function submitEmail(event: SubmitEvent) {
		event.preventDefault();
		emailError = '';
		if (email.trim().length === 0) {
			emailError = 'Enter the email this console should trust — the code is sent there.';
			return;
		}
		emailBusy = true;
		const { res, body } = await postConsoleJson('/api/artist/request-otp', { email });
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
			case 'otp_pending_exhausted':
				step = 'otp';
				startCooldown(body?.retryAfterSeconds ?? 600);
				otpNote = `Three codes were already sent to ${email.trim()} — the next one unlocks when the current code expires (${resendLabel}).`;
				break;
			case 'rate_limited':
				emailError = `Too many codes sent from this network — the console cools down for ${body?.retryAfterSeconds ?? 60}s.`;
				break;
			case 'email_throttled':
				emailError = 'The mail system is at capacity right now — try again in a few minutes.';
				break;
			case 'email_send_failed':
				emailError = 'The send failed on our side — wait a moment and try again.';
				break;
			default:
				emailError = 'The send failed — wait a moment and try again.';
		}
	}

	async function submitOtp(event: SubmitEvent) {
		event.preventDefault();
		otpError = '';
		// Digits only (inputmode + maxlength guide; the console trusts nothing).
		const code = otp.replace(/\D/g, '').slice(0, 6);
		if (code.length < 6) {
			otpError = 'Enter the 6-digit code from the email.';
			return;
		}
		otpBusy = true;
		const { res, body } = await postConsoleJson('/api/artist/verify-otp', { email: email.trim(), code });
		otpBusy = false;
		if (res.ok) {
			step = 'entering';
			otpNote = 'Verified — opening your console…';
			// A client-side navigation does NOT re-run the root layout's
			// server load (cookies/platform are not tracked dependencies),
			// so the rail would keep its signed-out snapshot until a full
			// page load. Explicit invalidation after the goto re-runs it and
			// the rail picks up the session (identity + sign-out) — the same
			// goto-then-invalidate pattern signOut uses, in reverse.
			await goto(data.returnTo);
			await invalidateAll();
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
		const { res, body } = await postConsoleJson('/api/artist/request-otp', { email: email.trim() });
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
</script>

<svelte:head>
	<title>Artist sign-in · {APP_NAME}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<a class="back label" href="/">← drop board</a>

<h1 class="display page-title">Artist access</h1>
<p class="page-sub label">the console verifies by email · no passwords anywhere</p>

<Panel label="console entry" sublabel="email + code" tone="default" tag="認証">
	{#if step === 'email'}
		<div class="entry" bind:this={stepBox}>
			<p class="entry-copy">
				Enter the email this console should trust. A 6-digit code proves it is you —
				the same verification the fans get, and accounts are created on first sign-in.
			</p>
			<form class="entry-form" onsubmit={submitEmail} novalidate>
				<LabeledField
					label="your email"
					hint="artist addresses are stored for sign-in — fan emails never are"
					error={emailError}
					bind:value={email}
					type="email"
					name="email"
					autocomplete="email"
					inputmode="email"
					placeholder="you@yourlabel.com"
				/>
				<PrimaryAction class="sign-submit" type="submit" disabled={emailBusy}>
					{emailBusy ? 'sending…' : 'send my code'}
				</PrimaryAction>
			</form>
			<p class="entry-after label">first sign-in creates the account</p>
		</div>
	{:else if step === 'otp'}
		<div class="entry" bind:this={stepBox}>
			<p class="entry-copy">Enter the 6-digit code from the email — verifying opens your console.</p>
			<form class="entry-form" id="sign-otp" onsubmit={submitOtp} novalidate>
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
				<PrimaryAction class="sign-submit" type="submit" disabled={otpBusy}>
					{otpBusy ? 'verifying…' : 'verify + enter'}
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
				<button class="change-link" type="button" onclick={() => ((step = 'email'), (otp = ''), (otpNote = ''))}>
					use a different email
				</button>
			</div>
		</div>
	{:else if step === 'entering'}
	<p class="entering" role="status">
		<span class="entering__lamp" aria-hidden="true"></span>
		verified — opening your console…
	</p>
	{/if}
</Panel>

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

	.page-title {
		font-size: clamp(var(--step-4), 8vw, var(--step-6));
		margin-bottom: var(--gap-2);
	}

	.page-sub {
		margin-bottom: var(--gap-6);
	}

	/* --- command-entry steps (FE3's launch-console grammar) ------------------- */
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

	/* the OTP command line: tracked + centered like a readout entry */
	.otp-wrap :global(input) {
		text-align: center;
		letter-spacing: 0.6em;
		text-indent: 0.6em;
		font-weight: 620;
	}

	:global(.sign-submit) {
		min-width: min(100%, 12rem);
	}

	.entry-after {
		color: var(--text-muted);
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

	/* --- entering state --------------------------------------------------------- */
	.entering {
		display: flex;
		align-items: center;
		gap: var(--gap-2);
		color: var(--text);
	}

	.entering__lamp {
		width: 0.7em;
		height: 0.7em;
		flex: none;
		background: var(--green);
		box-shadow: var(--glow-green);
	}

	@media (prefers-reduced-motion: no-preference) {
		.entering__lamp {
			animation: entering-tick 0.9s steps(2, jump-none) infinite;
		}

		@keyframes entering-tick {
			to {
				opacity: 0.25;
			}
		}
	}
</style>
