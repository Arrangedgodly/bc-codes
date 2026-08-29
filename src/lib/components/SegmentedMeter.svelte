<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';

	/**
	 * SegmentedMeter — THE availability primitive. A fixed row of segments;
	 * filled segments = the real pool fraction, never a naked percentage.
	 * Every meter on screen is a real count (no fabricated scarcity).
	 *
	 * Color logic (state first, then fraction):
	 *   active + fraction >  LOW  → nominal green (available)
	 *   active + fraction <= LOW  → caution orange (pool truly running low — honest)
	 *   paused                     → orange dim, chevron band: pool held, not gone
	 *   drained                    → no fill, alarm slot edges + red hazard rail
	 *
	 * Slot honesty: every slot is an individual hairline-edged well. Unfilled
	 * slots carry a 15%-alpha ghost of the live tone — the unlit display, the
	 * same idea as the code slab's 8% all-segments ghost — so the pool's full
	 * extent reads as N distinct cells, never a muddy strip. Drained pools
	 * keep dead slots (no ghost): nothing is lit because nothing remains.
	 *
	 * a11y: role="meter" carries value/min/max/label; the segment strip is
	 * aria-hidden decoration. State is always duplicated in adjacent text
	 * (StatusChip / Panel sublabel) — the meter is never the sole indicator.
	 */
	let {
		available,
		total,
		state = 'active',
		segments = 24,
		label = 'codes available',
		...rest
	}: {
		available: number;
		total: number;
		state?: 'active' | 'paused' | 'drained';
		segments?: number;
		label?: string;
	} & SvelteHTMLElements['div'] = $props();

	const LOW = 0.15;

	const safeTotal = $derived(Math.max(0, Math.floor(total)));
	const safeAvailable = $derived(Math.min(Math.max(0, Math.floor(available)), safeTotal));
	const fraction = $derived(safeTotal === 0 ? 0 : safeAvailable / safeTotal);
	const filled = $derived(
		safeTotal === 0 ? 0 : Math.min(segments, Math.max(safeAvailable > 0 ? 1 : 0, Math.round(fraction * segments)))
	);

	const fillClass = $derived.by(() => {
		if (state === 'paused') return 'seg--held';
		if (state === 'drained') return 'seg--drained';
		if (safeAvailable === 0) return 'seg--empty';
		return fraction <= LOW ? 'seg--low' : 'seg--nominal';
	});
</script>

<div class="meter" data-state={state}>
	<div
		class="meter__strip"
		role="meter"
		aria-label={label}
		aria-valuenow={safeAvailable}
		aria-valuemin={0}
		aria-valuemax={safeTotal}
		{...rest}
	>
		{#each Array(segments) as _, i (i)}
			<span class="meter__slot" aria-hidden="true">
				<span class="meter__seg {fillClass}" class:meter__seg--on={i < filled}></span>
			</span>
		{/each}
	</div>
	{#if state === 'drained'}
		<div class="meter__rail hazard hazard--crawl-alarm" aria-hidden="true"></div>
	{/if}
	{#if state === 'paused'}
		<div class="meter__rail hazard hazard--crawl meter__rail--held" aria-hidden="true"></div>
	{/if}
</div>

<style>
	.meter {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
	}

	.meter__strip {
		display: flex;
		gap: 2px;
		width: 100%;
	}

	.meter__slot {
		flex: 1 1 0;
		height: 14px;
		padding: 2px;
		border: 1px solid var(--hairline);
		background: var(--panel-inset);
		display: flex;
	}

	/* Unlit segments hold a ghost of the tone (the unlit display) — each
	   slot stays an individual cell at rest; lit segments carry full tone
	   and the phosphor glow. Dead pools (drained, or an active pool at
	   zero) keep their slots empty. */
	.meter__seg {
		flex: 1;
		opacity: var(--seg-unlit, 0.15);
	}

	.meter__seg--on {
		opacity: 1;
	}

	/* slot edges carry state so color survives even where fill can't */
	.meter[data-state='drained'] .meter__slot {
		border-color: var(--hairline-alarm);
	}

	.seg--nominal {
		background: var(--green);
	}

	.seg--low {
		background: var(--orange);
	}

	.meter__seg--on.seg--nominal {
		box-shadow: var(--glow-green);
	}

	.meter__seg--on.seg--low {
		box-shadow: var(--glow-orange);
	}

	/* held pool: the claimed fraction stays lit but dimmed (present, held);
	   the unlit extent shows the ghost like any active pool */
	.seg--held {
		background: var(--orange);
	}

	.meter__seg--on.seg--held {
		opacity: 0.9;
		filter: brightness(0.55) saturate(0.85);
	}

	.seg--drained,
	.seg--empty {
		--seg-unlit: 0;
		background: transparent;
	}

	/* hazard rail under the strip — alarm on drained, held on paused */
	.meter__rail {
		height: 4px;
		opacity: 0.85;
	}

	.meter__rail--held {
		opacity: 0.4;
	}

	@media (max-width: 480px) {
		.meter__slot {
			height: 12px;
		}
	}
</style>
