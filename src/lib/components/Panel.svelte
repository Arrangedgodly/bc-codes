<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Panel — a console panel: hairline boundary, machined corner brackets,
	 * tracked-caps label + sublabel. The container of the Crisis Wall; cards
	 * are not nested inside panels, panels ARE this world's cards.
	 *
	 * Props:
	 *   label    — tracked-caps panel label (plain text; the heading voice)
	 *   sublabel — optional second data line (right-aligned in the head)
	 *   tag      — optional decorative JP micro-label (rendered aria-hidden)
	 *   tone     — 'default' | 'nominal' | 'caution' | 'alarm' — tints the
	 *              brackets + label; state is ALSO carried by text (a11y)
	 *   footer   — optional snippet rendered under the body, above the bottom edge
	 *   children — panel content
	 */
	let {
		label,
		sublabel = '',
		tag = '',
		tone = 'default',
		footer = null,
		children
	}: {
		label: string;
		sublabel?: string;
		tag?: string;
		tone?: 'default' | 'nominal' | 'caution' | 'alarm';
		footer?: Snippet | null;
		children: Snippet;
	} = $props();

	const toneColor: Record<string, string> = {
		default: 'var(--orange)',
		nominal: 'var(--green)',
		caution: 'var(--orange-bright)',
		alarm: 'var(--alarm)'
	};
</script>

<section class="panel" data-tone={tone}>
	<div class="panel__corners brackets" style="--bracket-color: {toneColor[tone]}" aria-hidden="true">
	</div>
	<header class="panel__head">
		<h2 class="panel__label">{label}</h2>
		{#if sublabel}
			<span class="panel__sublabel">{sublabel}</span>
		{/if}
		{#if tag}
			<span class="panel__tag micro" aria-hidden="true">{tag}</span>
		{/if}
	</header>
	<div class="panel__body">
		{@render children()}
	</div>
	{#if footer}
		<footer class="panel__foot">
			{@render footer()}
		</footer>
	{/if}
</section>

<style>
	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--hairline-dim);
		padding: var(--gap-4);
	}

	/* corner brackets ride just inside the boundary */
	.panel__corners {
		position: absolute;
		inset: 3px;
		pointer-events: none;
	}

	.panel[data-tone='alarm'] {
		border-color: var(--hairline-alarm);
	}

	.panel[data-tone='nominal'] {
		border-color: var(--hairline-green);
	}

	.panel__head {
		display: flex;
		align-items: baseline;
		gap: var(--gap-3);
		flex-wrap: wrap;
		padding-bottom: var(--gap-3);
		margin-bottom: var(--gap-4);
		border-bottom: 1px solid var(--hairline-dim);
	}

	.panel__label {
		font-family: var(--font-mono);
		font-size: var(--step--1);
		font-weight: 560;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		line-height: 1.4;
		color: var(--text);
	}

	.panel[data-tone='nominal'] .panel__label {
		color: var(--green);
	}

	.panel[data-tone='caution'] .panel__label {
		color: var(--orange-bright);
	}

	.panel[data-tone='alarm'] .panel__label {
		color: var(--alarm-bright); /* small-text-safe alarm */
	}

	.panel__sublabel {
		margin-inline-start: auto;
		font-size: var(--step--2);
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.panel__tag {
		margin-inline-start: auto;
	}

	.panel__sublabel + .panel__tag {
		margin-inline-start: 0;
	}

	.panel__body {
		display: flex;
		flex-direction: column;
		gap: var(--gap-3);
		flex: 1;
	}

	.panel__foot {
		display: flex;
		align-items: center;
		gap: var(--gap-3);
		flex-wrap: wrap;
		margin-top: var(--gap-4);
		padding-top: var(--gap-3);
		border-top: 1px solid var(--hairline-dim);
	}
</style>
