<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Artwork, GhostAction, Panel, SegmentedMeter, SevenSegmentCount, StatusChip } from '$lib/components';
	import { APP_NAME } from '$lib/brand';
	import type { PageData } from './$types';

	/**
	 * FE2 — the fan board: today's drop wall. One console frame (layout), a
	 * grid of live drop-cells — every artwork state, meter, and count below
	 * is REAL data from the public read model (src/lib/server/public.ts):
	 * no fabricated scarcity, no fake "hot right now", no placeholder art.
	 *
	 * Scoping (plan FE2): the board lists ACTIVE projects with codes left.
	 * Paused/draft/drain projects are not listed — a fan cannot claim from
	 * them — so every cell carries the green "available" chip; the amber
	 * paused / red drained chip semantics live on the project page
	 * (/p/[slug]), where those states are rendered honestly.
	 */
	let { data }: { data: PageData } = $props();

	/** Must mirror SegmentedMeter's internal LOW — one honest low-pool line. */
	const LOW_FRACTION = 0.15;
	const isLow = (available: number, total: number) => total > 0 && available / total <= LOW_FRACTION;

	/**
	 * Live feel without polling spam (design brief). CHOICE: availability is
	 * rendered from SSR data; the only client refresh is focus/visibility
	 * driven, throttled to one revalidation per 60 s. No interval, no
	 * websockets, no spinners — numbers change only when the server hands
	 * back new REAL counts. A user reading the wall never fires a request;
	 * a user who leaves and comes back gets fresh numbers once.
	 */
	const REFRESH_THROTTLE_MS = 60_000;
	let lastRefreshAt = Date.now(); // this component mounted = SSR data is fresh
	$effect(() => {
		const refreshIfStale = () => {
			if (document.visibilityState !== 'visible') return;
			if (Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;
			lastRefreshAt = Date.now();
			invalidateAll();
		};
		window.addEventListener('focus', refreshIfStale);
		document.addEventListener('visibilitychange', refreshIfStale);
		return () => {
			window.removeEventListener('focus', refreshIfStale);
			document.removeEventListener('visibilitychange', refreshIfStale);
		};
	});

	const liveCount = $derived(data.drops.length);

	/**
	 * Ghost-town moment (town-hall risk #5 — the launch-day state). The empty
	 * board is the wall BUILT, not broken: the status panel says what this
	 * console IS and holds both doors (fans wait; artists bring codes), and
	 * below it the wall's own hardware waits — unlit drop bays carrying the
	 * same 24-slot meter strip SegmentedMeter renders, at rest. Honesty rules
	 * hold absolutely: the bays are aria-hidden structure (no fabricated
	 * titles, counts, or artwork), the only numbers on screen are the real
	 * "0 live drops", and there is no waitlist/email capture (a non-goal).
	 */
	const BAY_SLOTS = 24; // mirrors SegmentedMeter's fixed strip width
	const BAY_COUNT = 3; // one row of the wall, at its widest grid
</script>

<svelte:head>
	<title>{APP_NAME} — live drop board</title>
	<meta
		name="description"
		content="Live Bandcamp download-code drops with real availability counts. One random code per fan, verified by email — claim from the wall, redeem on Bandcamp."
	/>
</svelte:head>

<h1 class="display board-title">Drop board</h1>
<p class="board-sub label">
	{liveCount} live {liveCount === 1 ? 'drop' : 'drops'} · every count is a real pool total
</p>

{#if liveCount > 0}
	<ul class="board">
		{#each data.drops as drop (drop.id)}
			<li class="board__slot">
				<article class="cell" aria-label="Drop: {drop.title} by {drop.artistName}">
					<Panel
						label={drop.title}
						sublabel="{drop.total} codes"
						tone={isLow(drop.available, drop.total) ? 'caution' : 'nominal'}
						tag="ドロップセル"
					>
						<div class="cell__row">
							<div class="cell__art">
								<Artwork
									title={drop.title}
									artistName={drop.artistName}
									url={drop.artworkUrl}
									status={drop.artworkStatus}
								/>
							</div>
							<div class="cell__who">
								<!-- The cell's single interactive element: the artist name,
								     stretched over the whole cell below (one tab stop per drop). -->
								<a class="cell__link display" href="/p/{drop.slug}" aria-label="Open drop by {drop.artistName}">
									{drop.artistName}
								</a>
								<StatusChip state="available" />
							</div>
						</div>
						<div class="cell__readout">
							<SevenSegmentCount
								value={drop.available}
								pad={3}
								label="codes remaining"
								size="lg"
								tone={isLow(drop.available, drop.total) ? 'orange' : 'green'}
							/>
							<SegmentedMeter
								available={drop.available}
								total={drop.total}
								state="active"
								label="{drop.title}: codes available"
							/>
						</div>
						{#snippet footer()}
							<span class="cell__claimed label">{drop.claimed} claimed</span>
							<span class="cell__open label" aria-hidden="true">open drop →</span>
						{/snippet}
					</Panel>
				</article>
			</li>
		{/each}
	</ul>
	<p class="board-note label">counts refresh when you come back to this tab</p>
{:else}
	<!-- role=status: the honest state is announced politely (a focus refresh
	     that swaps this for the live board needs no extra announcement) -->
	<div class="standby" role="status">
		<Panel label="wall status" sublabel="standby" tag="ドロップボード">
			<h2 class="empty-title display">No live drops</h2>
			<p class="empty-copy empty-copy--what">
				This wall carries free Bandcamp download codes. Artists load them here; each fan
				claims one per drop — verified once by email, no account.
			</p>
			<p class="empty-copy">
				When a drop goes live, its cell lights up below with a real codes-remaining count.
			</p>
			{#snippet footer()}
				<span class="empty-door label">fans — check back when a drop goes live</span>
				<GhostAction href="/console" class="empty-door-artists">artists — bring your codes</GhostAction>
			{/snippet}
		</Panel>
		<!-- The wall's unlit bays: the same grid the live board fills, each bay
		     carrying its 24-slot meter strip at rest. Pure structure, aria-hidden —
		     no fabricated titles, artwork, or counts; the phosphor ghost breathes
		     (the signature idle pulse) only where motion is allowed. -->
		<ul class="bays" aria-hidden="true">
			{#each Array(BAY_COUNT) as _, bay (bay)}
				<li class="bays__slot">
					<div class="bay">
						<div class="bay__strip">
							{#each Array(BAY_SLOTS) as _, slot (slot)}
								<span class="bay__well"><span class="bay__seg"></span></span>
							{/each}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.board-title {
		font-size: clamp(var(--step-4), 8vw, var(--step-6));
		margin-bottom: var(--gap-2);
	}

	.board-sub {
		margin-bottom: var(--gap-6);
	}

	/* The wall: one drop-cell per row on phones, a grid from tablet, dense
	   board (3-up) on wide consoles. Every row the board opens, it fills:
	   a trailing cell that would sit alone recomposes as a wide cell (the
	   @container block below) instead of idling beside dead ground. */
	.board {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--gap-4);
	}

	.board__slot {
		display: flex;
		/* the cell is its own layout context: wide cells (a trailing cell
		   spanning tracks, or a lone drop) recompose from its width, not the
		   viewport's — the same drop reads identically at any track size */
		container-type: inline-size;
	}

	.cell {
		position: relative; /* the stretched link's ::after fills this box */
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	/* equal-height cells inside each grid row */
	.cell :global(.panel) {
		flex: 1;
		transition: border-color 140ms ease-out;
	}

	/* groups inside the cell breathe (gap-4 between art row / readout /
	   footer) — the readout group itself stays tight (it is one instrument) */
	.cell :global(.panel__body) {
		gap: var(--gap-4);
	}

	.cell__row {
		display: flex;
		gap: var(--gap-3);
		align-items: stretch;
	}

	.cell__art {
		flex: none;
		width: 144px; /* phone: the cover is the payload, not a favicon */
	}

	.cell__who {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: var(--gap-2);
		align-items: flex-start;
	}

	/* count + meter: one instrument cluster. Tight gap inside (the count's
	   label sits between them), shared left edge — the readout well and the
	   slot strip both start at the group's origin. */
	.cell__readout {
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
	}

	.cell__link {
		font-size: var(--step-2);
		line-height: 1.04;
		color: var(--text);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	/* the whole cell is the click target */
	.cell__link::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 2;
	}

	/* focus traces the CELL (the world's machined focus), not the text box */
	.cell__link:focus-visible {
		outline: none;
	}

	.cell__link:focus-visible::after {
		outline: 2px solid var(--orange);
		outline-offset: -4px;
	}

	.cell__link:hover {
		color: var(--orange-bright);
	}

	.cell:has(.cell__link:hover) :global(.panel) {
		border-color: var(--hairline);
	}

	.cell__open {
		color: var(--orange);
		margin-inline-start: auto;
		transition: transform 140ms ease-out;
	}

	.cell:has(.cell__link:hover) .cell__open {
		transform: translateX(3px);
	}

	.cell__claimed {
		color: var(--text-muted);
	}

	.board-note {
		margin-top: var(--gap-4);
		color: var(--text-muted);
	}

	/* --- honest empty state: the wall BUILT, not broken (town-hall risk #5) ---
	   status panel (what this is + both doors) over the unlit bay row — the
	   same grid the live board fills, its meter strips at rest. No fake cells,
	   no spinner pretending, the only count on screen is the real 0. */
	.standby {
		display: flex;
		flex-direction: column;
	}

	.empty-title {
		font-size: var(--step-3);
		margin-bottom: var(--gap-3);
	}

	.empty-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	/* the first-visitor anchor: what this wall IS leads (matches the launch
	   view's what-a-code line, refine #1) */
	.empty-copy--what {
		font-weight: 520;
	}

	/* GhostAction renders its own element — reach across the component
	   boundary (the cell styles above do the same for .panel) */
	.standby :global(.empty-door-artists) {
		margin-inline-start: auto;
	}

	/* The unlit bays — the wall's own hardware waiting. Each bay is the cell
	   chassis at rest: panel ground, hairline boundary, its 24-slot meter
	   strip holding a 10% phosphor ghost (the unlit display, one step dimmer
	   than a live pool's unlit extent). Stacked under the status panel on the
	   same rhythm as the live board's grid. */
	.bays {
		list-style: none;
		margin: var(--gap-4) 0 0;
		padding: 0;
		display: grid;
		gap: var(--gap-4);
	}

	.bays__slot {
		display: flex;
	}

	.bay {
		flex: 1;
		display: flex;
		align-items: center;
		min-height: 64px;
		padding: var(--gap-3);
		background: var(--panel);
		border: 1px solid var(--hairline-dim);
	}

	/* slot wells are the meter's: inset ground, hairline edge */
	.bay__strip {
		display: flex;
		gap: 2px;
		width: 100%;
	}

	.bay__well {
		flex: 1 1 0;
		height: 14px;
		padding: 2px;
		border: 1px solid var(--hairline);
		background: var(--panel-inset);
		display: flex;
	}

	.bay__seg {
		flex: 1;
		/* the unlit display — phosphor at rest. One step dimmer than a live
		   pool's 15% unlit extent: an empty bay is less lit than a loaded one */
		background: rgba(255, 92, 26, 0.1);
	}

	/* SIGNATURE — the standby breathe: one motion for the whole moment. Each
	   bay's ghost swells and settles on the world's phosphor-pulse rhythm,
	   staggered left-to-right so the row reads as one bank warming up, not
	   three copies blinking. Gated: reduced-motion users get the static
	   ghost above; hidden tabs don't paint, so the loop costs nothing. */
	@media (prefers-reduced-motion: no-preference) {
		@keyframes bay-idle {
			0%,
			100% {
				opacity: 0.35;
			}
			50% {
				opacity: 1;
			}
		}

		.bay__seg {
			animation: bay-idle 3.2s ease-in-out infinite;
		}

		.bays__slot:nth-child(2) .bay__seg {
			animation-delay: -1.05s;
		}

		.bays__slot:nth-child(3) .bay__seg {
			animation-delay: -2.1s;
		}
	}

	@media (min-width: 768px) {
		.board {
			grid-template-columns: repeat(2, 1fr);
		}

		/* an odd trailing cell fills the row it opens (both tracks) */
		.board__slot:last-child:nth-child(odd) {
			grid-column: 1 / -1;
		}

		.cell__art {
			width: 120px;
		}

		/* the unlit bays follow the live board's grid — including its honest
		   fill: a trailing bay that would sit alone fills the row it opens */
		.bays {
			grid-template-columns: repeat(2, 1fr);
		}

		.bays__slot:last-child:nth-child(odd) {
			grid-column: 1 / -1;
		}
	}

	@media (max-width: 480px) {
		/* meters drop to 12px slots on phones; the bays keep the same anatomy */
		.bay__well {
			height: 12px;
		}
	}

	@media (min-width: 1200px) {
		.board {
			grid-template-columns: repeat(3, 1fr);
			gap: var(--gap-5);
		}

		/* the 2-col odd-trailing rule gives way to 3-col remainders:
		   count % 3 == 2 → last cell spans two tracks;
		   count % 3 == 1 → last cell spans the full row;
		   count % 3 == 0 → clean rows, no trailing cell to place */
		.board__slot:last-child:nth-child(odd) {
			grid-column: auto; /* reset of the 768 rule for 3n+3/3n counts */
		}

		.board__slot:last-child:nth-child(3n + 1) {
			grid-column: 1 / -1;
		}

			.board__slot:last-child:nth-child(3n + 2) {
				grid-column: span 2;
			}

		/* three bays = one full row of the widest wall (the 768 fill rule
		   resets here exactly as the board's does) */
		.bays {
			grid-template-columns: repeat(3, 1fr);
			gap: var(--gap-5);
		}

		.bays__slot:last-child:nth-child(odd) {
			grid-column: auto;
		}
	}

	/* Wide cell (>= 40rem container): a trailing cell that filled its row, or
	   a lone drop. The same payload recomposes horizontally — artwork left at
	   banner scale, identity above, the count+meter instrument grounded at the
	   art's bottom edge — so the width carries content instead of dead ground.
	   Cells at normal track width keep the stacked composition unchanged. */
	@container (min-width: 40rem) {
		.cell :global(.panel__body) {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			grid-template-rows: auto 1fr;
			gap: var(--gap-4) var(--gap-5);
		}

		.cell__row {
			display: contents; /* art and who place into the body grid */
		}

		.cell__art {
			grid-row: 1 / -1;
			align-self: start;
			width: 200px; /* banner scale — the cover leads the wide cell */
		}

		.cell__who {
			grid-column: 2;
			align-self: start;
		}

		.cell__readout {
			grid-column: 2;
			grid-row: 2;
			align-self: end; /* grounded at the artwork's bottom edge */
		}
	}
</style>
