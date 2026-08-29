<script lang="ts">
	import { goto } from '$app/navigation';
	import { GhostAction, LabeledField, Panel, PrimaryAction } from '$lib/components';
	import { APP_NAME } from '$lib/brand';
	import { SessionLapsed, postConsoleJson } from '$lib/console-client';
	import type { PageData } from './$types';

	/**
	 * FE5 — new drop. Three fields and one honest promise: the drop is
	 * created as a DRAFT (nothing public), artwork fetches itself from the
	 * album page after creation, and the CSV upload on the next screen is
	 * what makes it live. Client-side validation mirrors BE7's rules
	 * (bandcamp.com album URL, one artist label); the server's own refusal
	 * is always rendered verbatim under the offending field.
	 */

	let { data }: { data: PageData } = $props();

	let title = $state('');
	let artistName = $state('');
	let albumUrl = $state('');
	let errors = $state<{ title?: string; artistName?: string; albumUrl?: string }>({});
	let busy = $state(false);
	let note = $state('');

	/** Same shape BE7 enforces — one label under bandcamp.com, no www. */
	function validAlbumUrl(input: string): boolean {
		try {
			const url = new URL(input.trim());
			if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
			return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bandcamp\.com$/i.test(url.hostname) && url.hostname.split('.')[0] !== 'www';
		} catch {
			return false;
		}
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		note = '';
		errors = {};
		const next: typeof errors = {};
		if (title.trim().length === 0) next.title = 'The drop needs a title — what the fans will see.';
		if (artistName.trim().length === 0) next.artistName = 'The artist name heads the drop cell and feeds the share link.';
		if (!validAlbumUrl(albumUrl)) next.albumUrl = 'A bandcamp.com album page — e.g. https://yourname.bandcamp.com/album/your-album.';
		if (Object.keys(next).length > 0) {
			errors = next;
			return;
		}
		busy = true;
		try {
			const { res, body } = await postConsoleJson('/api/artist/projects', {
				title: title.trim(),
				artistName: artistName.trim(),
				albumUrl: albumUrl.trim()
			});
			if (res.ok && body && typeof (body as { project?: { id?: number } }).project?.id === 'number') {
				await goto(`/console/${(body as { project: { id: number } }).project.id}`);
				return;
			}
			switch (body?.error) {
				case 'invalid_title':
					errors = { title: 'That title cannot be stored — keep it to 200 characters.' };
					break;
				case 'invalid_artist_name':
					errors = { artistName: 'That artist name cannot be stored — keep it to 200 characters.' };
					break;
				case 'invalid_album_url':
					errors = { albumUrl: body?.message ?? 'The album URL must be a bandcamp.com page.' };
					break;
				default:
					note = 'The create failed — wait a moment and try again.';
			}
		} catch (error) {
			if (error instanceof SessionLapsed) return;
			note = 'The create failed — wait a moment and try again.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>New drop · {APP_NAME}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<a class="back label" href="/console">← console</a>

<h1 class="display page-title">New drop</h1>
<p class="page-sub label">draft first · codes make it live</p>

{#snippet foot()}
	<div class="form-foot">
		<PrimaryAction type="submit" form="new-drop-form" disabled={busy}>
			{busy ? 'creating…' : 'create drop'}
		</PrimaryAction>
		<GhostAction href="/console">cancel</GhostAction>
	</div>
{/snippet}

<Panel label="drop details" sublabel="3 fields" tone="default" tag="新規" footer={foot}>
	<p class="intro-copy">
		Three fields now, then the CSV on the next screen. The drop is created as a draft —
		nothing appears on the wall until its codes are uploaded.
	</p>
	<form class="form" id="new-drop-form" onsubmit={create} novalidate>
		<LabeledField
			label="drop title"
			hint="the album or release name, as fans should read it on the wall"
			error={errors.title}
			bind:value={title}
			type="text"
			name="title"
			maxlength={200}
			placeholder="Taxed, Tolled & Eternally Trolled"
		/>
		<LabeledField
			label="artist name"
			hint="heads the drop cell · with the title, it derives the share link"
			error={errors.artistName}
			bind:value={artistName}
			type="text"
			name="artistName"
			maxlength={200}
			placeholder="arrangedgodly"
		/>
		<LabeledField
			label="bandcamp album url"
			hint="the album page on bandcamp.com — the redeem (yum) link derives from it"
			error={errors.albumUrl}
			bind:value={albumUrl}
			type="url"
			name="albumUrl"
			autocomplete="url"
			inputmode="url"
			placeholder="https://yourname.bandcamp.com/album/your-album"
		/>
	</form>
	<p class="artwork-note">
		Cover art is fetched automatically from the album page after creation — if none is
		found, the drop shows an honest text card. You can re-check it any time from the
		drop's console.
	</p>
	{#if note}
		<p class="form-note" role="alert">{note}</p>
	{/if}
</Panel>

<style>
	.back {
		display: inline-block;
		color: var(--text-muted);
		text-decoration: none;
		border-bottom: 1px solid var(--hairline);
		padding-bottom: 2px;
		transition:
			color 140ms ease-out,
			border-color 140ms ease-out;
	}

	.back:hover {
		color: var(--orange-bright);
		border-color: var(--orange);
	}

	.page-title {
		font-size: clamp(var(--step-4), 8vw, var(--step-6));
		margin-bottom: var(--gap-2);
	}

	.page-sub {
		margin-bottom: var(--gap-6);
	}

	.intro-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: var(--gap-4);
		max-width: 34rem;
	}

	.artwork-note {
		max-width: var(--measure);
		font-size: var(--step--1);
		color: var(--text-muted);
		border-top: 1px solid var(--hairline-dim);
		padding-top: var(--gap-3);
	}

	.form-foot {
		display: flex;
		gap: var(--gap-3);
		align-items: center;
		flex-wrap: wrap;
	}

	.form-note {
		border: 1px solid var(--hairline-alarm);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
		max-width: var(--measure);
	}
</style>
