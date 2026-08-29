<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import antonWoff2 from '$lib/fonts/Anton-latin.woff2?url';
	import martianWoff2 from '$lib/fonts/MartianMono-latin-var.woff2?url';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { ConsoleFrame } from '$lib/components';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	// The direction contract, emitted as the first markup of every page.
	// {@html} guarantees the comment survives Svelte's compiler (template
	// comments are stripped by default); verify with: grep ac07c5ea in build output.
	const DIRECTION_CONTRACT = `<!--
	FE1 DIRECTION CONTRACT — Crisis Wall · bc-codes
	THESIS: bc-codes is a drop console, not a storefront: every project a live
	drop-cell on one command wall; the dispensed code is the countdown in
	reverse. Refuses the card-grid coupon tool.
	OWN-WORLD: absolute black; phosphor orange structure, alarm red drained-only,
	nominal green available; Anton condensed caps, Martian Mono labels, DSEG7
	counts; hairline panels, corner brackets, segmented meters, hazard bands,
	scanlines; flat + glow.
	STORY: visitor reads real availability at a glance, launches a claim,
	receives one monumental code, lands on Bandcamp; every number is a real
	pool count.
	FIRST VIEWPORT: one console frame; header rail + hazard band; drop-cells as
	panels with artwork payload, meters, seven-segment remaining counts;
	primary action orange, lower right.
	FORM: user-chosen challenger (crisis-wall) over rolled ledger; seed ac07c5ea.
	FINISH: unreviewed and undocumented is unfinished; this build ends with the
	finish review, the verdict, DESIGN.md, and every shipping raster carrying
	its provenance
-->`;

	// FE5: the rail is surface-aware — artist console pages carry the artist
	// nav (dashboard / new drop / identity / sign-out), everything else the
	// fan nav. Exact-prefix match so a hypothetical /consoleX stays fan-side.
	const onConsole = $derived(
		page.url.pathname === '/console' || page.url.pathname.startsWith('/console/')
	);

	let signingOut = $state(false);

	async function signOut() {
		signingOut = true;
		try {
			await fetch('/api/artist/sign-out', { method: 'POST' });
		} catch {
			// Sign-out is idempotent server-side; even a failed call is followed
			// by a navigation that re-runs the layout load and tells the truth.
		}
		// Navigate FIRST, then invalidate: invalidating while still on a console
		// page would fire that page's route gate (a redirect to sign-in with a
		// returnTo). After the goto, the invalidation re-runs the root layout
		// load so the rail drops the identity the moment the session is gone.
		await goto('/console/sign-in');
		await invalidateAll();
		signingOut = false;
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" href={antonWoff2} />
	<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" href={martianWoff2} />
</svelte:head>

{@html DIRECTION_CONTRACT}

<ConsoleFrame>
	{#snippet rail()}
		<!--
			Header rail nav — surface-aware (FE5). Fan surfaces keep the fan nav
			(the FE4 "my codes" link plus the artist-console entry, so an artist
			can always find their console); /console surfaces carry the artist
			nav: dashboard, new drop, and — when a session exists — the signed-in
			identity + sign-out. Wordmark remains the brand.ts config string.
		-->
		{#if onConsole}
			<nav class="rail-nav" aria-label="Artist console">
				<a class="rail-nav__link" href="/console">console</a>
				<a class="rail-nav__link" href="/console/new">new drop</a>
				{#if data.artistEmail}
					<span class="rail-nav__who" title={data.artistEmail}>{data.artistEmail}</span>
					<button class="rail-nav__out" type="button" onclick={signOut} disabled={signingOut}>
						{signingOut ? 'signing out…' : 'sign out'}
					</button>
				{/if}
			</nav>
		{:else}
			<nav class="rail-nav" aria-label="Fan console">
				<a class="rail-nav__link" href="/my-codes">my codes</a>
				<a class="rail-nav__link" href="/console">artist console</a>
			</nav>
		{/if}
	{/snippet}
	{@render children()}
</ConsoleFrame>

<style>
	.rail-nav {
		display: flex;
		align-items: baseline;
		gap: var(--gap-4);
		flex-wrap: wrap;
	}

	.rail-nav__link {
		font-family: var(--font-mono);
		font-size: var(--step--1);
		font-weight: 520;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--orange);
		text-decoration: none;
		border-bottom: 1px solid var(--hairline);
		padding-bottom: 2px;
		transition:
			color 140ms ease-out,
			border-color 140ms ease-out;
	}

	.rail-nav__link:hover {
		color: var(--orange-bright);
		border-color: var(--orange);
	}

	/* signed-in identity: data, not a link — long addresses fade, never reflow */
	.rail-nav__who {
		max-width: 22ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--step--2);
		letter-spacing: 0.06em;
		color: var(--text-muted);
	}

	.rail-nav__out {
		background: none;
		border: none;
		padding: 0 0 2px;
		border-bottom: 1px solid var(--hairline);
		color: var(--orange);
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 460;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		cursor: pointer;
		transition:
			color 140ms ease-out,
			border-color 140ms ease-out;
	}

	.rail-nav__out:hover:not(:disabled) {
		color: var(--orange-bright);
		border-color: var(--orange);
	}

	.rail-nav__out:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: 3px;
	}

	.rail-nav__out:disabled {
		color: var(--text-muted);
		cursor: wait;
	}
</style>
