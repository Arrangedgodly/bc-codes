<script lang="ts">
	/**
	 * Artwork — the drop-cell's visual payload, honoring BE8's artwork_status
	 * tri-state instead of trusting any URL:
	 *
	 *   fetched          → the image (R2 route /art/<id>, or the CDN hotlink
	 *                      fallback BE8 writes when R2 is unavailable)
	 *   fallback         → the text-card: title + artist in the world's type,
	 *                      honest "no artwork" register — never a placeholder
	 *                      image, never a spinner pretending work is happening
	 *   pending          → the text-card with an "artwork fetching" micro line
	 *                      (the async BE8 fetch has not landed yet)
	 *
	 * A fetched image that fails to load (CDN rotation, R2 eviction) degrades
	 * to the text-card in place — same box, so no layout shift on the swap.
	 * The box is always a fixed square (aspect-ratio), so SSR reserves the
	 * space and fonts/images never shift the board.
	 */
	let {
		title,
		artistName,
		url = null,
		status
	}: {
		title: string;
		artistName: string;
		/** projects.artwork_url — null unless status is 'fetched'. */
		url?: string | null;
		status: 'pending' | 'fetched' | 'fallback';
	} = $props();

	/** The URL that last failed to load — a later url change un-fails the cell. */
	let failedUrl = $state('');
	const showImage = $derived(status === 'fetched' && url !== null && url !== failedUrl);
</script>

{#if showImage}
	<figure class="art">
		<img
			class="art__img"
			src={url}
			alt="Album cover — {title} by {artistName}"
			loading="lazy"
			decoding="async"
			onerror={() => (failedUrl = url ?? '')}
		/>
	</figure>
{:else}
	<figure class="art art--card">
		<!-- bilingual micro-label: decorative only -->
		<span class="art__tag micro" aria-hidden="true">ジャケット</span>
		<span class="art__card-title">{title}</span>
		<span class="art__card-artist label">{artistName}</span>
		<span class="art__card-state label">{status === 'pending' ? 'artwork fetching' : 'no artwork'}</span>
	</figure>
{/if}

<style>
	/* One square box in both branches — the swap never moves the board. */
	.art {
		position: relative;
		aspect-ratio: 1;
		width: 100%;
		margin: 0;
		overflow: hidden;
		background: var(--panel-inset);
		border: 1px solid var(--hairline-dim);
		container-type: inline-size;
	}

	.art__img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	/* Text-card fallback: the drop's identity in the world's own type. */
	.art--card {
		display: grid;
		grid-template-rows: auto 1fr auto auto;
		gap: var(--gap-1);
		padding: var(--gap-2);
		text-align: left;
		align-items: start;
	}

	.art__tag {
		justify-self: end;
	}

	/* Title carries the card: display caps, scaled to the card, clamped so a
	   200-char title cannot blow the square (the Panel head carries the full
	   title — the clamp hides nothing the fan can't read). */
	.art__card-title {
		overflow: hidden;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		align-self: center;
		font-family: var(--font-display);
		font-weight: 400;
		text-transform: uppercase;
		line-height: 1.02;
		letter-spacing: 0.015em;
		color: var(--text);
		font-size: clamp(0.9rem, 17cqi, var(--step-3));
	}

	.art__card-artist {
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.art__card-state {
		color: var(--orange);
		border-top: 1px solid var(--hairline-dim);
		padding-top: var(--gap-1);
	}

	/* Small cards (board cells at 120–144px): the full card's three text rows
	   cannot fit a square that size — the JP tag and artist line drop out
	   (both live right beside the card in the drop-cell anyway) and the title
	   clamps tighter at the data step. Larger uses (/p/[slug] at 200px) keep
	   the full card. */
	@container (max-width: 159px) {
		.art__tag,
		.art__card-artist {
			display: none;
		}

		.art__card-title {
			-webkit-line-clamp: 2;
			line-clamp: 2;
			font-size: var(--step--1);
		}
	}
</style>
