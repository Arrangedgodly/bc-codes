import { describe, expect, it } from 'vitest';
import realBandcampExport from './fixtures/bandcamp-export.csv?raw';
import {
	dedupeAgainstExisting,
	fetchExistingCodes,
	parseBandcampCsv,
	type BandcampCsvParsed
} from '../src/lib/server/bandcamp-csv';
import type { D1Database } from '@cloudflare/workers-types';

/** Deterministic valid code (xxxx-xxxx, base36 halves) for synthetic fixtures. */
function makeCode(i: number): string {
	const half = (n: number): string => n.toString(36).padStart(4, '0').slice(-4);
	return `${half(i)}-${half(i * 7919 + 13)}`;
}

/** Narrow a result to the success branch or fail loudly with the parser's error. */
function expectParsed(text: string): BandcampCsvParsed {
	const result = parseBandcampCsv(text);
	if (!result.ok) {
		throw new Error(`expected parse to succeed, got error: ${result.error}`);
	}
	return result;
}

describe('parseBandcampCsv — real Bandcamp export fixture', () => {
	it('parses the real single-code export byte-for-byte from tests/fixtures', () => {
		const result = expectParsed(realBandcampExport);
		expect(result.codes).toEqual(['lqq8-cvw2']);
		expect(result.count).toBe(1);
		expect(result.albumTitle).toBe('Taxed, Tolled & Eternally Trolled');
		expect(result.yumUrl).toBe('https://arrangedgodly.bandcamp.com/yum');
		expect(result.duplicates).toEqual([]);
		expect(result.invalidLines).toEqual([]);
	});
});

describe('parseBandcampCsv — synthetic multi-code file', () => {
	// ~109 unique codes with CRLF endings, trailing spaces, blank lines, and
	// 8 duplicates (5 re-appearing uppercase, 3 re-appearing verbatim).
	const uniqueCodes = Array.from({ length: 97 }, (_, i) => makeCode(i + 1));
	const extraCodes = Array.from({ length: 12 }, (_, i) => makeCode(200 + i));
	const syntheticFile =
		[
			'name of code set: SynthDrop',
			'date created: Aug-01-2026',
			'date exported: Aug-28-2026',
			'"album: Synth Album, Vol. 2"',
			'quantity created: 100',
			'quantity redeemed to date: 3',
			'',
			'send your fans here to redeem their codes: ',
			'    https://synthdrop.bandcamp.com/yum',
			'',
			'code',
			...uniqueCodes.map((code, i) => (i % 3 === 0 ? `${code}   ` : code)),
			...uniqueCodes.slice(0, 5).map((code) => code.toUpperCase()),
			'   ',
			...uniqueCodes.slice(10, 13),
			'',
			...extraCodes
		].join('\r\n') + '\r\n';

	it('extracts all unique codes, skipping duplicates, tolerating CRLF/space/blank noise', () => {
		const result = expectParsed(syntheticFile);
		expect(result.count).toBe(109);
		expect(result.codes).toEqual([...uniqueCodes, ...extraCodes]);
		// Uppercase repeats are normalized to lowercase when reported as dupes.
		expect(result.duplicates).toEqual([
			...uniqueCodes.slice(0, 5),
			...uniqueCodes.slice(10, 13)
		]);
		expect(result.invalidLines).toEqual([]);
		expect(result.albumTitle).toBe('Synth Album, Vol. 2');
		expect(result.yumUrl).toBe('https://synthdrop.bandcamp.com/yum');
	});
});

describe('parseBandcampCsv — lenient details', () => {
	it('normalizes uppercase codes to lowercase and strips quotes and comma cells', () => {
		const result = expectParsed('code\n"LQQ8-CVW2"\nwxyz-4321, redeemed\n');
		expect(result.codes).toEqual(['lqq8-cvw2', 'wxyz-4321']);
		expect(result.duplicates).toEqual([]);
	});

	it('tolerates BOM and lone-CR line endings', () => {
		const result = expectParsed('\uFEFFalbum: CR Album\rcode\nabcd-efgh\r');
		expect(result.albumTitle).toBe('CR Album');
		expect(result.codes).toEqual(['abcd-efgh']);
	});

	it('returns null album title and yum URL when the header block omits them', () => {
		const result = expectParsed('code\nabcd-efgh\n');
		expect(result.albumTitle).toBeNull();
		expect(result.yumUrl).toBeNull();
	});

	it('records unparseable code lines with line numbers instead of failing', () => {
		const result = expectParsed('code\nabcd-efgh\nnot-a-code\n1234-56789\n\n');
		expect(result.codes).toEqual(['abcd-efgh']);
		expect(result.invalidLines).toEqual([
			{ lineNumber: 3, text: 'not-a-code' },
			{ lineNumber: 4, text: '1234-56789' }
		]);
	});

	it('accepts a quoted code header and quoted album line', () => {
		const result = expectParsed('"album: Quoted, Album"\n"code"\nabcd-efgh\n');
		expect(result.albumTitle).toBe('Quoted, Album');
		expect(result.codes).toEqual(['abcd-efgh']);
	});
});

describe('parseBandcampCsv — malformed inputs return human-readable errors', () => {
	it('rejects an empty file', () => {
		const result = parseBandcampCsv('');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(10);
	});

	it('rejects a whitespace-only file', () => {
		const result = parseBandcampCsv('\n \n\t  \n');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/empty/i);
	});

	it('rejects a header block with no code column', () => {
		const noCodeColumn = [
			'name of code set: GetMusic',
			'date created: Jan-17-2024',
			'"album: Taxed, Tolled & Eternally Trolled"',
			'quantity created: 100',
			'send your fans here to redeem their codes: ',
			'    https://arrangedgodly.bandcamp.com/yum'
		].join('\n');
		const result = parseBandcampCsv(noCodeColumn);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/code column/i);
	});

	it('rejects garbage header text', () => {
		const result = parseBandcampCsv('hello\tworld\nfoo,bar,baz\nnot a bandcamp file\n');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/code column/i);
	});

	it('rejects a code header with no codes below it', () => {
		const result = parseBandcampCsv('album: X\ncode\n???');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/no download codes/i);
	});

	it('rejects binary junk containing NUL bytes', () => {
		let binary = '';
		for (let i = 0; i < 512; i++) binary += String.fromCharCode((i * 31 + 7) % 256);
		const result = parseBandcampCsv(binary);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/binary|non-text/i);
	});

	it('rejects control-character junk without NUL bytes', () => {
		let junk = '';
		for (let i = 0; i < 1024; i++) junk += String.fromCharCode(1 + ((i * 7) % 250));
		const result = parseBandcampCsv(junk);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/binary|non-text/i);
	});
});

describe('dedupeAgainstExisting — cross-batch dedupe (pure)', () => {
	it('partitions codes into fresh vs already-present, preserving order', () => {
		const outcome = dedupeAgainstExisting(['aa11-bb22', 'cc33-dd44', 'ee55-ff66'], [
			'cc33-dd44',
			'zz99-yy88'
		]);
		expect(outcome.fresh).toEqual(['aa11-bb22', 'ee55-ff66']);
		expect(outcome.alreadyPresent).toEqual(['cc33-dd44']);
	});

	it('returns everything fresh when nothing exists yet', () => {
		const outcome = dedupeAgainstExisting(['aa11-bb22'], new Set<string>());
		expect(outcome.fresh).toEqual(['aa11-bb22']);
		expect(outcome.alreadyPresent).toEqual([]);
	});

	it('composes with the parser: upload dupes vs project stock are alreadyPresent', () => {
		const parsed = expectParsed('code\naa11-bb22\ncc33-dd44\nee55-ff66\n');
		const outcome = dedupeAgainstExisting(parsed.codes, ['cc33-dd44', 'ee55-ff66']);
		expect(outcome.fresh).toEqual(['aa11-bb22']);
		expect(outcome.alreadyPresent).toEqual(['cc33-dd44', 'ee55-ff66']);
	});
});

describe('fetchExistingCodes — thin D1 helper (BE7 wiring contract)', () => {
	it('selects a project’s codes into a Set', async () => {
		const rows = [{ code: 'aa11-bb22' }, { code: 'cc33-dd44' }];
		let seenSql = '';
		let seenParams: unknown[] = [];
		const db = {
			prepare: (sql: string) => {
				seenSql = sql;
				return {
					bind: (...params: unknown[]) => {
						seenParams = params;
						return { all: async () => ({ results: rows }) };
					}
				};
			}
		};
		const existing = await fetchExistingCodes(db as unknown as D1Database, 42);
		expect(seenSql).toBe('SELECT code FROM codes WHERE project_id = ?1');
		expect(seenParams).toEqual([42]);
		expect(existing).toEqual(new Set(['aa11-bb22', 'cc33-dd44']));
	});
});
