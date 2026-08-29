<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Artwork,
		CopyField,
		GhostAction,
		Panel,
		PrimaryAction,
		SegmentedMeter,
		SevenSegmentCount,
		StatusChip
	} from '$lib/components';
	import { APP_NAME } from '$lib/brand';
	import { SessionLapsed, consoleFetch, consoleJsonBody, patchConsoleJson } from '$lib/console-client';
	import type { PageData } from './$types';

	/** The load's project shape, derived — never a client-side $lib/server import. */
	type Project = PageData['projects'][number];
	type Status = Project['status'];

	/**
	 * FE5 — the artist dashboard: the console's control wall. One panel per
	 * drop: real stats (seven-segment + meter), honest status chips (draft
	 * reads draft, drained reads drained), artwork payload, the share link
	 * with copy, and the working actions — pause/resume (optimistic, rolled
	 * back honestly on failure), artwork refresh, open the public page.
	 * Every number is a derived COUNT from BE7 — nothing fabricated.
	 *
	 * Pause/resume is OPTIMISTIC with rollback: the chip flips instantly,
	 * and a refusal (e.g. a drained pool) reverts it and names the rule in
	 * words — the console never shows a state the server rejected.
	 */

	let { data }: { data: PageData } = $props();

	/** Must mirror SegmentedMeter's internal LOW — one honest low-pool line. */
	const LOW_FRACTION = 0.15;
	const isLow = (p: Project) => p.stats.total > 0 && p.stats.available / p.stats.total <= LOW_FRACTION;

	// --- pause/resume: optimistic overlay over the SSR truth -------------------
	let optimistic = $state<Record<number, 'active' | 'paused'>>({});
	let busyIds = $state<Record<number, boolean>>({});
	let dashNote = $state('');
	let noteBox = $state<HTMLParagraphElement | undefined>(undefined);

	function statusOf(p: Project): Status {
		return optimistic[p.id] ?? p.status;
	}

	async function togglePause(p: Project) {
		if (busyIds[p.id]) return;
		const current = statusOf(p);
		if (current !== 'active' && current !== 'paused') return;
		const target = current === 'paused' ? 'active' : 'paused';
		optimistic = { ...optimistic, [p.id]: target };
		busyIds = { ...busyIds, [p.id]: true };
		dashNote = '';
		try {
			const { res, body } = await patchConsoleJson(`/api/artist/projects/${p.id}`, { status: target });
			if (!res.ok) {
				rollback(p.id);
				dashNote =
					body?.message ??
					(body?.error === 'unauthorized'
						? 'Your session lapsed — sign in again from the rail.'
						: `The ${target === 'paused' ? 'pause' : 'resume'} did not go through — the drop still reads ${current}.`);
				focusNote();
				return;
			}
				await invalidateAll();
				rollback(p.id); // the load's fresh status is the truth now
			} catch (error) {
				if (error instanceof SessionLapsed) return;
				rollback(p.id);
				dashNote = `The ${target === 'paused' ? 'pause' : 'resume'} did not go through — the drop still reads ${current}.`;
				focusNote();
			} finally {
			const { [p.id]: _drop, ...rest } = busyIds;
			busyIds = rest;
		}
	}

	function rollback(id: number) {
		const { [id]: _drop, ...rest } = optimistic;
		optimistic = rest;
	}

	// --- artwork refresh ---------------------------------------------------------
	let refreshing = $state<Record<number, boolean>>({});

	async function refreshArtwork(p: Project) {
		if (refreshing[p.id]) return;
		refreshing = { ...refreshing, [p.id]: true };
		dashNote = '';
		try {
			const res = await consoleFetch(`/api/artist/projects/${p.id}/refresh-artwork`, { method: 'POST' });
			const body = await consoleJsonBody(res);
			if (!res.ok) {
				dashNote = `The artwork check for “${p.title}” failed — try again in a moment.`;
				focusNote();
				return;
			}
			const status = (body as { artwork?: { status?: string } } | null)?.artwork?.status;
			dashNote =
				status === 'fetched'
					? `Cover art for “${p.title}” fetched.`
					: `No usable artwork on “${p.title}”'s album page — the honest text card stands in.`;
			focusNote();
			await invalidateAll();
		} catch (error) {
			if (error instanceof SessionLapsed) return;
			dashNote = `The artwork check for “${p.title}” failed — try again in a moment.`;
			focusNote();
		} finally {
			const { [p.id]: _drop, ...rest } = refreshing;
			refreshing = rest;
		}
	}

	function focusNote() {
		requestAnimationFrame(() => noteBox?.focus());
	}

	// --- view semantics ------------------------------------------------------------
	function chipState(p: Project): 'available' | 'paused' | 'drained' | 'draft' {
		const status = statusOf(p);
		if (status === 'active') return 'available';
		return status;
	}
	function meterState(p: Project): 'active' | 'paused' | 'drained' {
		const status = statusOf(p);
		return status === 'draft' ? 'active' : status;
	}
	function countTone(p: Project): 'green' | 'orange' | 'red' {
		const status = statusOf(p);
		if (status === 'drained') return 'red';
		if (status === 'paused' || status === 'draft' || isLow(p)) return 'orange';
		return 'green';
	}
	function panelTone(p: Project): 'default' | 'nominal' | 'caution' | 'alarm' {
		const status = statusOf(p);
		if (status === 'drained') return 'alarm';
		if (status === 'paused' || status === 'draft' || isLow(p)) return 'caution';
		return 'nominal';
	}
	function statusLine(p: Project): string {
		switch (statusOf(p)) {
			case 'draft':
				return 'draft — goes live the moment codes are uploaded';
			case 'paused':
				return 'held — the pool waits, fans see the paused state';
			case 'drained':
				return `drained — all ${p.stats.total} codes claimed; uploading re-activates`;
			default:
				return 'live on the wall';
		}
	}

	const shareUrl = (p: Project) => `${page.url.origin}/p/${p.slug}`;
	const dropCount = $derived(data.projects.length);
</script>

<svelte:head>
	<title>Artist console · {APP_NAME}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<header class="dash-head">
	<div>
		<h1 class="display dash-title">Artist console</h1>
		<p class="dash-sub label">
			{data.artistEmail} · {dropCount} {dropCount === 1 ? 'drop' : 'drops'} · every count is a real pool total
		</p>
	</div>
	<div class="dash-cta">
		<PrimaryAction class="action--lg" href="/console/new">new drop</PrimaryAction>
		<span class="dash-cta-meta label">csv → live link in minutes</span>
	</div>
</header>

{#if dashNote}
	<p class="dash-note" bind:this={noteBox} tabindex="-1" role="alert">{dashNote}</p>
{/if}

{#if dropCount > 0}
	<ul class="drops">
		{#each data.projects as p (p.id)}
			{@const status = statusOf(p)}
			<li class="drops__slot">
				<article class="drop" aria-label="Drop panel: {p.title} by {p.artistName}">
					<a class="drop__title-link" href="/console/{p.id}">
						<span class="drop__title display">{p.title}</span>
						<span class="drop__artist label">by {p.artistName}</span>
					</a>
					<Panel
						label="drop status"
						sublabel="{p.stats.total} codes"
						tone={panelTone(p)}
						tag="コンソール"
					>
						<div class="drop__row">
							<div class="drop__art">
								<Artwork
									title={p.title}
									artistName={p.artistName}
									url={p.artworkUrl}
									status={p.artworkStatus}
								/>
							</div>
							<div class="drop__data">
								<StatusChip state={chipState(p)} />
								<SevenSegmentCount
									value={p.stats.available}
									pad={3}
									label="codes remaining"
									size="md"
									tone={countTone(p)}
								/>
							</div>
						</div>
						<SegmentedMeter
							available={p.stats.available}
							total={p.stats.total}
							state={meterState(p)}
							label="{p.title}: codes available"
						/>
						<p class="drop__stats label">
							{p.stats.claimed} claimed · {p.stats.reported} reported · {statusLine(p)}
						</p>
						{#if status === 'draft'}
							<p class="drop__share-note label">
								the share link activates when the drop goes live — upload its codes first
							</p>
						{:else}
							<CopyField compact value={shareUrl(p)} label="share link for {p.title}" />
						{/if}
						{#snippet footer()}
							<div class="drop__actions">
								{#if status === 'draft'}
									<GhostAction href="/console/{p.id}">upload codes</GhostAction>
								{:else}
									<GhostAction href="/p/{p.slug}" target="_blank" rel="noopener noreferrer">
										open page ↗
									</GhostAction>
								{/if}
								{#if status === 'active' || status === 'paused'}
									<GhostAction onclick={() => togglePause(p)} disabled={busyIds[p.id] === true}>
										{busyIds[p.id] ? 'switching…' : status === 'paused' ? 'resume drop' : 'pause drop'}
									</GhostAction>
								{/if}
								<GhostAction onclick={() => refreshArtwork(p)} disabled={refreshing[p.id] === true}>
									{refreshing[p.id] ? 'checking…' : 'refresh artwork'}
								</GhostAction>
							</div>
						{/snippet}
					</Panel>
				</article>
			</li>
		{/each}
	</ul>
{:else}
	<!-- first-run state: the header's launch slab is the screen's ONE primary
	     (same berth as a populated dashboard); this panel orients honestly and
	     its door is a ghost — never a second orange slab competing with the
	     journey's first step -->
	<Panel label="console status" sublabel="no drops" tag="コンソール">
		<h2 class="empty-title display">No drops yet</h2>
		<p class="empty-copy">
			The wall is waiting. Create a drop, paste your Bandcamp album page, upload the code
			CSV from Bandcamp's tools — and the share link goes live with a real count.
		</p>
		<div class="hazard empty-band" aria-hidden="true"></div>
		{#snippet footer()}
			<GhostAction href="/console/new">start the first drop</GhostAction>
		{/snippet}
	</Panel>
{/if}

<style>
	.dash-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--gap-4);
		flex-wrap: wrap;
		margin-bottom: var(--gap-5);
	}

	.dash-title {
		font-size: clamp(var(--step-4), 8vw, var(--step-6));
		margin-bottom: var(--gap-2);
	}

	.dash-sub {
		color: var(--text-muted);
		max-width: 52ch;
		overflow-wrap: anywhere;
	}

.dash-cta {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: var(--gap-2);
	/* holds the right berth on one line AND when the header wraps — the
	   launch slab never drifts left of the title block */
	margin-left: auto;
}

.dash-cta-meta {
	color: var(--text-muted);
	text-align: right;
}

@media (max-width: 480px) {
	/* the launch slab goes truly full-width on phones (the wrapper column
	   would otherwise shrink-wrap it) — same one-hand rule as every slab */
	.dash-cta {
		width: 100%;
	}
}

	.dash-note {
		border: 1px solid var(--hairline-alarm);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
		max-width: var(--measure);
		margin-bottom: var(--gap-4);
		outline: none;
	}

	/* --- drop panels ----------------------------------------------------------- */
	.drops {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--gap-4);
	}

	.drops__slot {
		display: flex;
	}

	.drop {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	/* the drop's identity heads its panel and opens the detail console */
	.drop__title-link {
		display: flex;
		flex-direction: column;
		gap: var(--gap-1);
		margin-bottom: var(--gap-2);
		text-decoration: none;
		min-width: 0;
	}

	.drop__title {
		font-size: var(--step-2);
		line-height: 1.04;
		color: var(--text);
		overflow-wrap: anywhere;
		transition: color 140ms ease-out;
	}

	.drop__title-link:hover .drop__title,
	.drop__title-link:focus-visible .drop__title {
		color: var(--orange-bright);
	}

	.drop__title-link:focus-visible {
		outline: none;
	}

	.drop__title-link:focus-visible .drop__title {
		outline: 2px solid var(--orange);
		outline-offset: 4px;
	}

	.drop__artist {
		color: var(--text-muted);
	}

	.drop :global(.panel) {
		flex: 1;
	}

	.drop__row {
		display: flex;
		gap: var(--gap-3);
		align-items: stretch;
	}

	.drop__art {
		flex: none;
		width: 96px;
	}

	.drop__data {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--gap-2);
	}

	.drop__stats {
		color: var(--text-muted);
	}

	.drop__share-note {
		color: var(--text-muted);
	}

	.drop__actions {
		display: flex;
		gap: var(--gap-2);
		flex-wrap: wrap;
	}

	/* --- honest empty state ------------------------------------------------------ */
	.empty-title {
		font-size: var(--step-3);
		margin-bottom: var(--gap-3);
	}

	.empty-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	.empty-band {
		height: 4px;
		opacity: 0.35;
		margin-top: var(--gap-4);
	}

	@media (min-width: 900px) {
		.drops {
			grid-template-columns: repeat(2, 1fr);
			gap: var(--gap-5);
		}
	}
</style>
