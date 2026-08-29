<script lang="ts">
	import type { Snippet } from 'svelte';
	import { APP_NAME, APP_TAGLINE, APP_TAGLINE_JP } from '$lib/brand';

	/**
	 * ConsoleFrame — the continuous outer frame every page lives inside.
	 * Hazard band + header rail + corner brackets; one world, every route.
	 *
	 * Props:
	 *   rail   — snippet rendered in the header rail's right bay (nav, status)
	 *   children — page content, laid out inside the frame
	 *   framed — when false, drops the outer border/brackets (kept for full-bleed
	 *            surfaces like the FE3 code slab, which still shows the rail)
	 */
	let {
		rail = null,
		framed = true,
		children
	}: {
		rail?: Snippet | null;
		framed?: boolean;
		children: Snippet;
	} = $props();
</script>

<div class="console" class:console--framed={framed}>
	<div class="console__hazard hazard" aria-hidden="true"></div>

	<header class="console__rail">
		<div class="console__ident">
			<span class="console__name">{APP_NAME}</span>
			<span class="console__tag">{APP_TAGLINE}</span>
			<!-- bilingual micro-label: decorative only -->
			<span class="console__tag-jp micro" aria-hidden="true">{APP_TAGLINE_JP}</span>
		</div>
		{#if rail}
			<div class="console__rail-bay">
				{@render rail()}
			</div>
		{/if}
	</header>

	<main class="console__body">
		{@render children()}
	</main>
</div>

<style>
	.console {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		padding: 0 clamp(0.75rem, 2.5vw, 2rem) var(--gap-6);
	}

	.console--framed {
		border-left: 1px solid var(--hairline-dim);
		border-right: 1px solid var(--hairline-dim);
		border-bottom: 1px solid var(--hairline-dim);
	}

	/* The hazard band crowning the frame — structural, dim orange.
	   Class `hazard` supplies the chevrons (app.css material). */
	.console__hazard {
		height: 6px;
		opacity: 0.5;
		border-block: 1px solid var(--hairline);
	}

	.console__rail {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--gap-4);
		flex-wrap: wrap;
		padding-block: var(--gap-4);
		border-bottom: 1px solid var(--hairline-dim);
	}

	.console__ident {
		display: flex;
		align-items: baseline;
		gap: var(--gap-4);
		flex-wrap: wrap;
	}

	.console__name {
		font-family: var(--font-display);
		font-size: var(--step-3);
		text-transform: uppercase;
		line-height: 0.94;
		letter-spacing: 0.015em;
		color: var(--text);
	}

	.console__tag {
		font-size: var(--step--2);
		font-weight: 460;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--orange);
	}

	.console__tag-jp {
		white-space: nowrap;
	}

	.console__rail-bay {
		display: flex;
		align-items: baseline;
		gap: var(--gap-4);
	}

	.console__body {
		flex: 1;
		width: 100%;
		max-width: 76rem;
		margin-inline: auto;
		padding-top: var(--gap-6);
	}

	@media (max-width: 480px) {
		.console__rail {
			padding-block: var(--gap-3);
		}

		.console__tag-jp {
			display: none; /* density strategy: JP layer is first to yield on phones */
		}
	}
</style>
