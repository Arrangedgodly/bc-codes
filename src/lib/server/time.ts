/**
 * UTC timestamp helpers (BE3).
 *
 * The schema (migrations/0001_init.sql) stores timestamps as SQLite
 * `datetime('now')`-shaped TEXT: 'YYYY-MM-DD HH:MM:SS' (UTC, second precision).
 * These modules always write JS-side `toSqlUtc(now)` values instead of relying
 * on `datetime('now')` so every time-dependent rule (expiry, cooldowns, fixed
 * rate-limit windows) is testable via an injected `now` — and so reads and
 * writes agree on the format. `Date.parse` treats the space-separated form as
 * LOCAL time, hence the explicit `fromSqlUtc` round trip below.
 *
 * Second-precision truncation means computed durations can be off by <1s;
 * every production duration here is >=60s, so this is immaterial (and tests
 * use whole-second clocks).
 */

/** Date -> 'YYYY-MM-DD HH:MM:SS' in UTC (matches the schema's TEXT columns). */
export function toSqlUtc(date: Date): string {
	return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) -> epoch milliseconds. */
export function fromSqlUtc(text: string): number {
	return Date.parse(`${text.slice(0, 19).replace(' ', 'T')}Z`);
}

/**
 * Start of the fixed window containing `date` (floored to a multiple of
 * `windowMs` since the epoch). 10-minute windows align to clock 10-minute
 * marks; 24-hour windows align to UTC midnight — which is exactly the "per
 * day" a provider daily quota means. Fixed windows are trivially testable and
 * need no sliding-window bookkeeping; their only cost is a possible burst of
 * up to 2x the limit across one window boundary, which the caps absorb.
 */
export function windowStart(date: Date, windowMs: number): Date {
	return new Date(Math.floor(date.getTime() / windowMs) * windowMs);
}
