<script lang="ts">
	import GhostAction from './GhostAction.svelte';

	/**
	 * CopyField (FE5) — a shareable URL as a console artifact: a read-only
	 * input well + COPY action. The manual-select fallback IS the input —
	 * when the clipboard API is unavailable the text is selected in place and
	 * the note names the keypress, so the link is always copable by hand.
	 * Read-only on purpose: share links are derived (the slug), never typed.
	 *
	 * `compact` drops the standing label for dense rows (dashboard panels);
	 * the input's own aria-label still names it.
	 */
	let {
		value,
		label = 'share link',
		compact = false
	}: {
		value: string;
		label?: string;
		compact?: boolean;
	} = $props();

	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let copyState = $state<'idle' | 'copied' | 'manual'>('idle');
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		clearTimeout(resetTimer);
		try {
			await navigator.clipboard.writeText(value);
			copyState = 'copied';
		} catch {
			// Clipboard blocked (permissions, non-secure context): fall back
			// to selecting the text so the keypress path is one step away.
			copyState = 'manual';
			inputEl?.focus();
			inputEl?.select();
		}
		resetTimer = setTimeout(() => (copyState = 'idle'), 5000);
	}
</script>

<div class="copyfield" class:copyfield--compact={compact}>
	{#if !compact}
		<span class="copyfield__label label">{label}</span>
	{/if}
	<div class="copyfield__row">
		<input
			class="copyfield__input"
			type="text"
			readonly
			value={value}
			aria-label={label}
			bind:this={inputEl}
			onfocus={(event) => event.currentTarget.select()}
		/>
		<GhostAction class="copyfield__btn" onclick={copy} aria-label="copy {label}">copy</GhostAction>
	</div>
	<!-- the announcement region: what happened, named in words -->
	<span class="copyfield__note label" role="status">
		{#if copyState === 'copied'}
			copied — paste it anywhere
		{:else if copyState === 'manual'}
			clipboard unavailable — link selected, press cmd/ctrl + c
		{/if}
	</span>
</div>

<style>
	.copyfield {
		display: flex;
		flex-direction: column;
		gap: var(--gap-1);
		min-width: 0;
	}

	.copyfield__row {
		display: flex;
		gap: var(--gap-2);
		align-items: stretch;
		min-width: 0;
	}

	.copyfield__input {
		flex: 1;
		min-width: 0;
		padding: 0.35rem 0.6rem;
		background: var(--panel-inset);
		border: 1px solid var(--hairline);
		color: var(--text);
		font-family: var(--font-mono);
		font-size: var(--step--1);
		letter-spacing: 0.04em;
		text-overflow: ellipsis;
	}

	.copyfield__input:focus-visible {
		outline: none;
		border-color: var(--orange);
		box-shadow: var(--glow-orange);
	}

	/* class lands inside GhostAction's root — reach it globally */
	:global(.copyfield__btn) {
		flex: none;
	}

	.copyfield__note {
		min-height: 1.4em; /* the row never shifts when a note lands */
		color: var(--text-muted);
	}

	.copyfield--compact .copyfield__input {
		padding: 0.25rem 0.55rem;
		font-size: var(--step--2);
	}
</style>
