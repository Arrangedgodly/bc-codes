<script lang="ts">
	import { Panel, PrimaryAction, StatusChip } from '$lib/components';
	import type { Snippet } from 'svelte';

	/**
	 * CodeSlab — THE product moment: the dispensed code as the biggest object
	 * the site ever shows (design brief: "monumental seven-segment-style slab").
	 *
	 * Layers, in reading order:
	 *   1. The display well — the code on the seven-segment face (DSEG7 has
	 *      real lowercase glyphs — verified against the shipped woff2 cmap), a
	 *      dim all-segments GHOST underneath (unlit segments, the way a real
	 *      readout looks before power), phosphor green + glow: claimed-yours is
	 *      nominal green (alarm red only when the code is dead/reported).
	 *      The display layer is aria-hidden: 7-seg letter approximations are an
	 *      aesthetic, not a reading surface.
	 *   2. The code string — high-contrast Martian Mono, SELECTABLE (that is
	 *      the manual-copy fallback: user-select: all, one tap selects), and
	 *      aria-labelled with the code SPELLED OUT so screen readers read
	 *      characters, not a run-together word.
	 *   3. Actions — COPY (clipboard API with select-the-text fallback; never a
	 *      dead end if the clipboard is blocked) and REDEEM ON BANDCAMP (the
	 *      R3-verified deep-link `<yum>?code={code}`, a real link, new tab,
	 *      noopener — built CLIENT-side only; no server code ever touches it).
	 *      The label is plain language at the payoff: redeem names the act,
	 *      Bandcamp names the place, and "code pre-filled" is what the deep
	 *      link actually does. One quiet explainer line under the actions says
	 *      what redeeming GETS the fan (album in their Bandcamp library) —
	 *      first-run comprehension rides here, not on jargon.
	 *   4. The report affordance — inline confirm (no modal), delegated to the
	 *      page's onreport; outcomes re-render the slab through props.
	 *
	 * The reveal: on a FRESH claim or reissue only (`reveal`), the characters
	 * power on one hard tick at a time — steps() per character over the ghost,
	 * then the mono layer and actions settle in (expo ease-out). Everything is
	 * gated behind prefers-reduced-motion; an SSR revisit renders settled
	 * (re-shown, not re-claimed — the launch moment belongs to the launch).
	 */

	let {
		code,
		kind,
		codeStatus,
		claimedAt,
		reissuedAt = null,
		yumUrl = null,
		artistName = '',
		reveal = false,
		line = '',
		notice = '',
		onreport = null,
		meta = null
	}: {
		/** The dispensed `xxxx-xxxx` code string — the payload. */
		code: string;
		kind: 'original' | 'reissue';
		/** 'claimed' = live code · 'reported' = the fan reported it dead. */
		codeStatus: 'claimed' | 'reported';
		/** SQL-UTC 'YYYY-MM-DD HH:MM:SS' — first dispense. */
		claimedAt: string;
		/** SQL-UTC — set when the single reissue happened (else null). */
		reissuedAt?: string | null;
		/** Redeem console base (`https://<artist>.bandcamp.com/yum`); null = copy-only honesty. */
		yumUrl?: string | null;
		artistName?: string;
		/** Play the steps() power-on (fresh claim/reissue only — SSR re-visits stay settled). */
		reveal?: boolean;
		/** The warm context line (page supplies fresh/revisit/replacement copy). */
		line?: string;
		/** One-line transient feedback from the page (e.g. already-reissued). */
		notice?: string;
		/** Report-dead-code delegate: performs the POST, returns its outcome. */
		onreport?: (() => Promise<'reissued' | 'reissue_drained' | 'already_reissued' | 'error'>) | null;
		/** Optional extra footer content (e.g. the page's real pool counts). */
		meta?: Snippet | null;
	} = $props();

	const dead = $derived(codeStatus === 'reported');
	const reportedLive = $derived(!dead && kind === 'reissue');

	/** Ghost: every alphanumeric becomes the all-segments glyph; dash stays. */
	const ghost = $derived(code.replace(/[a-z0-9]/gi, '8'));
	const chars = $derived([...code]);
	/** Spelled out for screen readers — dash as a word, letters separated. */
	const spelled = $derived(
		`Your download code, spelled out: ${chars.map((c) => (c === '-' ? 'dash' : c)).join(', ')}`
	);
	const redeemUrl = $derived(
		yumUrl && !dead ? `${yumUrl}?code=${encodeURIComponent(code)}` : null
	);

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
	const sublabel = $derived(
		kind === 'reissue'
			? `replacement · ${formatDate(reissuedAt) || formatDate(claimedAt)}`
			: `claimed ${formatDate(claimedAt)}`.trim()
	);

	const warmLine = $derived(
		line ??
		(dead
			? 'You reported this code dead — it is kept here for your records. No code remains in this pool to replace it.'
			: reportedLive
				? 'Your replacement code — one random pick from what remained.'
				: `One random code from ${artistName}'s batch. It is yours.`)
	);

	// --- copy: clipboard API first, select-the-text fallback always ----------
	let copyState = $state<'idle' | 'copied' | 'selected'>('idle');
	let copyNoteTimer: ReturnType<typeof setTimeout> | undefined;
	let codeEl: HTMLParagraphElement | undefined;
	$effect(() => () => clearTimeout(copyNoteTimer));

	async function copyCode() {
		clearTimeout(copyNoteTimer);
		let copied = false;
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			try {
				await navigator.clipboard.writeText(code);
				copied = true;
			} catch {
				copied = false; // permission denied / not allowed — fall through
			}
		}
		if (copied) {
			copyState = 'copied';
		} else if (codeEl && typeof document !== 'undefined') {
			// Manual-select fallback: the slab text itself is the affordance.
			const range = document.createRange();
			range.selectNodeContents(codeEl);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			copyState = 'selected';
		}
		copyNoteTimer = setTimeout(() => (copyState = 'idle'), 4000);
	}

	// --- report: inline confirm, delegated POST --------------------------------
	let reportView = $state<'idle' | 'confirm'>('idle');
	let reportSending = $state(false);
	async function sendReport() {
		if (!onreport || reportSending) return;
		reportSending = true;
		try {
			await onreport();
		} finally {
			reportSending = false; // outcomes arrive as new props (claim re-render)
			reportView = 'idle';
		}
	}
</script>

<div class="slab" class:slab--reveal={reveal} class:slab--dead={dead}>
	<Panel
		label={dead ? 'your code — reported' : 'your code'}
		{sublabel}
		tone={dead ? 'alarm' : 'nominal'}
		tag="あなたのコード"
	>
		<p class="slab__line">{warmLine}</p>

		<div class="slab__well">
			<span class="slab__readout" aria-hidden="true" style="--char-count: {chars.length}">
				<span class="slab__ghost">{ghost}</span>
				<span class="slab__display">
					{#each chars as ch, i (i)}
						<span class="slab__char" style="--i: {i}">{ch}</span>
					{/each}
				</span>
			</span>
			<p class="slab__code slab__after" bind:this={codeEl} aria-label={spelled}>{code}</p>
			<span class="slab__select-hint slab__after label">
				<span class="slab__hint-fine">click the code to select it</span>
				<span class="slab__hint-coarse">tap the code to select it</span>
			</span>
		</div>

		<div class="slab__after slab__actions">
			<button class="slab__copy" type="button" onclick={copyCode}>
				{copyState === 'copied' ? 'copied' : copyState === 'selected' ? 'code selected' : 'copy code'}
			</button>
			{#if redeemUrl}
				<PrimaryAction
					class="slab__redeem"
					href={redeemUrl}
					target="_blank"
					rel="noopener noreferrer"
				>
					redeem on bandcamp — code pre-filled
				</PrimaryAction>
			{:else if dead}
				<span class="slab__none label">redeem disabled — this code is dead</span>
			{:else}
				<span class="slab__none label">no direct redeem link for this drop — copy the code and redeem it on the artist's Bandcamp page</span>
			{/if}
		</div>

		{#if redeemUrl}
			<p class="slab__after slab__redeem-note">
				Redeeming adds this album to your Bandcamp library — free to download or stream, whenever you like.
			</p>
		{/if}

		<p class="slab__copy-note label" role="status">
			{#if copyState === 'copied'}
				code copied to your clipboard — paste it into Bandcamp's redeem page
			{:else if copyState === 'selected'}
				code selected — press Cmd/Ctrl + C to copy it
			{/if}
		</p>

		{#if notice}
			<p class="slab__notice" role="status">{notice}</p>
		{/if}

		{#snippet footer()}
			<div class="slab__foot">
				<StatusChip state={dead ? 'reported' : 'claimed'} />
				{#if !dead && kind === 'original' && onreport}
					{#if reportView === 'idle'}
						<button class="slab__report-link" type="button" onclick={() => (reportView = 'confirm')}>
							code didn't work? report it
						</button>
					{:else if reportView === 'confirm'}
						<span class="slab__confirm">
							<span class="slab__confirm-copy">
								report <strong class="slab__confirm-code">{code}</strong> as already redeemed?
								the artist sees the report — you get one replacement if any codes remain.
							</span>
							<span class="slab__confirm-row">
								<button class="slab__report-go" type="button" onclick={sendReport} disabled={reportSending}>
									{reportSending ? 'sending…' : 'report it'}
								</button>
								<button class="slab__report-keep" type="button" onclick={() => (reportView = 'idle')} disabled={reportSending}>
									keep this code
								</button>
							</span>
						</span>
					{/if}
				{:else if reportedLive}
					<span class="label">your one replacement was already issued</span>
				{/if}
				{#if meta}
					{@render meta()}
				{/if}
			</div>
		{/snippet}
	</Panel>
</div>

<style>
	.slab__line {
		color: var(--text);
		max-width: var(--measure);
	}

	/* --- the well: the monumental readout ---------------------------------- */
	.slab__well {
		container-type: inline-size;
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--gap-3);
		padding: clamp(1.25rem, 4cqw, 2.75rem) clamp(0.75rem, 3cqw, 2.5rem);
		background: var(--panel-inset);
		border: 1px solid var(--hairline-green);
		overflow: hidden;
	}

	.slab__readout {
		position: relative;
		display: inline-flex;
		font-family: var(--font-seg);
		font-weight: 700;
		/* DSEG7 is monospaced at exactly 0.816em advance (verified against the
		   shipped woff2 hmtx) + 0.12em tracking = 0.936em per glyph; the run
		   sizes to ~92% of the well width at EVERY code length: monumental at
		   every breakpoint, structurally unable to overflow. */
		font-size: clamp(2rem, calc(92cqw / 0.936 / var(--char-count, 9)), 10rem);
		line-height: 1.05;
		letter-spacing: 0.12em;
		white-space: nowrap;
		font-kerning: none;
	}

	.slab__display {
		color: var(--green);
		text-shadow: var(--glow-green);
	}

	/* the unlit segments: every cell faintly aglow before (and under) the code */
	.slab__ghost {
		position: absolute;
		inset: 0;
		color: rgba(57, 211, 83, 0.085);
		text-shadow: none;
	}

	.slab__char {
		display: inline-block;
	}

	.slab__code {
		font-family: var(--font-mono);
		/* the reading layer rides the ramp (emphasis floor → 2.5rem step),
		   scaling with the well the way the DSEG7 run above it does */
		font-size: clamp(var(--step-1), 4.4cqw, var(--step-4));
		font-weight: 640;
		letter-spacing: 0.3em;
		translate: 0.15em 0; /* re-center: tracking hangs one gap past the last glyph */
		color: var(--text);
		overflow-wrap: anywhere;
		-webkit-user-select: all;
		user-select: all;
	}

	.slab__select-hint {
		color: var(--text-muted);
	}

	/* pointer-honest wording: the gesture named matches the primary input */
	.slab__hint-coarse {
		display: none;
	}

	@media (pointer: coarse) {
		.slab__hint-fine {
			display: none;
		}

		.slab__hint-coarse {
			display: inline;
		}
	}

	/* --- dead code: the readout goes to alarm ------------------------------- */
	.slab--dead .slab__well {
		border-color: var(--hairline-alarm);
	}

	.slab--dead .slab__display {
		color: var(--alarm-bright);
		text-shadow: var(--glow-alarm);
	}

	.slab--dead .slab__ghost {
		color: rgba(232, 16, 42, 0.09);
	}

	/* --- actions ------------------------------------------------------------- */
	.slab__actions {
		display: flex;
		align-items: stretch;
		justify-content: center;
		gap: var(--gap-3);
		flex-wrap: wrap;
	}

	/* the secondary console button: hairline well, mono caps, phosphor on hover */
	.slab__copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 3.5rem;
		padding: 0.55rem 1.4rem;
		background: var(--panel-inset);
		border: 1px solid var(--hairline);
		color: var(--text);
		font-family: var(--font-mono);
		font-size: var(--step--1);
		font-weight: 560;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		cursor: pointer;
		transition:
			border-color 140ms ease-out,
			color 140ms ease-out,
			box-shadow 140ms ease-out;
	}

	.slab__copy:hover {
		border-color: var(--orange);
		color: var(--orange-bright);
	}

	.slab__copy:focus-visible {
		outline: none;
		border-color: var(--orange);
		box-shadow: var(--glow-orange);
	}

	/* class lands inside PrimaryAction's root — reach it globally */
	:global(.slab__redeem) {
		min-width: min(100%, 18rem);
	}

	.slab__none {
		align-self: center;
		max-width: 40ch;
		color: var(--text-muted);
	}

	/* the one-line plain-language anchor under the actions: what redeeming
	   gets the fan. Quiet on purpose — the label carries the action. */
	.slab__redeem-note {
		max-width: var(--measure);
		color: var(--text-muted);
		text-align: center;
		font-size: var(--step--1);
	}

	.slab__copy-note {
		min-height: 1.2em;
		color: var(--green);
		text-align: center;
	}

	.slab__notice {
		border: 1px solid var(--hairline-dim);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
	}

	/* --- footer: status + report --------------------------------------------- */
	.slab__foot {
		display: flex;
		align-items: center;
		gap: var(--gap-3);
		flex-wrap: wrap;
	}

	.slab__report-link {
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

	.slab__report-link:hover {
		color: var(--alarm-bright);
	}

	.slab__report-link:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: 3px;
	}

	.slab__confirm {
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
		flex: 1 1 32ch;
		min-width: 0;
	}

	.slab__confirm-copy {
		font-size: var(--step--1);
		color: var(--text);
		max-width: 60ch;
	}

	.slab__confirm-code {
		font-family: var(--font-mono);
		color: var(--alarm-bright);
		font-weight: 640;
		letter-spacing: 0.08em;
	}

	.slab__confirm-row {
		display: flex;
		gap: var(--gap-2);
		flex-wrap: wrap;
	}

	.slab__report-go,
	.slab__report-keep {
		min-height: 2.75rem;
		padding: 0.4rem 1rem;
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 560;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		cursor: pointer;
	}

	.slab__report-go {
		background: var(--alarm);
		border: 1px solid var(--alarm-bright);
		color: var(--ink); /* large-text-equivalent weight on red: chip fill grammar */
	}

	.slab__report-go:hover {
		background: var(--alarm-bright);
	}

	.slab__report-go:focus-visible {
		outline: 2px solid var(--alarm-bright);
		outline-offset: 3px;
	}

	.slab__report-keep {
		background: var(--panel-inset);
		border: 1px solid var(--hairline);
		color: var(--text);
	}

	.slab__report-keep:hover {
		border-color: var(--orange);
	}

	/* --- the launch moment: steps() power-on, reduced-motion gated ----------- */
	@media (prefers-reduced-motion: no-preference) {
		.slab--reveal .slab__char {
			opacity: 0;
			animation: slab-char-on 1ms steps(1, end) forwards;
			animation-delay: calc(240ms + var(--i) * 110ms);
		}

		.slab--reveal .slab__well {
			animation: slab-well-bloom 1.7s cubic-bezier(0.16, 1, 0.3, 1) both;
		}

		.slab--reveal .slab__after {
			opacity: 0;
			animation: slab-after-on 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
			animation-delay: 1.35s;
		}

		@keyframes slab-char-on {
			to {
				opacity: 1;
			}
		}

		/* the phosphor breathes once as the readout powers on, then rests */
		@keyframes slab-well-bloom {
			0% {
				box-shadow: none;
			}
			35% {
				box-shadow:
					0 0 42px rgba(57, 211, 83, 0.28),
					0 0 4px rgba(57, 211, 83, 0.5);
			}
			100% {
				box-shadow: var(--glow-green);
			}
		}

		@keyframes slab-after-on {
			from {
				opacity: 0;
				transform: translateY(6px);
			}
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}
	}
</style>
