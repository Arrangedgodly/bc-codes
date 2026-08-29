#!/usr/bin/env node
/**
 * OP1 — QA1's production-D1 burst re-run, SAFE variant.
 *
 * What this is (docs/ultron/deploy-runbook.md §6): the canonical QA1 shape —
 * `FANS` concurrent claims racing a pool of `CODES` codes — fired against a
 * REAL deployed worker bound to a REAL remote Cloudflare D1 (staging). R1/QA1
 * verified the invariants on local workerd SQLite; this closes the remaining
 * gap (remote D1 service behavior) that docs/ultron/production-log.md T-QA1
 * documented as riding OP1's smoke checklist.
 *
 * Why it is safe (the honest scope statement):
 *   - It targets the STAGING worker/database, never production. Every code it
 *     consumes is a fabricated `xxxx-xxxx` test string seeded into a throwaway
 *     project titled "SMOKE TEST"; no real Bandcamp code is touched.
 *   - It never sends email: fan sessions are seeded directly into D1 (token
 *     hashes + HMACs crafted with the STAGING secrets), so the 250-way burst
 *     costs zero OTP emails and cannot touch Resend's daily quota. Staging has
 *     no mailer key anyway (console driver).
 *   - It writes only rows it names explicitly (one smoke artist, one slug-
 *     tagged project + batch + codes, N fan identities + sessions) and prints
 *     the exact cleanup SQL to remove them afterwards.
 *
 * The cookie/hash constructions replicate the app's canonical helpers
 * byte-for-byte (src/lib/server/crypto.ts + fan-session.ts):
 *   fan_hash    = hex(HMAC-SHA256(email.trim().toLowerCase(), EMAIL_PEPPER))
 *   cookie      = `${token}.${base64url(HMAC-SHA256('fan-session:'+token, SESSION_SECRET))}`
 *   token       = base64url(32 random bytes)   (never stored — only its hash)
 *   token_hash  = hex(SHA-256(token))          (fan_sessions.token_hash)
 *
 * Usage (all from the repo root; secrets via env vars, never arguments):
 *
 *   # 1. Generate seed SQL + a state file (prints SQL to stdout):
 *   EMAIL_PEPPER=<staging> SESSION_SECRET=<staging> \
 *     node scripts/burst-smoke.mjs prepare --fans 250 --codes 200 \
 *     --state /tmp/bc-burst/state.json > /tmp/bc-burst/seed.sql
 *
 *   # 2. Apply it to remote staging D1 (runbook has the exact command):
 *   npx wrangler d1 execute bc-codes-staging --remote -y --file /tmp/bc-burst/seed.sql
 *
 *   # 3. Fire the burst and get a PASS/FAIL verdict:
 *   node scripts/burst-smoke.mjs fire \
 *     --url https://bc-codes-staging.<your-subdomain>.workers.dev \
 *     --state /tmp/bc-burst/state.json
 *
 *   # 4. DB-level ledger audit (prints SQL; run via wrangler d1 execute):
 *   node scripts/burst-smoke.mjs audit --state /tmp/bc-burst/state.json
 *
 *   # 5. Cleanup (prints SQL for everything this run created):
 *   node scripts/burst-smoke.mjs cleanup --state /tmp/bc-burst/state.json
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ── crypto, byte-identical to src/lib/server/crypto.ts ─────────────────────

const hmacHex = (value, secret) => createHmac('sha256', secret).update(value).digest('hex');
const hmacBase64Url = (value, secret) => createHmac('sha256', secret).update(value).digest('base64url');
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

const FAN_COOKIE = 'bc_fan_session';
const SIGNING_PURPOSE = 'fan-session'; // src/lib/server/fan-session.ts
const SMOKE_ARTIST_EMAIL = 'op1-burst-smoke@bc-codes.invalid'; // .invalid TLD can never be a real artist

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = { fans: 250, codes: 200, state: '/tmp/bc-burst-state.json', url: '', tag: '' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--fans') args.fans = Number(argv[++i]);
		else if (a === '--codes') args.codes = Number(argv[++i]);
		else if (a === '--state') args.state = argv[++i];
		else if (a === '--url') args.url = argv[++i];
		else if (a === '--tag') args.tag = argv[++i];
		else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
		else if (!args.command) args.command = a;
		else throw new Error(`unexpected argument ${a}`);
	}
	if (!['prepare', 'fire', 'audit', 'cleanup'].includes(args.command)) {
		throw new Error('usage: burst-smoke.mjs <prepare|fire|audit|cleanup> [flags]');
	}
	if (!Number.isInteger(args.fans) || args.fans < 1) throw new Error('--fans must be a positive integer');
	if (!Number.isInteger(args.codes) || args.codes < 1) throw new Error('--codes must be a positive integer');
	if (args.fans <= args.codes) throw new Error(`need --fans (> ${args.codes}) greater than --codes so the burst exercises the drained refusals too`);
	return args;
}

const sql = (s) => `'${s.replace(/'/g, "''")}'`; // defensive: every generated literal is quote-free by construction

// ── prepare ─────────────────────────────────────────────────────────────────

function prepare(args) {
	const { fans, codes } = args;
	const pepper = process.env.EMAIL_PEPPER ?? '';
	const sessionSecret = process.env.SESSION_SECRET ?? '';
	if (!pepper || !sessionSecret) {
		throw new Error('prepare needs EMAIL_PEPPER and SESSION_SECRET (STAGING values) in the environment');
	}
	const runId = Date.now().toString(36);
	const slug = `smoke-burst-${runId}`;
	const fanEmails = Array.from({ length: fans }, (_, i) => `burst-${runId}-${i}@smoke.invalid`);

	// Craft the sessions: token + signature (cookie), hash-of-token (row).
	const fansData = fanEmails.map((email) => {
		const fanHash = hmacHex(email.trim().toLowerCase(), pepper);
		const token = randomToken(32);
		const signature = hmacBase64Url(`${SIGNING_PURPOSE}:${token}`, sessionSecret);
		return { email, fanHash, tokenHash: sha256Hex(token), cookie: `${token}.${signature}` };
	});

	// Fabricated unique test codes — format-real ([a-z0-9]{4}x2) so they look
	// like the real thing, but random garbage that can never redeem on Bandcamp.
	const codeSet = new Set();
	while (codeSet.size < codes) codeSet.add(randCode());
	const codesList = [...codeSet];

	const projectId = `(SELECT id FROM projects WHERE slug = ${sql(slug)})`;
	const batchId = `(SELECT id FROM code_batches WHERE project_id = ${projectId})`;
	const lines = [];
	lines.push(`-- OP1 burst-smoke seed · run ${runId} · ${fans} fans racing ${codes} codes`);
	lines.push(`-- Apply with: npx wrangler d1 execute bc-codes-staging --remote -y --file <this-file>`);
	lines.push(`INSERT INTO artists (email) SELECT ${sql(SMOKE_ARTIST_EMAIL)} WHERE NOT EXISTS (SELECT 1 FROM artists WHERE email = ${sql(SMOKE_ARTIST_EMAIL)});`);
	lines.push(`INSERT INTO projects (artist_id, title, artist_name, album_url, slug, yum_url, status) VALUES ((SELECT id FROM artists WHERE email = ${sql(SMOKE_ARTIST_EMAIL)}), 'SMOKE TEST burst - safe to delete', 'OP1 deploy smoke', 'https://smoke.invalid/album', ${sql(slug)}, 'https://smoke.invalid/yum', 'active');`);
	lines.push(`INSERT INTO code_batches (project_id, filename, code_count) VALUES (${projectId}, 'op1-burst-smoke.csv', ${codes});`);
	lines.push(`INSERT INTO codes (project_id, batch_id, code) VALUES ${codesList.map((c) => `(${projectId}, ${batchId}, ${sql(c)})`).join(', ')};`);
	lines.push(`INSERT INTO fan_identities (email_hash) VALUES ${fansData.map((f) => `(${sql(f.fanHash)})`).join(', ')};`);
	lines.push(`INSERT INTO fan_sessions (fan_id, token_hash, expires_at) VALUES ${fansData.map((f) => `((SELECT id FROM fan_identities WHERE email_hash = ${sql(f.fanHash)}), ${sql(f.tokenHash)}, datetime('now', '+2 days'))`).join(', ')};`);

	const state = {
		runId,
		slug,
		fans,
		codes,
		fanHashes: fansData.map((f) => f.fanHash),
		cookies: fansData.map((f) => f.cookie),
		createdAt: new Date().toISOString()
	};
	mkdirSync(dirname(args.state), { recursive: true });
	writeFileSync(args.state, JSON.stringify(state, null, '\t') + '\n');
	process.stderr.write(`state → ${args.state} (cookies for ${fans} staging-only test sessions; delete it after cleanup)\n`);
	process.stdout.write(lines.join('\n') + '\n');
}

function randCode() {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const part = () =>
		Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
	return `${part()}-${part()}`;
}

// ── fire ────────────────────────────────────────────────────────────────────

function post(urlStr, body, headers, agent) {
	return new Promise((resolve, reject) => {
		const target = new URL(urlStr);
		const mod = target.protocol === 'http:' ? http : https;
		const req = mod.request(
			{
				hostname: target.hostname,
				port: target.port || (target.protocol === 'http:' ? 80 : 443),
				path: `${target.pathname}${target.search}`,
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
				agent
			},
			(res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
			}
		);
		req.on('error', reject);
		req.setTimeout(60_000, () => req.destroy(new Error('request timeout')));
		req.end(body);
	});
}

async function runFire(args) {
	const state = JSON.parse(readFileSync(args.state, 'utf8'));
	const base = args.url.replace(/\/+$/, '');
	if (!/^https?:\/\//.test(base)) throw new Error('--url must be the deployed worker origin, e.g. https://bc-codes-staging.<subdomain>.workers.dev');

	// One socket per racer: the point is TRUE client-side concurrency (like
	// QA1's Promise.all burst / R1's xargs -P 250), not undici's small pool.
	const mod = base.startsWith('https:') ? https : http;
	const agent = new mod.Agent({ keepAlive: true, maxSockets: state.fans + 64 });

	const started = Date.now();
	const results = await Promise.all(
		state.cookies.map(async (cookie, i) => {
			// 0–4 ms jitter, QA1's shape: racers land in slightly staggered waves.
			await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
			// Transport-level retries ONLY (connect/socket errors, status 0): a
			// request that never reached the server never claimed anything, so
			// re-sending preserves the one-claim-per-fan semantics. Needed for
			// local previews whose accept queue < fans; the real edge rarely trips.
			for (let attempt = 1; ; attempt++) {
				try {
					const res = await post(
						`${base}/api/fan/claim`,
						JSON.stringify({ slug: state.slug }),
						{ Cookie: `${FAN_COOKIE}=${cookie}` },
						agent
					);
					let parsed = null;
					try {
						parsed = JSON.parse(res.body);
					} catch {}
					return { i, status: res.status, parsed };
				} catch (error) {
					if (attempt < 4) {
						await new Promise((r) => setTimeout(r, 250 * attempt));
						continue;
					}
					return { i, status: 0, parsed: null, error: String(error) };
				}
			}
		})
	);
	agent.destroy();

	const fresh = [];
	const revisits = [];
	const drained = [];
	const anomalies = [];
	for (const r of results) {
		if (r.status === 200 && r.parsed?.ok === true && r.parsed.outcome === 'claimed' && r.parsed.reused === false) fresh.push(r.parsed.claim?.code);
		else if (r.status === 200 && r.parsed?.ok === true && r.parsed.outcome === 'revisit') revisits.push(r);
		else if (r.status === 409 && r.parsed?.error === 'drained') drained.push(r);
		else anomalies.push(r);
	}
	const uniqueCodes = new Set(fresh);
	const expectedFresh = state.codes;
	const expectedDrained = state.fans - state.codes;
	const pass =
		anomalies.length === 0 &&
		revisits.length === 0 &&
		fresh.length === expectedFresh &&
		uniqueCodes.size === expectedFresh &&
		drained.length === expectedDrained;

	console.log(`burst: ${state.fans} fans raced ${state.codes} codes on ${base} (slug ${state.slug}) in ${Date.now() - started} ms`);
	console.log(`  fresh dispenses : ${fresh.length}  (expected ${expectedFresh})`);
	console.log(`  unique codes    : ${uniqueCodes.size}  (expected ${expectedFresh} — zero double-dispense)`);
	console.log(`  drained refusals: ${drained.length}  (expected ${expectedDrained})`);
	console.log(`  revisits        : ${revisits.length}  (expected 0 — all fans distinct)`);
	console.log(`  anomalies       : ${anomalies.length}  (expected 0)`);
	for (const a of anomalies.slice(0, 5)) console.log(`    anomaly: status=${a.status} body=${a.error ?? JSON.stringify(a.parsed)}`);
	console.log(pass ? 'VERDICT: PASS — no double-dispense, typed drained refusals only (QA1 invariant 1 over remote D1)' : 'VERDICT: FAIL — see tallies above; if fresh+drained < fans, inspect anomalies');
	if (!pass) process.exitCode = 1;
}

// ── audit / cleanup SQL ─────────────────────────────────────────────────────

function auditSql(state) {
	const p = `(SELECT id FROM projects WHERE slug = ${sql(state.slug)})`;
	return [
		`-- Ledger audit for run ${state.runId} (expected: claims_rows=${state.codes}, codes_total=${state.codes}, codes_available=0,`,
		`-- orphan_codes=0, orphan_claims=0, orphan_identities=0, double_code_refs=0, dup_fan_hashes=0, project_status='drained')`,
		`SELECT`,
		`  (SELECT COUNT(*) FROM claims WHERE project_id = ${p}) AS claims_rows,`,
		`  (SELECT COUNT(*) FROM codes WHERE project_id = ${p}) AS codes_total,`,
		`  (SELECT COUNT(*) FROM codes WHERE project_id = ${p} AND status = 'available') AS codes_available,`,
		`  (SELECT COUNT(*) FROM codes WHERE project_id = ${p} AND status = 'claimed' AND id NOT IN (SELECT code_id FROM claims WHERE project_id = ${p})) AS orphan_codes,`,
		`  (SELECT COUNT(*) FROM claims c JOIN codes cd ON cd.id = c.code_id WHERE c.project_id = ${p} AND cd.status != 'claimed') AS orphan_claims,`,
		`  (SELECT COUNT(*) FROM claims c WHERE c.project_id = ${p} AND c.fan_hash NOT IN (SELECT email_hash FROM fan_identities)) AS orphan_identities,`,
		`  (SELECT COUNT(*) FROM (SELECT code_id FROM claims WHERE project_id = ${p} GROUP BY code_id HAVING COUNT(*) > 1)) AS double_code_refs,`,
		`  (SELECT COUNT(*) FROM (SELECT fan_hash FROM claims WHERE project_id = ${p} GROUP BY fan_hash HAVING COUNT(*) > 1)) AS dup_fan_hashes,`,
		`  (SELECT status FROM projects WHERE slug = ${sql(state.slug)}) AS project_status;`
	].join('\n');
}

function cleanupSql(state) {
	const inList = state.fanHashes.map((h) => sql(h)).join(', ');
	return [
		`-- Cleanup for run ${state.runId}: removes exactly what this run seeded (project delete cascades to batch, codes, claims;`,
		`-- fan_identities delete cascades to fan_sessions). Then delete the state file: rm ${argsStatePath()}`,
		`DELETE FROM projects WHERE slug = ${sql(state.slug)};`,
		`DELETE FROM fan_identities WHERE email_hash IN (${inList});`,
		`DELETE FROM artists WHERE email = ${sql(SMOKE_ARTIST_EMAIL)} AND NOT EXISTS (SELECT 1 FROM projects JOIN artists a ON a.id = projects.artist_id WHERE a.email = ${sql(SMOKE_ARTIST_EMAIL)});`
	].join('\n');
}

let statePathForNote = '';
const argsStatePath = () => statePathForNote;

// ── main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
statePathForNote = args.state;
if (args.command === 'prepare') prepare(args);
else if (args.command === 'fire') await runFire(args);
else if (args.command === 'audit') process.stdout.write(auditSql(JSON.parse(readFileSync(args.state, 'utf8'))) + '\n');
else if (args.command === 'cleanup') process.stdout.write(cleanupSql(JSON.parse(readFileSync(args.state, 'utf8'))) + '\n');
