<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes, SvelteHTMLElements } from 'svelte/elements';

	/**
	 * GhostAction (FE5) — the console's secondary control. PrimaryAction is
	 * the one orange slab per screen; GhostAction is the working button that
	 * fills artist-console panels: recessed well, hairline boundary, tracked
	 * mono caps in phosphor text. Same state grammar as every control in this
	 * world — hover brightens the boundary, disabled is honest and readable,
	 * focus is the global machined ring. `href` renders a real anchor (open-
	 * page links stay links: middle-click, copy URL, no JS needed).
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
	<a class="ghost {className}" {href} {...rest}>
		{@render children()}
	</a>
{:else}
	<button class="ghost {className}" {type} {...rest}>
		{@render children()}
	</button>
{/if}

<style>
	.ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5em;
		min-height: 2.5rem;
		padding: 0.35rem 0.9rem;
		background: var(--panel-inset);
		color: var(--orange); /* 6.59:1 on the inset well — AA */
		border: 1px solid var(--hairline);
		font-family: var(--font-mono);
		font-size: var(--step--1);
		font-weight: 520;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		line-height: 1.4;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			color 140ms ease-out,
			border-color 140ms ease-out;
	}

	.ghost:hover {
		color: var(--orange-bright);
		border-color: var(--orange);
	}

	.ghost:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: 3px;
	}

	.ghost:active {
		transform: translateY(1px);
	}

	.ghost:disabled,
	.ghost[aria-disabled='true'] {
		color: var(--text-muted); /* 5.56:1 — honest disabled, still readable */
		border-color: var(--hairline-dim);
		background: transparent;
		cursor: not-allowed;
	}
</style>
