<script lang="ts">
	// FE1 internal design reference — exercises every Crisis Wall component at
	// representative states (dense/empty, every status color, tones, sizes).
	//
	// DELIBERATELY KEPT as a shipped /design route rather than deleted:
	// FE2–FE5 build against this matrix; unlinked from every nav, disallowed in
	// robots.txt, noindex. Every value on this page is a FIXTURE, not live data.
	import {
		Panel,
		SegmentedMeter,
		StatusChip,
		SevenSegmentCount,
		LabeledField,
		PrimaryAction,
		GhostAction,
		CopyField
	} from '$lib/components';

	const meterStates = [
		{ label: 'full pool', sub: '100/100 · nominal', available: 100, total: 100, state: 'active' as const, tone: 'nominal' as const, chip: 'available' as const },
		{ label: 'draining', sub: '62/100 · nominal', available: 62, total: 100, state: 'active' as const, tone: 'nominal' as const, chip: 'available' as const },
		{ label: 'running low', sub: '14/100 · caution', available: 14, total: 100, state: 'active' as const, tone: 'caution' as const, chip: 'available' as const },
		{ label: 'last codes', sub: '3/100 · caution', available: 3, total: 100, state: 'active' as const, tone: 'caution' as const, chip: 'available' as const },
		{ label: 'drained', sub: '0/100 · alarm', available: 0, total: 100, state: 'drained' as const, tone: 'alarm' as const, chip: 'drained' as const },
		{ label: 'paused', sub: '40/100 · held', available: 40, total: 100, state: 'paused' as const, tone: 'caution' as const, chip: 'paused' as const },
		{ label: 'empty pool', sub: '0/0 · no codes yet', available: 0, total: 0, state: 'active' as const, tone: 'default' as const, chip: 'paused' as const },
		{ label: 'single code', sub: '1/1 · minimal pool', available: 1, total: 1, state: 'active' as const, tone: 'caution' as const, chip: 'available' as const }
	];

	const chipStates = ['available', 'claimed', 'paused', 'drained', 'reported', 'draft'] as const;

	let email = $state('');
	let otp = $state('');
</script>

<svelte:head>
	<title>Design reference — internal</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<h1 class="display page-title">Design reference</h1>
<p class="intro label">
	internal · every value below is a fixture, not live data · seed ac07c5ea
</p>

<section class="block">
	<h2 class="display block-title">Availability meters</h2>
	<div class="grid">
		{#each meterStates as m (m.label)}
			<Panel label={m.label} sublabel={m.sub} tone={m.tone} tag="残コード">
				<SegmentedMeter available={m.available} total={m.total} state={m.state} label="{m.label}: codes available" />
				<div class="meter-foot">
					<SevenSegmentCount value={m.available} pad={3} label="remaining" size="sm" tone={m.state === 'drained' ? 'red' : m.state === 'paused' ? 'orange' : 'green'} />
					<StatusChip state={m.chip} />
				</div>
			</Panel>
		{/each}
	</div>
</section>

<section class="block">
	<h2 class="display block-title">Seven-segment counts</h2>
	<Panel label="readouts" sublabel="DSEG7 classic" tag="カウント">
		<div class="counts">
			<SevenSegmentCount value={2500} pad={4} label="large pool · 4-digit" size="md" />
			<SevenSegmentCount value={99} pad={3} label="typical pool" size="md" tone="orange" />
			<SevenSegmentCount value={0} pad={3} label="drained readout" size="md" tone="red" />
			<SevenSegmentCount value={7} label="unpadded" size="sm" />
		</div>
	</Panel>
</section>

<section class="block">
	<h2 class="display block-title">Status chips</h2>
	<Panel label="state semantics" sublabel="all six">
		<div class="chips">
			{#each chipStates as s (s)}
				<StatusChip state={s} />
			{/each}
		</div>
		<p class="note">Green = available / claimed-yours · orange = held / interactive · red = drained / reported, never decoration · gray = draft (FE5: not yet live).</p>
	</Panel>
</section>

<section class="block">
	<h2 class="display block-title">Entry fields + actions</h2>
	<div class="grid grid--two">
		<Panel label="fan entry" sublabel="claim flow" tag="認証">
			<LabeledField
				label="email"
				type="email"
				placeholder="fan@example.com"
				autocomplete="email"
				inputmode="email"
				bind:value={email}
				hint="verify once per browser — no account is created"
			/>
			<LabeledField
				label="code entry"
				type="text"
				placeholder="000000"
				inputmode="numeric"
				maxlength={6}
				autocomplete="one-time-code"
				bind:value={otp}
				error="that code expired — request a new one and try again"
			/>
			<PrimaryAction>launch claim</PrimaryAction>
		</Panel>
		<Panel label="action states" sublabel="launch tier · standard · disabled" tag="発射">
			<div class="meter-foot">
				<PrimaryAction class="action--lg">new drop</PrimaryAction>
				<PrimaryAction>bandcamp launch</PrimaryAction>
				<PrimaryAction disabled>pool drained</PrimaryAction>
			</div>
			<p class="note">
				Tab through this panel to see the focus brackets; the glow pulse is disabled under
				prefers-reduced-motion. The launch tier (action--lg) is the console dashboard's NEW
				DROP — the journey's standing first step, its label at the headline step of the ramp.
			</p>
		</Panel>
		<Panel label="console controls" sublabel="FE5 · ghost + copy" tag="操作">
			<div class="meter-foot">
				<GhostAction>pause drop</GhostAction>
				<GhostAction disabled>checking…</GhostAction>
				<GhostAction href="https://arrangedgodly.bandcamp.com" target="_blank" rel="noopener noreferrer">open page ↗</GhostAction>
			</div>
			<CopyField value="https://bc-codes.example/p/taxed-tolled-eternally-trolled" label="share link (fixture)" />
			<p class="note">The ghost control is the console's working button; COPY writes the clipboard and falls back to selecting the link.</p>
		</Panel>
	</div>
</section>

<section class="block">
	<h2 class="display block-title">Drop-cell composition</h2>
	<div class="grid grid--two">
		<Panel
			label="taxed, tolled &amp; eternally trolled"
			sublabel="arrangedgodly · fixture"
			tone="nominal"
			tag="ドロップセル"
		>
			<SevenSegmentCount value={21} pad={3} label="codes remaining" size="lg" />
			<SegmentedMeter available={21} total={25} state="active" label="codes available" />
			<div class="meter-foot">
				<StatusChip state="available" />
				<StatusChip state="claimed" />
			</div>
			{#snippet footer()}
				<PrimaryAction href="https://arrangedgodly.bandcamp.com/yum">launch claim</PrimaryAction>
			{/snippet}
		</Panel>
		<Panel label="drained cell" sublabel="fixture · alarm register" tone="alarm" tag="終了">
			<SevenSegmentCount value={0} pad={3} label="codes remaining" size="lg" tone="red" />
			<SegmentedMeter available={0} total={25} state="drained" label="codes available" />
			<div class="meter-foot">
				<StatusChip state="drained" text="drained — all codes claimed" />
			</div>
			{#snippet footer()}
				<PrimaryAction disabled>pool drained</PrimaryAction>
			{/snippet}
		</Panel>
	</div>
</section>

<style>
	.page-title {
		font-size: clamp(var(--step-4), 8vw, var(--step-6));
		margin-bottom: var(--gap-2);
	}

	.intro {
		margin-bottom: var(--gap-6);
	}

	.block {
		margin-bottom: var(--gap-7);
	}

	.block-title {
		font-size: var(--step-2);
		margin-bottom: var(--gap-4);
		color: var(--orange);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(19rem, 100%), 1fr));
		gap: var(--gap-4);
	}

	.grid--two {
		grid-template-columns: repeat(auto-fill, minmax(min(24rem, 100%), 1fr));
	}

	.meter-foot {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--gap-3);
		flex-wrap: wrap;
	}

	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--gap-5);
		align-items: flex-end;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--gap-3);
	}

	.note {
		font-size: var(--step--1);
		color: var(--text-muted);
		max-width: var(--measure);
	}
</style>
