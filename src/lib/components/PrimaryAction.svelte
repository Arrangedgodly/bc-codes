<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes, SvelteHTMLElements } from 'svelte/elements';

	/**
	 * PrimaryAction — THE orange glow action. One per screen (fan flows are
	 * one-hand, one-action). Anton caps label on phosphor orange, black text
	 * (6.41:1 AA). Focus = machined corner brackets in the void around the
	 * button, always visible — the world's focus grammar. The idle glow pulse
	 * is motion-gated; the resting glow is static material.
	 *
	 * `href` renders an anchor (redeem deep-links stay real links: FE3).
	 *
	 * `action--lg` is the launch tier: the same slab with its label at the
	 * headline step of the ramp (clamp 1.75rem→3.5rem, padding widened to
	 * match) — for the one screen whose primary IS the product's promise
	 * (the console dashboard's NEW DROP, the standing first step of the
	 * 3-minute CSV→link journey). Same material, same grammar, one tier up.
	 */
	let {
		href = '',
		type = 'button',
		class: className = '',
		children,
		...rest
	}: {
		href?: string;
		children: Snippet;
	} & HTMLButtonAttributes &
		SvelteHTMLElements['a'] = $props();
</script>

{#if href}
	<a class="action {className}" href={href} {...rest}>
		{@render children()}
	</a>
{:else}
	<button class="action {className}" {type} {...rest}>
		{@render children()}
	</button>
{/if}

<style>
	.action {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.6em;
		min-height: 3.5rem;
		padding: 0.55rem 1.6rem;
		background: var(--orange);
		color: var(--ink); /* 6.41:1 AA on orange */
		font-family: var(--font-display);
		font-size: var(--step-2);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		line-height: 1;
		text-decoration: none;
		border: 1px solid var(--orange-bright);
		box-shadow: var(--glow-orange);
		cursor: pointer;
		transition:
			background-color 140ms ease-out,
			box-shadow 140ms ease-out;
	}

	/* Focus brackets: four machined ticks riding outside the button, in the
	   void. Drawn with the same 8-stroke technique as Panel's brackets. */
	.action::after {
		content: '';
		position: absolute;
		inset: -7px;
		pointer-events: none;
		opacity: 0;
		background-image:
			linear-gradient(var(--orange-bright), var(--orange-bright)),
			linear-gradient(var(--orange-bright), var(--orange-bright)),
			linear-gradient(var(--orange-bright), var(--orange-bright)),
			linear-gradient(var(--orange-bright), var(--orange-bright)),
			linear-gradient(var(--orange-bright), var(--orange-bright)),
			linear-gradient(var(--orange-bright), var(--orange-bright)),
			linear-gradient(var(--orange-bright), var(--orange-bright)),
			linear-gradient(var(--orange-bright), var(--orange-bright));
		background-repeat: no-repeat;
		background-size:
			10px 2px,
			2px 10px,
			10px 2px,
			2px 10px,
			10px 2px,
			2px 10px,
			10px 2px,
			2px 10px;
		background-position:
			0 0,
			0 0,
			100% 0,
			100% 0,
			100% 100%,
			100% 100%,
			0 100%,
			0 100%;
	}

	.action:hover {
		background: var(--orange-bright);
		color: var(--ink);
	}

	.action:focus-visible {
		outline: none;
	}

	.action:focus-visible::after {
		opacity: 1;
	}

	.action:active {
		transform: translateY(1px); /* keypress seats the physical button */
	}

	.action:disabled,
	.action[aria-disabled='true'] {
		background: var(--panel-inset);
		color: var(--text-muted); /* 5.41:1 — honest disabled, still readable */
		border-color: var(--hairline);
		box-shadow: none;
		cursor: not-allowed;
	}

	/* full-width variant for stacked mobile flows */
	.action.action--block {
		width: 100%;
	}

	/* launch tier — the label joins the headline ramp (the same clamp the
	   project pages' headlines use), so the journey's standing first step
	   reads at the scale of its job. Natural height carries the tier: the
	   base 3.5rem floor stays for smaller labels, and the phone rule below
	   still lands its 4rem full-width slab untouched. */
	.action.action--lg {
		font-size: clamp(var(--step-3), 7vw, var(--step-5));
		padding: 0.75rem 2rem;
	}

	@media (max-width: 480px) {
		.action {
			width: 100%;
			min-height: 4rem; /* one-hand fan flow */
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.action {
			animation: phosphor-pulse 2.8s ease-in-out infinite;
		}

		.action:disabled,
		.action[aria-disabled='true'] {
			animation: none;
		}
	}
</style>
