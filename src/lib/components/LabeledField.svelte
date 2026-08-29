<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	/**
	 * LabeledField — tracked-caps mono label + console input well.
	 * Every input in the console flows through here (email entry, OTP command
	 * line). Rest props spread onto the <input> (type/value/placeholder/name/
	 * bind:value/autocomplete/...).
	 *
	 * State grammar: hint (muted) vs error (bright alarm + role="alert");
	 * errors name the problem and the recovery, never just "invalid".
	 */
	let {
		label,
		hint = '',
		error = '',
		value = $bindable(),
		...rest
	}: {
		label: string;
		hint?: string;
		error?: string;
	} & HTMLInputAttributes = $props();
</script>

<label class="field" class:field--error={error}>
	<span class="field__label">{label}</span>
	<input class="field__input" bind:value aria-invalid={error ? 'true' : undefined} {...rest} />
	{#if error}
		<span class="field__message field__message--error" role="alert">{error}</span>
	{:else if hint}
		<span class="field__message">{hint}</span>
	{/if}
</label>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
	}

	.field__label {
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 520;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--text-muted);
	}

	.field__input {
		width: 100%;
		min-height: 3rem;
		padding: 0.5rem 0.85rem;
		background: var(--panel-inset);
		border: 1px solid var(--hairline);
		color: var(--text);
		font-family: var(--font-mono);
		font-size: var(--step-1);
		letter-spacing: 0.04em;
		caret-color: var(--orange);
	}

	.field__input::placeholder {
		color: var(--text-muted); /* 5.41:1 — placeholders meet AA here */
		opacity: 1;
	}

	.field__input:hover {
		border-color: var(--orange);
	}

	.field__input:focus-visible {
		outline: none;
		border-color: var(--orange);
		box-shadow: var(--glow-orange);
	}

	.field--error .field__input {
		border-color: var(--alarm);
	}

	.field--error .field__input:focus-visible {
		box-shadow: var(--glow-alarm);
	}

	.field__message {
		font-size: var(--step--2);
		letter-spacing: 0.06em;
		color: var(--text-muted);
	}

	.field__message--error {
		color: var(--alarm-bright); /* small text — bright alarm, 5.63:1 */
	}
</style>
