<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';

	/**
	 * StatusChip — state semantics as a small tracked-caps chip with a leading
	 * marker square. Honest states everywhere: drained says drained.
	 *
	 *   available → nominal green   (pool open)
	 *   claimed    → nominal green  (yours — the same green, different words)
	 *   paused     → orange         (held)
	 *   drained    → alarm red      (gone)
	 *   reported   → alarm red      (dead code, reissue pending)
	 *   draft      → warm gray      (FE5: not yet live — no codes uploaded,
	 *                               nothing to publish; deliberately no glow)
	 *
	 * Small text uses the bright alarm tint (AA); the marker square uses base
	 * --alarm (fill, 3:1+ against the panel).
	 */
	let {
		state,
		text,
		...rest
	}: {
		state: 'available' | 'paused' | 'drained' | 'claimed' | 'reported' | 'draft';
		/** Override the default wording; keep it short + honest */
		text?: string;
	} & SvelteHTMLElements['span'] = $props();

	const DEFAULTS: Record<string, string> = {
		available: 'available',
		paused: 'paused',
		drained: 'drained',
		claimed: 'claimed — yours',
		reported: 'reported',
		draft: 'draft'
	};
</script>

<span class="chip" data-state={state} {...rest}>
	<span class="chip__marker" aria-hidden="true"></span>
	<span class="chip__text">{text ?? DEFAULTS[state]}</span>
</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5em;
		padding: 0.28em 0.7em 0.24em;
		border: 1px solid var(--hairline-dim);
		background: var(--panel-inset);
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 520;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		line-height: 1.5;
		white-space: nowrap;
	}

	.chip__marker {
		width: 0.55em;
		height: 0.55em;
		flex: none;
	}

	.chip[data-state='available'],
	.chip[data-state='claimed'] {
		color: var(--green);
		border-color: var(--hairline-green);
	}

	.chip[data-state='available'] .chip__marker,
	.chip[data-state='claimed'] .chip__marker {
		background: var(--green);
		box-shadow: var(--glow-green);
	}

	.chip[data-state='paused'] {
		color: var(--orange-bright);
		border-color: var(--hairline);
	}

	.chip[data-state='paused'] .chip__marker {
		background: var(--orange);
	}

	.chip[data-state='drained'],
	.chip[data-state='reported'] {
		color: var(--alarm-bright);
		border-color: var(--hairline-alarm);
	}

	.chip[data-state='drained'] .chip__marker,
	.chip[data-state='reported'] .chip__marker {
		background: var(--alarm);
		box-shadow: var(--glow-alarm);
	}

	/* draft: quiet warm gray — the drop exists but publishes nothing yet */
	.chip[data-state='draft'] {
		color: var(--text-muted);
		border-color: var(--hairline-dim);
	}

	.chip[data-state='draft'] .chip__marker {
		background: var(--text-muted);
		opacity: 0.75;
	}
</style>
