/**
 * QA3 — WCAG 2.1 contrast re-audit of FE1's token table (tests/contrast.test.ts).
 *
 * FE1 documented a verified ratio table in src/app.css's header for every
 * text/ground pair the design system renders. This suite recomputes that
 * table from the REAL token hexes in src/app.css (extracted on the Node side
 * by vitest.config.ts and injected here — workerd has no fs), so:
 *
 *   - a token edit that breaks AA (4.5:1 normal / 3:1 large+graphics) fails,
 *   - the doc table and the math can never silently drift apart,
 *   - the one sanctioned sub-AA token (--alarm: large text + fills ONLY) is
 *     pinned to its documented value and threshold role.
 *
 * The LIVE-DOM half of the re-audit (rendered pairs vs. this table) is
 * covered by axe-core's color-contrast rule in e2e/a11y.spec.ts, which scans
 * every surface/state at both contract viewports.
 */

import { describe, expect, it } from 'vitest';
import { inject } from 'vitest';

/** Token hexes as actually written in src/app.css `:root` (provided by vitest.config.ts). */
// (The provide/inject literal-key typing only knows the sync `migrations`
// provide; the cast keeps this independent of that inference.)
const T = (inject as (key: string) => unknown)('cssTokens') as Record<string, string>;

function channel(byte: number): number {
	const c = byte / 255;
	return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
	const value = hex.replace('#', '');
	const r = parseInt(value.slice(0, 2), 16);
	const g = parseInt(value.slice(2, 4), 16);
	const b = parseInt(value.slice(4, 6), 16);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 2-decimal rounded like the doc table. */
function ratio(fg: string, bg: string): number {
	const l1 = luminance(fg);
	const l2 = luminance(bg);
	const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
	return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

describe('QA3 — FE1 token table recomputed from src/app.css (WCAG 2.1 math)', () => {
	it('the three grounds and seven semantic tokens exist as hex tokens', () => {
		for (const name of ['ink', 'panel', 'panel-inset', 'orange', 'orange-bright', 'green', 'alarm', 'alarm-bright', 'text', 'text-muted', 'hairline']) {
			expect(T[name], `--${name} hex token missing from app.css :root`).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	const AA = 4.5;
	const AA_LARGE = 3.0;

	/** [fg token, bg token, FE1's documented ratio, threshold] */
	const TABLE: Array<[string, string, number, number]> = [
		['text', 'ink', 11.23, AA],
		['text', 'panel', 10.98, AA],
		['text', 'panel-inset', 11.54, AA],
		['text-muted', 'ink', 5.41, AA],
		['text-muted', 'panel', 5.29, AA],
		['text-muted', 'panel-inset', 5.56, AA],
		['text-micro', 'ink', 4.98, AA],
		['text-micro', 'panel', 4.87, AA],
		['text-micro', 'panel-inset', 5.12, AA],
		['orange', 'ink', 6.41, AA],
		['orange', 'panel', 6.27, AA],
		['orange', 'panel-inset', 6.59, AA],
		['orange-bright', 'ink', 7.64, AA],
		['green', 'ink', 10.01, AA],
		['green', 'panel', 9.79, AA],
		['green', 'panel-inset', 10.29, AA],
		['alarm-bright', 'ink', 5.63, AA],
		['alarm-bright', 'panel', 5.51, AA],
		['alarm-bright', 'panel-inset', 5.79, AA],
		// Buttons/chips: ink text ON the saturated fills.
		['ink', 'orange', 6.41, AA],
		['ink', 'green', 10.01, AA],
		// The one sub-AA token, pinned to its sanctioned role: large text (>=24px,
		// or >=18.66px bold) + non-text graphics/fills only — never small body text.
		['alarm', 'ink', 4.28, AA_LARGE],
		// Decorative boundary — never the sole carrier of state (labels/chips are).
		['hairline', 'ink', 1.73, 1.0]
	];

	for (const [fg, bg, documented, threshold] of TABLE) {
		it(`--${fg} on --${bg}: ${documented}:1 documented, >= ${threshold}:1 required`, () => {
			const computed = ratio(T[fg]!, T[bg]!);
			expect(computed).toBeCloseTo(documented, 1);
			expect(computed).toBeGreaterThanOrEqual(threshold);
		});
	}

	it('the sub-AA --alarm is never paired as small body text: its AA-safe sibling exists', () => {
		// The design rule (app.css header + StatusChip): small alarm text uses
		// --alarm-bright. Pin that the sibling is strictly brighter on every ground.
		for (const ground of ['ink', 'panel', 'panel-inset']) {
			expect(ratio(T['alarm-bright']!, T[ground]!)).toBeGreaterThan(ratio(T['alarm']!, T[ground]!));
		}
	});
});
