<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';

	/**
	 * SevenSegmentCount — a count rendered on the seven-segment readout.
	 * Counts are REAL pool numbers; this component never invents one.
	 *
	 * a11y: the container carries an aria-label with the plain number and the
	 * label text; the DSEG7 glyph layer is aria-hidden (the face has no real
	 * lowercase and its 7-seg forms are decorative representation).
	 * Motion-safe: value changes can tick via `steps()` (gated in app.css);
	 * by default the readout is static — reduced-motion users get exactly that.
	 */
	let {
		value,
		label,
		pad = 0,
		tone = 'green',
		size = 'md',
		...rest
	}: {
		value: number;
		/** What is being counted, e.g. "codes remaining" */
		label: string;
		/** Zero-pad to N digits (readouts keep their width as the pool drains) */
		pad?: number;
		tone?: 'green' | 'orange' | 'red';
		size?: 'sm' | 'md' | 'lg' | 'xl';
	} & SvelteHTMLElements['span'] = $props();

	const safeValue = $derived(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
	const digits = $derived(
		pad > 0 ? String(safeValue).padStart(pad, '0') : String(safeValue)
	);
</script>

<span class="sevenseg sevenseg--{size}" data-tone={tone} role="status" aria-label="{label}: {safeValue}" {...rest}>
	<span class="sevenseg__digits" aria-hidden="true">{digits}</span>
	<span class="sevenseg__label label">{label}</span>
</span>

<style>
	.sevenseg {
		display: inline-flex;
		flex-direction: column;
		gap: var(--gap-1);
	}

	.sevenseg__digits {
		font-family: var(--font-seg);
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0.14em; /* seven-seg displays gap their digits */
		padding: 0.06em 0.1em 0.02em 0.16em; /* optical centering inside the well */
		background: var(--panel-inset);
		border: 1px solid var(--hairline-dim);
		color: var(--green);
		text-shadow: var(--glow-green);
	}

	.sevenseg[data-tone='orange'] .sevenseg__digits {
		color: var(--orange);
		text-shadow: var(--glow-orange);
	}

	.sevenseg[data-tone='red'] .sevenseg__digits {
		color: var(--alarm-bright); /* counts read as text — bright alarm, AA */
		text-shadow: var(--glow-alarm);
		border-color: var(--hairline-alarm);
	}

	.sevenseg--sm .sevenseg__digits {
		font-size: var(--step-1);
	}

	.sevenseg--md .sevenseg__digits {
		font-size: var(--step-4);
	}

	.sevenseg--lg .sevenseg__digits {
		font-size: var(--step-5);
	}

	/* xl is reserved for near-monumental readouts (drop-cell headers) */
	.sevenseg--xl .sevenseg__digits {
		font-size: var(--step-6);
	}

	.sevenseg__label {
		white-space: nowrap;
	}
</style>
