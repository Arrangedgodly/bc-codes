/**
 * Public fan-board read model tests (FE2) — src/lib/server/public.ts against
 * the real D1 binding (vitest inside workerd; migrations applied by
 * tests/setup.ts). No HTTP layer: the module is the contract.
 *
 * The public model is a SECURITY boundary as much as a query — the tests pin:
 *   - scoping: the board lists ACTIVE + AVAILABLE projects only (draft,
 *     paused, drained, and transient active-but-empty pools never render);
 *   - payload hygiene: no code string, claim row, fan hash, or artist email
 *     can appear in a public payload — checked structurally (key set) and
 *     by content (seeded code strings absent from the serialized output);
 *   - honesty: counts are the real derived pool numbers (available/claimed/
 *     reported/total), artwork tri-state passes through as BE8 wrote it.
 *
 * Storage persists across test files, so emails/slugs derive from a global
 * counter and every assertion is scoped to this file's seeded slugs (other
 * files' projects may legitimately be on the wall).
 */

import { env as bindings } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BOARD_LIMIT, getPublicProjectBySlug, listPublicDrops } from '../src/lib/server/public';

let seq = 0;

interface SeedOptions {
	status?: 'draft' | 'active' | 'paused' | 'drained';
	available?: number;
	claimed?: number;
	reported?: number;
	artworkUrl?: string | null;
	artworkStatus?: 'pending' | 'fetched' | 'fallback';
	createdAt?: string;
}

/** A distinct code prefix per seed — proves code strings never leak publicly. */
function codeFor(slugSeed: number, klass: 'a' | 'c' | 'r', i: number): string {
	return `pb${slugSeed}${klass}-${String(i).padStart(4, '0')}`;
}

async function seedProject(opts: SeedOptions = {}) {
	const n = ++seq;
	const email = `fe2-artist-${n}@example.test`;
	const slug = `fe2-drop-${n}`;
	await bindings.DB.prepare('INSERT INTO artists (email) VALUES (?1)').bind(email).run();
	const artist = await bindings.DB
		.prepare('SELECT id FROM artists WHERE email = ?1')
		.bind(email)
		.first<{ id: number }>();
	const project = await bindings.DB
		.prepare(
			`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status,
				artwork_url, artwork_status, created_at)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`
		)
		.bind(
			artist!.id,
			`Fixture Drop ${n}`,
			`Fixture Artist ${n}`,
			'https://fixture-artist.bandcamp.com/album/fixture',
			slug,
			'https://fixture-artist.bandcamp.com/yum',
			opts.status ?? 'active',
			opts.artworkUrl ?? null,
			opts.artworkStatus ?? 'pending',
			opts.createdAt ?? '2026-08-28 12:00:00'
		)
		.first<{ id: number }>();

	const available = opts.available ?? 0;
	const claimed = opts.claimed ?? 0;
	const reported = opts.reported ?? 0;
	const total = available + claimed + reported;
	if (total > 0) {
		const batch = await bindings.DB
			.prepare('INSERT INTO code_batches (project_id, filename, code_count) VALUES (?1, ?2, ?3) RETURNING id')
			.bind(project!.id, `fe2-${n}.csv`, total)
			.first<{ id: number }>();
		const batchId = batch!.id;
		const codes: { code: string; status: string }[] = [];
		for (let i = 0; i < claimed; i++) codes.push({ code: codeFor(n, 'c', i), status: 'claimed' });
		for (let i = 0; i < reported; i++) codes.push({ code: codeFor(n, 'r', i), status: 'reported' });
		for (let i = 0; i < available; i++) codes.push({ code: codeFor(n, 'a', i), status: 'available' });
		const values = codes.map((_, i) => `(?${i * 4 + 1}, ?${i * 4 + 2}, ?${i * 4 + 3}, ?${i * 4 + 4})`).join(', ');
		await bindings.DB
			.prepare(`INSERT INTO codes (project_id, batch_id, code, status) VALUES ${values}`)
			.bind(...codes.flatMap((c) => [project!.id, batchId, c.code, c.status]))
			.run();
	}

	return {
		id: project!.id,
		slug,
		title: `Fixture Drop ${n}`,
		artistName: `Fixture Artist ${n}`,
		email,
		codeSeed: n,
		available,
		claimed,
		reported,
		total
	};
}

describe('listPublicDrops (fan board scoping)', () => {
	it('lists an active drop with available codes and its real derived counts', async () => {
		const seed = await seedProject({ available: 5, claimed: 3, reported: 1, artworkStatus: 'fetched', artworkUrl: '/art/1' });
		const drops = await listPublicDrops(bindings.DB);
		const drop = drops.find((d) => d.slug === seed.slug);
		expect(drop).toBeDefined();
		expect(drop).toMatchObject({
			slug: seed.slug,
			title: seed.title,
			artistName: seed.artistName,
			artworkUrl: '/art/1',
			artworkStatus: 'fetched',
			available: 5,
			claimed: 3, // reported codes are neither available nor claimed
			total: 9
		});
	});

	it('never lists draft, paused, drained, or active-but-empty pools', async () => {
		const draft = await seedProject({ status: 'draft', available: 10 });
		const paused = await seedProject({ status: 'paused', available: 10 });
		const drained = await seedProject({ status: 'drained', available: 0, claimed: 4 });
		const emptyActive = await seedProject({ status: 'active', available: 0, claimed: 2, reported: 1 });
		const live = await seedProject({ status: 'active', available: 2 });
		const slugs = new Set((await listPublicDrops(bindings.DB)).map((d) => d.slug));
		expect(slugs.has(draft.slug)).toBe(false);
		expect(slugs.has(paused.slug)).toBe(false);
		expect(slugs.has(drained.slug)).toBe(false);
		expect(slugs.has(emptyActive.slug)).toBe(false);
		expect(slugs.has(live.slug)).toBe(true);
	});

	it('orders newest drops first', async () => {
		const old = await seedProject({ available: 1, createdAt: '2026-08-20 08:00:00' });
		const mid = await seedProject({ available: 1, createdAt: '2026-08-24 08:00:00' });
		const fresh = await seedProject({ available: 1, createdAt: '2026-08-27 08:00:00' });
		const slugs = (await listPublicDrops(bindings.DB)).map((d) => d.slug);
		expect(slugs.indexOf(fresh.slug)).toBeLessThan(slugs.indexOf(mid.slug));
		expect(slugs.indexOf(mid.slug)).toBeLessThan(slugs.indexOf(old.slug));
	});

	it('public payloads carry exactly the board fields — no codes, claims, or artist data', async () => {
		const seed = await seedProject({ available: 4, claimed: 2 });
		const drops = await listPublicDrops(bindings.DB);
		const drop = drops.find((d) => d.slug === seed.slug)!;
		expect(Object.keys(drop).sort()).toEqual(
			['artistName', 'artworkStatus', 'artworkUrl', 'available', 'claimed', 'createdAt', 'id', 'slug', 'title', 'total'].sort()
		);
		// No seeded code string (any class) may appear anywhere in the payload.
		const serialized = JSON.stringify(drops);
		for (let i = 0; i < 2; i++) {
			expect(serialized).not.toContain(codeFor(seed.codeSeed, 'a', i));
			expect(serialized).not.toContain(codeFor(seed.codeSeed, 'c', i));
		}
		// Artist account email is equally absent.
		expect(serialized).not.toContain(seed.email);
	});

	it('maps artwork tri-state as BE8 wrote it', async () => {
		const pending = await seedProject({ available: 1 }); // schema default
		const fallback = await seedProject({ available: 1, artworkStatus: 'fallback', artworkUrl: null });
		const drops = await listPublicDrops(bindings.DB);
		expect(drops.find((d) => d.slug === pending.slug)!.artworkStatus).toBe('pending');
		const fb = drops.find((d) => d.slug === fallback.slug)!;
		expect(fb.artworkStatus).toBe('fallback');
		expect(fb.artworkUrl).toBeNull();
	});
});

describe('getPublicProjectBySlug (share-link reads)', () => {
	it('serves non-draft projects with their public status', async () => {
		const active = await seedProject({ available: 6, claimed: 1, reported: 1 });
		const paused = await seedProject({ status: 'paused', available: 3, claimed: 2 });
		const drained = await seedProject({ status: 'drained', available: 0, claimed: 5 });
		const a = await getPublicProjectBySlug(bindings.DB, active.slug);
		expect(a).toMatchObject({
			status: 'active',
			available: 6,
			claimed: 1,
			reported: 1,
			total: 8,
			// FE3's redeem deep-link base + follow-the-artist exit ride on the
			// PROJECT read (never the board payload — its key set stays pinned).
			albumUrl: 'https://fixture-artist.bandcamp.com/album/fixture',
			yumUrl: 'https://fixture-artist.bandcamp.com/yum'
		});
		const p = await getPublicProjectBySlug(bindings.DB, paused.slug);
		expect(p).toMatchObject({ status: 'paused', available: 3 });
		const d = await getPublicProjectBySlug(bindings.DB, drained.slug);
		expect(d).toMatchObject({ status: 'drained', available: 0, claimed: 5 });
		const board = (await listPublicDrops(bindings.DB)).find((x) => x.slug === active.slug)!;
		expect(Object.keys(board).sort()).toEqual(
			['artistName', 'artworkStatus', 'artworkUrl', 'available', 'claimed', 'createdAt', 'id', 'slug', 'title', 'total'].sort()
		);
	});

	it('refuses drafts and unknown slugs identically (no existence leak)', async () => {
		const draft = await seedProject({ status: 'draft', available: 10 });
		expect(await getPublicProjectBySlug(bindings.DB, draft.slug)).toBeNull();
		expect(await getPublicProjectBySlug(bindings.DB, 'no-such-drop-slug')).toBeNull();
		expect(await getPublicProjectBySlug(bindings.DB, '')).toBeNull();
	});
});

describe('BOARD_LIMIT guard', () => {
	it('is the documented pathological-scale guard (not the honest directory cap)', () => {
		expect(BOARD_LIMIT).toBe(200);
	});
});
