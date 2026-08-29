<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Artwork,
		CopyField,
		GhostAction,
		LabeledField,
		Panel,
		PrimaryAction,
		SegmentedMeter,
		SevenSegmentCount,
		StatusChip
	} from '$lib/components';
	import { APP_NAME } from '$lib/brand';
	import {
		SessionLapsed,
		consoleFetch,
		consoleJsonBody,
		fmtSqlUtc,
		patchConsoleJson
	} from '$lib/console-client';
	import type { PageData } from './$types';

	/**
	 * FE5 — the project console: one drop's whole control surface.
	 *
	 *   overview  real stats + honest status + share link + pause/resume
	 *             (optimistic, rolled back on refusal) + artwork refresh
	 *   upload    the CSV well (drag-drop AND native picker — one input,
	 *             two ways in) with BE7's parse feedback verbatim: imported
	 *             count, duplicates skipped (in-file + already present),
	 *             invalid lines with numbers, and autofill candidates that
	 *             are OFFERED, never silently applied
	 *   details   title / artist / album-URL edits per BE7's rules (fields
	 *             editable in any state; the slug re-derives only while
	 *             draft; a changed album URL re-fetches the artwork)
	 *   ledger    recent claims (the artist's own code strings) + dead-code
	 *             reports (BE6)
	 *
	 * Everything renders from the SSR load; every action ends in
	 * invalidateAll() so the console never drifts from the server's truth.
	 */

	let { data }: { data: PageData } = $props();

	type Project = PageData['project'];
	type Status = Project['status'];

	const project = $derived(data.project);
	const shareUrl = $derived(`${page.url.origin}/p/${project.slug}`);

	/** Must mirror SegmentedMeter's internal LOW — one honest low-pool line. */
	const LOW_FRACTION = 0.15;
	const isLow = $derived(project.stats.total > 0 && project.stats.available / project.stats.total <= LOW_FRACTION);

	// --- overview semantics ------------------------------------------------------
	let optimisticStatus = $state<Status | null>(null);
	const status = $derived(optimisticStatus ?? project.status);

	const chipState = $derived(
		status === 'active' ? ('available' as const) : (status as 'paused' | 'drained' | 'draft')
	);
	const meterState = $derived(status === 'paused' || status === 'drained' ? status : ('active' as const));
	const countTone = $derived(
		status === 'drained' ? ('red' as const) : status === 'paused' || status === 'draft' || isLow ? ('orange' as const) : ('green' as const)
	);
	const panelTone = $derived(
		status === 'drained' ? ('alarm' as const) : status === 'paused' || status === 'draft' || isLow ? ('caution' as const) : ('nominal' as const)
	);

	const statusLine = $derived.by(() => {
		switch (status) {
			case 'draft':
				return 'draft — nothing is public yet; uploading the code CSV makes this drop live';
			case 'paused':
				return 'held — the pool waits; fans see the paused state on the project page';
			case 'drained':
				return `drained — all ${project.stats.total} codes claimed; uploading new codes re-activates`;
			default:
				return 'live on the wall';
		}
	});

	// --- notes (one region, focused after every action) --------------------------
	let note = $state('');
	let noteTone = $state<'status' | 'alert'>('status');
	let noteBox = $state<HTMLParagraphElement | undefined>(undefined);

	function say(text: string, tone: 'status' | 'alert' = 'status') {
		note = text;
		noteTone = tone;
		requestAnimationFrame(() => noteBox?.focus());
	}

	// --- pause/resume: optimistic with rollback -----------------------------------
	let switching = $state(false);

	async function togglePause() {
		if (switching || (status !== 'active' && status !== 'paused')) return;
		const from = status;
		const target: Status = from === 'paused' ? 'active' : 'paused';
		optimisticStatus = target;
		switching = true;
		try {
			const { res, body } = await patchConsoleJson(`/api/artist/projects/${project.id}`, { status: target });
			if (!res.ok) {
				optimisticStatus = null;
				say(body?.message ?? `The ${target === 'paused' ? 'pause' : 'resume'} was refused — the drop still reads ${from}.`, 'alert');
				return;
			}
			await invalidateAll();
			optimisticStatus = null; // the load's fresh status is the truth now
			say(target === 'paused' ? 'Held — the drop is paused.' : 'Resumed — the drop is live again.');
		} catch (error) {
			if (error instanceof SessionLapsed) return;
			optimisticStatus = null;
			say(`The ${target === 'paused' ? 'pause' : 'resume'} did not go through — the drop still reads ${from}.`, 'alert');
		} finally {
			switching = false;
		}
	}

	// --- artwork refresh -----------------------------------------------------------
	let refreshingArt = $state(false);

	async function refreshArtwork() {
		if (refreshingArt) return;
		refreshingArt = true;
		try {
			const res = await consoleFetch(`/api/artist/projects/${project.id}/refresh-artwork`, { method: 'POST' });
			const body = await consoleJsonBody(res);
			if (!res.ok) {
				say('The artwork check failed — try again in a moment.', 'alert');
				return;
			}
			const artworkStatus = (body as { artwork?: { status?: string } } | null)?.artwork?.status;
			say(
				artworkStatus === 'fetched'
					? 'Cover art fetched from the album page.'
					: 'No usable artwork on the album page — the honest text card stands in.'
			);
			await invalidateAll();
		} catch (error) {
			if (error instanceof SessionLapsed) return;
			say('The artwork check failed — try again in a moment.', 'alert');
		} finally {
			refreshingArt = false;
		}
	}

	// --- CSV upload: drag-drop + native picker, one input --------------------------------
	interface UploadFeedback {
		filename: string;
		parsed: number;
		inserted: number;
		duplicatesInFile: string[];
		duplicatesExisting: string[];
		invalidLines: { lineNumber: number; text: string }[];
		projectStatus: Status;
		/** The status BEFORE this upload — the "now live" line needs the jump. */
		before: Status;
		autofill: { title?: string; yumUrl?: string };
		applied: { title?: boolean; yumUrl?: boolean };
	}

	let fileInput = $state<HTMLInputElement | undefined>(undefined);
	let dragging = $state(false);
	let uploading = $state(false);
	let uploadError = $state('');
	let feedback = $state<UploadFeedback | null>(null);
	let dragDepth = 0;

	function openPicker() {
		fileInput?.click();
	}

	function onPickerChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		takeFile(input.files?.[0]);
		input.value = ''; // the same file can be picked again (dedupe feedback relies on it)
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragDepth = 0;
		dragging = false;
		takeFile(event.dataTransfer?.files?.[0]);
	}

	/** Enter/leave depth-counting so crossing child elements never flickers. */
	function onDragEnter(event: DragEvent) {
		event.preventDefault();
		dragDepth++;
		dragging = true;
	}

	function onDragLeave() {
		if (--dragDepth <= 0) {
			dragDepth = 0;
			dragging = false;
		}
	}

	function takeFile(file: File | undefined | null) {
		if (!file || uploading) return;
		const form = new FormData();
		form.append('file', file);
		void upload(form, file.name);
	}

	async function upload(form: FormData, filename: string) {
		uploading = true;
		uploadError = '';
		const before = status;
		try {
			const res = await consoleFetch(`/api/artist/projects/${project.id}/upload`, { method: 'POST', body: form });
			const body = await consoleJsonBody(res);
			if (!res.ok) {
				uploadError =
					body?.message ??
					(body?.error === 'file_too_large'
						? 'That file is over the ~2 MB limit — split the export and upload the parts.'
						: 'The upload failed — try again in a moment.');
				return;
			}
			const raw = body as Record<string, unknown>;
			feedback = {
				filename,
				parsed: Number(raw.parsed ?? 0),
				inserted: Number(raw.inserted ?? 0),
				duplicatesInFile: (raw.duplicatesInFile as string[]) ?? [],
				duplicatesExisting: (raw.duplicatesExisting as string[]) ?? [],
				invalidLines: (raw.invalidLines as UploadFeedback['invalidLines']) ?? [],
				projectStatus: (raw.projectStatus as Status) ?? project.status,
				before,
				autofill: (raw.autofill as UploadFeedback['autofill']) ?? {},
				applied: {}
			};
			requestAnimationFrame(() => feedbackBox?.focus());
			await invalidateAll();
		} catch (error) {
			if (error instanceof SessionLapsed) return;
			uploadError = 'The upload failed — try again in a moment.';
		} finally {
			uploading = false;
		}
	}

	let feedbackBox = $state<HTMLDivElement | undefined>(undefined);

	const skippedCount = $derived(
		feedback ? feedback.duplicatesInFile.length + feedback.duplicatesExisting.length : 0
	);

	// --- autofill candidates: offered, confirmed, never silent ----------------------------
	function hostOf(url: string): string {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	}

	async function applyAutofillTitle() {
		if (!feedback?.autofill.title) return;
		const candidate = feedback.autofill.title;
		const { res, body } = await patchConsoleJson(`/api/artist/projects/${project.id}`, { title: candidate });
		if (!res.ok) {
			say(body?.message ?? 'Applying the file’s title failed — try again.', 'alert');
			return;
		}
		feedback = { ...feedback, applied: { ...feedback.applied, title: true } };
		title = candidate; // the edit form must mirror what was just applied
		editErrors = {};
		await invalidateAll();
		say(`Title applied from the CSV: “${candidate}”.`);
	}

	async function applyAutofillYum() {
		if (!feedback?.autofill.yumUrl) return;
		// The candidate is the code set's redeem page (…/yum on the artist's
		// subdomain). Applying it means: move THIS project's album page to
		// that subdomain (path preserved), which re-derives the yum URL and
		// re-fetches the artwork — BE7/BE8's own pipeline.
		let next: URL;
		try {
			next = new URL(project.albumUrl);
			next.host = hostOf(feedback.autofill.yumUrl);
		} catch {
			say('That redeem URL could not be applied — check the drop’s album URL by hand.', 'alert');
			return;
		}
		const { res, body } = await patchConsoleJson(`/api/artist/projects/${project.id}`, { albumUrl: next.toString() });
		if (!res.ok) {
			say(body?.message ?? 'Applying the file’s redeem page failed — try again.', 'alert');
			return;
		}
		feedback = { ...feedback, applied: { ...feedback.applied, yumUrl: true } };
		albumUrl = next.toString(); // the edit form must mirror what was just applied
		editErrors = {};
		await invalidateAll();
		say(`Album page moved to ${next.host} to match the codes — artwork re-fetching.`);
	}

	// --- details edit form -------------------------------------------------------------------
	let loadedId = $state(0);
	let title = $state('');
	let artistName = $state('');
	let albumUrl = $state('');
	let editErrors = $state<{ title?: string; artistName?: string; albumUrl?: string }>({});
	let saving = $state(false);

	// Reset the form when the console navigates to a different project; a
	// same-project invalidate never clobbers in-progress edits.
	$effect(() => {
		if (data.project.id !== loadedId) {
			loadedId = data.project.id;
			title = data.project.title;
			artistName = data.project.artistName;
			albumUrl = data.project.albumUrl;
			editErrors = {};
		}
	});

	async function saveDetails(event: SubmitEvent) {
		event.preventDefault();
		editErrors = {};
		const patch: Record<string, string> = {};
		if (title.trim() !== project.title) patch.title = title.trim();
		if (artistName.trim() !== project.artistName) patch.artistName = artistName.trim();
		if (albumUrl.trim() !== project.albumUrl) patch.albumUrl = albumUrl.trim();
		if (Object.keys(patch).length === 0) {
			say('Nothing changed — the stored details already read exactly this.');
			return;
		}
		saving = true;
		try {
			const { res, body } = await patchConsoleJson(`/api/artist/projects/${project.id}`, patch);
			if (!res.ok) {
				switch (body?.error) {
					case 'invalid_title':
						editErrors = { title: 'That title cannot be stored — keep it to 200 characters.' };
						break;
					case 'invalid_artist_name':
						editErrors = { artistName: 'That artist name cannot be stored — keep it to 200 characters.' };
						break;
					case 'invalid_album_url':
						editErrors = { albumUrl: body?.message ?? 'The album URL must be a bandcamp.com page.' };
						break;
					default:
						say(body?.message ?? 'The save failed — try again in a moment.', 'alert');
				}
				return;
			}
			await invalidateAll();
			say(
				'albumUrl' in patch
					? 'Saved — the new album page’s artwork is fetching now.'
					: 'Saved.'
			);
		} catch (error) {
			if (error instanceof SessionLapsed) return;
			say('The save failed — try again in a moment.', 'alert');
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{project.title} — console · {APP_NAME}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<a class="back label" href="/console">← console</a>

<header class="head">
	<div class="head__art">
		<Artwork
			title={project.title}
			artistName={project.artistName}
			url={project.artworkUrl}
			status={project.artworkStatus}
		/>
	</div>
	<div class="head__id">
		<h1 class="display head__title">{project.title}</h1>
		<p class="head__artist label">by {project.artistName}</p>
		<div class="head__chips">
			<StatusChip state={chipState} />
			<a class="head__album label" href={project.albumUrl} target="_blank" rel="noopener noreferrer">
				album page ↗
			</a>
		</div>
	</div>
</header>

{#if note}
	<p class="note" class:note--alert={noteTone === 'alert'} bind:this={noteBox} tabindex="-1" role={noteTone === 'alert' ? 'alert' : 'status'}>
		{note}
	</p>
{/if}

<!-- --- overview: the drop's live state --------------------------------------- -->
{#snippet overviewFoot()}
	<div class="actions">
		{#if status === 'draft'}
			<GhostAction onclick={openPicker}>upload codes</GhostAction>
		{:else}
			<GhostAction href="/p/{project.slug}" target="_blank" rel="noopener noreferrer">open page ↗</GhostAction>
		{/if}
		{#if status === 'active' || status === 'paused'}
			<GhostAction onclick={togglePause} disabled={switching}>
				{switching ? 'switching…' : status === 'paused' ? 'resume drop' : 'pause drop'}
			</GhostAction>
		{/if}
		<GhostAction onclick={refreshArtwork} disabled={refreshingArt}>
			{refreshingArt ? 'checking…' : 'refresh artwork'}
		</GhostAction>
	</div>
{/snippet}

<Panel
	label="drop status"
	sublabel="{project.stats.total} codes"
	tone={panelTone}
	tag="状況"
	footer={overviewFoot}
>
	<div class="overview">
		<SevenSegmentCount
			value={project.stats.available}
			pad={3}
			label="codes remaining"
			size="lg"
			tone={countTone}
		/>
		<SegmentedMeter
			available={project.stats.available}
			total={project.stats.total}
			state={meterState}
			label="{project.title}: codes available"
		/>
		<p class="stats label">
			{project.stats.claimed} claimed · {project.stats.reported} reported · {statusLine}
		</p>
		{#if status === 'draft'}
			<p class="share-note label">
				the share link activates when the drop goes live — upload its codes below
			</p>
		{:else}
			<CopyField value={shareUrl} label="share link" />
			<p class="share-hint label">this is the link for your socials, newsletter, dms — it always shows the honest state</p>
		{/if}
	</div>
</Panel>

<!-- --- upload: the CSV well + parse feedback --------------------------------- -->
<Panel label="code batches" sublabel="bandcamp csv export" tone="default" tag="投入">
<!-- QA3 a11y: the dropzone is a <label> whose native file input covers the
     whole zone — ONE interactive control (click, Enter/Space, drag all hit
     it), replacing the old role="button" wrapper around the input that
     nested two interactives (axe: nested-interactive). -->
<label
	class="dropzone"
	class:dropzone--over={dragging}
	class:dropzone--busy={uploading}
	ondragover={(event) => event.preventDefault()}
	ondragenter={onDragEnter}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	<input
		class="dropzone__native"
		type="file"
		accept=".csv,text/csv,text/plain"
		aria-label="Upload a Bandcamp CSV export"
		disabled={uploading}
		bind:this={fileInput}
		onchange={onPickerChange}
	/>
	<span class="dropzone__line display">{uploading ? 'reading…' : 'drop the csv export here'}</span>
	<span class="dropzone__sub label">
		{uploading ? 'parsing codes' : 'or press enter to browse — bandcamp tools → “get codes” csv'}
	</span>
</label>
	<p class="upload-hint label">
		duplicates are skipped automatically · re-uploading the same file adds nothing ·
		{#if status === 'paused'}codes land but the pause holds — resume when ready{:else}uploading makes a draft or drained drop live{/if}
	</p>

	{#if uploadError}
		<p class="upload-error" role="alert">{uploadError}</p>
	{/if}

	{#if feedback}
		<div class="feedback" bind:this={feedbackBox} tabindex="-1" role="region" aria-label="upload feedback">
			<div class="feedback__head">
				<SevenSegmentCount value={feedback.inserted} pad={3} label="codes imported" size="md" tone={feedback.inserted > 0 ? 'green' : 'orange'} />
				<span class="feedback__file label">{feedback.filename}</span>
			</div>
			<p class="feedback__line">
				{feedback.inserted} of {feedback.parsed} parsed {feedback.inserted === 1 ? 'code' : 'codes'} imported{feedback.before === 'draft' && feedback.projectStatus === 'active'
					? ' — the drop is now live on the wall'
					: feedback.before === 'drained' && feedback.projectStatus === 'active'
						? ' — the drop re-activated'
						: ''}.
			</p>
			{#if skippedCount > 0}
				<p class="feedback__line">
					{skippedCount} {skippedCount === 1 ? 'code was' : 'codes were'} skipped as duplicates
					({feedback.duplicatesExisting.length} already in the pool
					{feedback.duplicatesInFile.length > 0 ? `, ${feedback.duplicatesInFile.length} repeated inside the file` : ''}).
				</p>
			{/if}
			{#if feedback.duplicatesExisting.length > 0}
				<p class="feedback__codes label">{feedback.duplicatesExisting.join(' · ')}</p>
			{/if}
			{#if feedback.invalidLines.length > 0}
				<div class="feedback__invalid">
					<p class="feedback__line">{feedback.invalidLines.length} unrecognizable {feedback.invalidLines.length === 1 ? 'line was' : 'lines were'} left out:</p>
					<ul class="feedback__lines">
						{#each feedback.invalidLines as line (line.lineNumber)}
							<li><span class="label">line {line.lineNumber}</span> <code>{line.text}</code></li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if feedback.autofill.title && !feedback.applied.title}
				<div class="autofill">
					<p class="autofill__copy">
						This file’s header names the album <strong>“{feedback.autofill.title}”</strong> — the drop
						currently reads <strong>“{project.title}”</strong>.
					</p>
					<GhostAction onclick={applyAutofillTitle}>use the file’s title</GhostAction>
				</div>
			{/if}
			{#if feedback.autofill.yumUrl && !feedback.applied.yumUrl}
				<div class="autofill">
					<p class="autofill__copy">
						These codes redeem at <strong>{hostOf(feedback.autofill.yumUrl)}</strong> — this drop’s
						album page sits on <strong>{hostOf(project.albumUrl)}</strong>.
					</p>
					<GhostAction onclick={applyAutofillYum}>match the album page</GhostAction>
				</div>
			{/if}
			{#if feedback.applied.title || feedback.applied.yumUrl}
				<p class="feedback__line label">
					applied: {feedback.applied.title ? 'title' : ''}{feedback.applied.title && feedback.applied.yumUrl ? ' + ' : ''}{feedback.applied.yumUrl ? 'album page' : ''}
				</p>
			{/if}
		</div>
	{/if}
</Panel>

<!-- --- details edit ---------------------------------------------------------- -->
{#snippet detailsFoot()}
	<div class="actions">
		<PrimaryAction type="submit" form="details-form" disabled={saving}>
			{saving ? 'saving…' : 'save changes'}
		</PrimaryAction>
	</div>
{/snippet}

<Panel label="drop details" sublabel="editable" tone="default" tag="詳細" footer={detailsFoot}>
	<form class="form" id="details-form" onsubmit={saveDetails} novalidate>
		<LabeledField
			label="drop title"
			hint={project.status === 'draft'
				? 'draft: renaming also re-derives the share link'
				: 'live: the share link is locked — renaming does not move it'}
			error={editErrors.title}
			bind:value={title}
			type="text"
			name="title"
			maxlength={200}
		/>
		<LabeledField
			label="artist name"
			hint={project.status === 'draft'
				? 'draft: with the title, it derives the share link'
				: 'heads the drop cell on the wall'}
			error={editErrors.artistName}
			bind:value={artistName}
			type="text"
			name="artistName"
			maxlength={200}
		/>
		<LabeledField
			label="bandcamp album url"
			hint="changing it re-derives the redeem link and re-fetches the cover art"
			error={editErrors.albumUrl}
			bind:value={albumUrl}
			type="url"
			name="albumUrl"
			inputmode="url"
		/>
	</form>
</Panel>

<!-- --- ledger: claims + reports ------------------------------------------------ -->
<Panel
	label="recent claims"
	sublabel="newest first · latest 20"
	tone="default"
	tag="引換"
>
	{#if project.recentClaims.length > 0}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- the scrollable region is focusable on purpose: keyboard users must be
		     able to scroll the table sideways on phones (WCAG 2.1, focus-order
		     for scrollable regions) — it carries an accessible name above -->
		<div class="table-wrap" role="region" aria-label="Recent claims table — scrolls horizontally on small screens" tabindex={0}>
			<table class="ledger">
				<caption class="sr-only">Most recent claims on this drop, newest first — the codes this drop handed out</caption>
				<thead>
					<tr>
						<th scope="col">code</th>
						<th scope="col">state</th>
						<th scope="col">claim</th>
						<th scope="col">when (utc)</th>
					</tr>
				</thead>
				<tbody>
					{#each project.recentClaims as claim (claim.claimId)}
						<tr>
							<td><code class="code">{claim.code}</code></td>
							<td>{claim.codeStatus === 'reported' ? 'dead — reported' : 'live with a fan'}</td>
							<td>{claim.kind === 'reissue' ? 'replacement' : 'original'}</td>
							<td class="when">{fmtSqlUtc(claim.claimedAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="table-note label">codes are shown to you, the artist — fans only ever see their own</p>
	{:else}
		<p class="empty-copy">No claims yet — the moment a fan launches a claim, their code appears here.</p>
	{/if}
</Panel>

<Panel
	label="dead-code reports"
	sublabel="{project.reports.reportCount} {project.reports.reportCount === 1 ? 'report' : 'reports'}"
	tone={project.reports.reportCount > 0 ? 'caution' : 'default'}
	tag="報告"
>
	{#if project.reports.reports.length > 0}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- same focusable-scroll rationale as the claims table above -->
		<div class="table-wrap" role="region" aria-label="Dead-code reports table — scrolls horizontally on small screens" tabindex={0}>
			<table class="ledger">
				<caption class="sr-only">Dead-code reports on this drop, newest first — each fan got at most one replacement</caption>
				<thead>
					<tr>
						<th scope="col">reported code</th>
						<th scope="col">when (utc)</th>
						<th scope="col">fan’s note</th>
						<th scope="col">replacement</th>
					</tr>
				</thead>
				<tbody>
					{#each project.reports.reports as report (report.reportId)}
						<tr>
							<td><code class="code">{report.code}</code></td>
							<td class="when">{fmtSqlUtc(report.reportedAt)}</td>
							<td class="note-cell">{report.reason ?? '—'}</td>
							<td>{report.reissued ? `issued ${fmtSqlUtc(report.reissuedAt)}` : 'none — pool was empty'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="table-note label">a reported code is never dispensed again</p>
	{:else}
		<p class="empty-copy">No dead-code reports — every claimed code is redeeming clean.</p>
	{/if}
</Panel>

<Panel label="removal" sublabel="mvp" tone="caution" tag="削除">
	<p class="empty-copy">
		Drops cannot be deleted in this build. A drained drop honestly reads drained on the
		wall, pausing holds a live one, and a draft publishes nothing — nothing is destroyed,
		nothing pretends to be gone.
	</p>
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

	/* --- header: artwork-led identity ------------------------------------------- */
	.head {
		display: grid;
		grid-template-columns: 140px minmax(0, 1fr);
		gap: var(--gap-4);
		align-items: start;
		margin-bottom: var(--gap-5);
	}

	.head__id {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--gap-2);
		min-width: 0;
	}

	.head__title {
		font-size: clamp(var(--step-3), 6vw, var(--step-5));
		overflow-wrap: anywhere;
	}

	.head__artist {
		color: var(--text-muted);
	}

	.head__chips {
		display: flex;
		align-items: center;
		gap: var(--gap-3);
		flex-wrap: wrap;
	}

	.head__album {
		color: var(--orange);
		text-decoration: underline;
		text-underline-offset: 0.22em;
		text-decoration-thickness: 1px;
	}

	.head__album:hover {
		color: var(--orange-bright);
	}

	/* --- note region (focused after actions) ------------------------------------- */
	.note {
		border: 1px solid var(--hairline-green);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
		max-width: var(--measure);
		margin-bottom: var(--gap-4);
		outline: none;
	}

	.note--alert {
		border-color: var(--hairline-alarm);
	}

	/* --- overview ------------------------------------------------------------------ */
	.overview {
		display: flex;
		flex-direction: column;
		gap: var(--gap-3);
		align-items: flex-start;
	}

	.stats {
		color: var(--text-muted);
	}

	.share-note {
		color: var(--text-muted);
	}

	.share-hint {
		color: var(--text-muted);
	}

	.actions {
		display: flex;
		gap: var(--gap-2);
		flex-wrap: wrap;
	}

	/* --- upload ---------------------------------------------------------------------- */
	.dropzone {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
		align-items: center;
		justify-content: center;
		text-align: center;
		min-height: 9rem;
		padding: var(--gap-4);
		background: var(--panel-inset);
		border: 1px dashed var(--hairline);
		cursor: pointer;
		transition:
			border-color 140ms ease-out,
			background-color 140ms ease-out;
	}

	.dropzone:hover,
	.dropzone:focus-visible,
	.dropzone--over {
		border-color: var(--orange);
	}

	.dropzone:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: 3px;
	}

	.dropzone--over {
		background: rgba(255, 92, 26, 0.05);
		border-style: solid;
	}

	.dropzone--busy {
		cursor: wait;
	}

	.dropzone--busy .dropzone__line {
		color: var(--text-muted);
	}

	/* the native input: programmatic only — the zone is the keyboard's button */
	/* QA3: the native input IS the zone's interactive surface — it covers the
	   whole dropzone (click / Enter / Space / drag all land on it), invisible
	   but focusable; the global :focus-visible ring then traces the zone. */
	.dropzone__native {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: pointer;
	}

	.dropzone__native:focus-visible {
		outline: 2px solid var(--orange);
		outline-offset: -4px;
	}

	.dropzone__native:disabled {
		cursor: wait;
	}

	.dropzone__line {
		font-size: var(--step-2);
		color: var(--text);
	}

	.dropzone__sub {
		color: var(--text-muted);
	}

	.upload-hint {
		color: var(--text-muted);
	}

	.upload-error {
		border: 1px solid var(--hairline-alarm);
		background: var(--panel-inset);
		padding: var(--gap-2) var(--gap-3);
		color: var(--text);
		max-width: var(--measure);
	}

	/* --- parse feedback --------------------------------------------------------------- */
	.feedback {
		display: flex;
		flex-direction: column;
		gap: var(--gap-3);
		border-top: 1px solid var(--hairline-dim);
		padding-top: var(--gap-4);
		margin-top: var(--gap-2);
		outline: none;
	}

	.feedback__head {
		display: flex;
		align-items: flex-end;
		gap: var(--gap-4);
		flex-wrap: wrap;
	}

	.feedback__file {
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.feedback__line {
		max-width: var(--measure);
		color: var(--text);
	}

	.feedback__codes {
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.feedback__lines {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--gap-1);
		max-width: var(--measure);
	}

	.feedback__lines li {
		display: flex;
		gap: var(--gap-3);
		align-items: baseline;
		min-width: 0;
	}

	.feedback__lines code {
		font-family: var(--font-mono);
		font-size: var(--step--1);
		color: var(--text);
		overflow-wrap: anywhere;
	}

	.autofill {
		display: flex;
		flex-direction: column;
		gap: var(--gap-2);
		align-items: flex-start;
		border: 1px solid var(--hairline);
		background: var(--panel-inset);
		padding: var(--gap-3);
		max-width: var(--measure);
	}

	.autofill__copy {
		color: var(--text);
	}

	.autofill__copy strong {
		color: var(--orange-bright);
		font-weight: 620;
	}

	/* --- details form -------------------------------------------------------------------- */
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--gap-4);
		max-width: 34rem;
	}

	/* --- ledger tables ---------------------------------------------------------------------- */
	.table-wrap {
		overflow-x: auto;
		border: 1px solid var(--hairline-dim);
		background: var(--panel-inset);
	}

	.ledger {
		border-collapse: collapse;
		width: 100%;
		min-width: 34rem; /* phones scroll the region — honest, labeled */
	}

	.ledger th,
	.ledger td {
		padding: var(--gap-2) var(--gap-3);
		text-align: left;
		vertical-align: top;
		font-size: var(--step--1);
		color: var(--text);
		border-bottom: 1px solid var(--hairline-dim);
	}

	.ledger thead th {
		font-family: var(--font-mono);
		font-size: var(--step--2);
		font-weight: 520;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.ledger tbody tr:last-child td {
		border-bottom: none;
	}

	.ledger .code {
		font-family: var(--font-mono);
		font-weight: 620;
		letter-spacing: 0.08em;
		color: var(--orange);
		white-space: nowrap;
	}

	.ledger .when {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.ledger .note-cell {
		max-width: 32ch;
		overflow-wrap: anywhere;
	}

	.table-note {
		color: var(--text-muted);
	}

	.empty-copy {
		max-width: var(--measure);
		color: var(--text);
	}

	/* screen-reader-only caption (the panel label carries the visual heading) */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (min-width: 768px) {
		.head {
			grid-template-columns: 200px minmax(0, 1fr);
			gap: var(--gap-5);
		}
	}
</style>
