/**
 * Bandcamp download-code CSV export parser (BE2).
 *
 * Real export shape (see tests/fixtures/bandcamp-export.csv):
 *
 *     name of code set: GetMusic
 *     date created: Jan-17-2024
 *     date exported: Aug-28-2026
 *     "album: Taxed, Tolled & Eternally Trolled"        <- whole line CSV-quoted (title has a comma)
 *     quantity created: 100
 *     quantity redeemed to date: 99
 *                                                        <- blank lines and prose interspersed
 *        this file only contains unredeemed codes;
 *        redeemed code information is available on your tools page
 *
 *     send your fans here to redeem their codes:
 *         https://arrangedgodly.bandcamp.com/yum         <- redeem (yum) URL on its own indented line
 *
 *     code                                               <- literal `code` header line
 *     lqq8-cvw2                                          <- one code per line: xxxx-xxxx
 *
 * Parsing is deliberately lenient: line endings (LF/CRLF/CR), BOM, trailing
 * whitespace, blank lines, fully- or half-quoted fields, uppercase codes
 * (normalized to lowercase), and comma-suffixed cells are all tolerated.
 * File-level failures (empty, binary, no `code` header, no codes) return a
 * human-readable error meant to be shown verbatim to the artist in FE5.
 *
 * Purity: `parseBandcampCsv` and `dedupeAgainstExisting` are pure (no I/O).
 * `fetchExistingCodes` is the thin D1 helper BE7 wires in for cross-batch
 * dedupe — the DB never touches the parser itself.
 */

import type { D1Database } from '@cloudflare/workers-types';

/** Canonical Bandcamp download-code shape: `xxxx-xxxx`, lowercase alphanumeric. */
const CODE_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

/** A redeem (yum) URL anywhere in the header block: `https://<artist>.bandcamp.com/yum`. */
const YUM_URL_PATTERN = /https?:\/\/[a-z0-9-]+\.bandcamp\.com\/yum\b[^\s"'<>]*/i;

/** A line that is just the `code` column header (optionally quoted / comma-terminated). */
function isCodeHeader(line: string): boolean {
	return cleanCell(line) === 'code';
}

/**
 * Normalize one raw line to its first CSV cell, quote-stripped and trimmed.
 * Codes and the `code` header never contain quotes or commas, so stripping
 * unpaired quotes here is safe and keeps `"lqq8-cvw2`-style rows parseable.
 */
function cleanCell(line: string): string {
	const firstCell = line.split(',')[0] ?? '';
	return firstCell.replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
}

/**
 * Extract the album title from an `album: ...` header line. The real export
 * quotes the whole line when the title contains a comma, so quotes are
 * stripped from the outside in, then from the captured title.
 */
function parseAlbumLine(line: string): string | null {
	const unquoted = line.replace(/^["'\s]+|["'\s]+$/g, '');
	const match = /^album\s*:\s*(.*)$/i.exec(unquoted);
	if (!match) return null;
	const title = match[1].replace(/^["'\s]+|["'\s]+$/g, '');
	return title.length > 0 ? title : null;
}

/**
 * Heuristic binary/content sniff: NUL bytes, a high ratio of control
 * characters, or a high ratio of U+FFFD (undecodable bytes) all mean this is
 * not a Bandcamp CSV export (artists occasionally upload zips / xls / pdfs).
 */
function looksLikeBinary(text: string): boolean {
	if (text.includes('\0')) return true;
	let suspicious = 0;
	let sampled = 0;
	for (const ch of text.slice(0, 8192)) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch !== '\n' && ch !== '\r' && ch !== '\t' && (code < 32 || code === 0xfffd)) {
			suspicious++;
		}
		sampled++;
	}
	return sampled > 0 && suspicious / sampled > 0.05;
}

/** A non-blank line below the `code` header that is not a valid code. */
export interface InvalidLine {
	/** 1-based line number in the original file. */
	lineNumber: number;
	/** The offending line, trimmed (truncated to 100 chars in the result). */
	text: string;
}

/** Successful parse. */
export interface BandcampCsvParsed {
	ok: true;
	/** Unique, valid codes in first-seen order, lowercase `xxxx-xxxx`. */
	codes: string[];
	/** Codes skipped because the same code already appeared earlier in this file. */
	duplicates: string[];
	/** Convenience: `codes.length`. */
	count: number;
	/** Album title from the `album: ...` header line, when present. */
	albumTitle: string | null;
	/** Redeem URL (`https://<artist>.bandcamp.com/yum`) from the header block, when present. */
	yumUrl: string | null;
	/** Unrecognizable non-blank lines below the `code` header (never fatal). */
	invalidLines: InvalidLine[];
}

/** Failed parse — `error` is human-readable and safe to show to the artist. */
export interface BandcampCsvError {
	ok: false;
	error: string;
}

export type BandcampCsvResult = BandcampCsvParsed | BandcampCsvError;

/**
 * Parse a Bandcamp code-export CSV. Pure: string in, structured result out.
 *
 * Dedupes within the file (first occurrence wins, later ones land in
 * `duplicates`); cross-batch dedupe is `dedupeAgainstExisting` +
 * `fetchExistingCodes` below, wired by BE7 at upload time.
 */
export function parseBandcampCsv(text: string): BandcampCsvResult {
	if (looksLikeBinary(text)) {
		return {
			ok: false,
			error:
				'This does not look like a Bandcamp CSV export — the file contains binary or non-text content. Re-download the export from your Bandcamp tools page and try again.'
		};
	}

	// BOM + lone-CR tolerance: normalize every line ending and trim trailing space.
	const lines = text
		.replace(/^\uFEFF/, '')
		.split(/\r\n|\r|\n/)
		.map((line) => line.replace(/[ \t]+$/, ''));

	if (lines.every((line) => line.trim().length === 0)) {
		return {
			ok: false,
			error: 'The file is empty — no Bandcamp export content was found.'
		};
	}

	const headerIndex = lines.findIndex(isCodeHeader);
	if (headerIndex === -1) {
		return {
			ok: false,
			error:
				'No code column found — Bandcamp exports have a line that says just "code" above the list of download codes. This file does not match that format.'
		};
	}

	// Header block: album title + yum URL live above the `code` header.
	let albumTitle: string | null = null;
	let yumUrl: string | null = null;
	for (const line of lines.slice(0, headerIndex)) {
		if (albumTitle === null) {
			albumTitle = parseAlbumLine(line);
		}
		if (yumUrl === null) {
			yumUrl = line.match(YUM_URL_PATTERN)?.[0] ?? null;
		}
	}

	// Codes section: one code per line below the header, lenient per-cell cleanup.
	const codes: string[] = [];
	const duplicates: string[] = [];
	const invalidLines: InvalidLine[] = [];
	const seen = new Set<string>();
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const cell = cleanCell(lines[i]);
		if (cell.length === 0) continue; // blank line
		if (CODE_PATTERN.test(cell)) {
			if (seen.has(cell)) {
				duplicates.push(cell);
			} else {
				seen.add(cell);
				codes.push(cell);
			}
		} else {
			invalidLines.push({
				lineNumber: i + 1,
				text: lines[i].trim().slice(0, 100)
			});
		}
	}

	if (codes.length === 0) {
		const skipped = invalidLines.length;
		return {
			ok: false,
			error:
				'No download codes were found below the "code" header.' +
				(skipped > 0
					? ` ${skipped} line${skipped === 1 ? '' : 's'} below it could not be read as codes (expected one code per line, format xxxx-xxxx).`
					: ' Codes are lowercase and look like xxxx-xxxx.')
		};
	}

	return { ok: true, codes, duplicates, count: codes.length, albumTitle, yumUrl, invalidLines };
}

/** Outcome of deduping an upload's codes against codes already in the project. */
export interface DedupeOutcome {
	/** Codes not present in `existing` — safe to insert. */
	fresh: string[];
	/** Codes already present in `existing` (uploaded to this project before). */
	alreadyPresent: string[];
}

/**
 * Pure cross-batch dedupe: partition parsed codes against the set of codes a
 * project already holds. Mirrors the `codes` table's UNIQUE(project_id, code)
 * — pass that project's codes as `existing` so the insert set never violates
 * the constraint (BE7 wires `fetchExistingCodes` in as the source).
 */
export function dedupeAgainstExisting(codes: Iterable<string>, existing: Iterable<string>): DedupeOutcome {
	const existingSet = existing instanceof Set ? existing : new Set(existing);
	const fresh: string[] = [];
	const alreadyPresent: string[] = [];
	for (const code of codes) {
		if (existingSet.has(code)) {
			alreadyPresent.push(code);
		} else {
			fresh.push(code);
		}
	}
	return { fresh, alreadyPresent };
}

/**
 * Thin D1 helper for BE7: load a project's existing codes (all batches) as a
 * Set, ready for `dedupeAgainstExisting`. Kept out of `parseBandcampCsv` so
 * the parser stays pure and unit-testable without a database.
 */
export async function fetchExistingCodes(db: D1Database, projectId: number): Promise<Set<string>> {
	const { results } = await db
		.prepare('SELECT code FROM codes WHERE project_id = ?1')
		.bind(projectId)
		.all<{ code: string }>();
	return new Set((results ?? []).map((row) => row.code));
}
