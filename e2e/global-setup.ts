/**
 * QA2 global setup — owns the dev server + the DB channel lifecycle.
 *
 * Boot order matters (V-FE5's poisoned-proxy note): ALL wrangler-CLI D1
 * writes happen while the dev server is DOWN; once `vite dev` is up, the
 * only external DB access is node:sqlite against the live WAL file (reads
 * for assertions + short fixture writes — validated to coexist safely with
 * workerd: WAL mode, SELECTs never contend, writes serialize on the write
 * lock). `wrangler d1 execute --local` is NEVER run against the live server.
 *
 * Exposed to workers via env (children inherit):
 *   E2E_BASE_URL  — http://127.0.0.1:<port>
 *   E2E_DB_PATH   — the miniflare D1 sqlite file (WAL)
 *   E2E_SECRETS   — JSON of .dev.vars (local dev secrets only, never printed)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.E2E_PORT ?? 5317);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const D1_DIR = path.join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const DEV_LOG = '/tmp/bc-codes-qa2-dev-server.log';

function log(message: string) {
	console.log(`[qa2 global-setup] ${message}`);
}

/** The one non-metadata *.sqlite in the D1 state dir that carries the schema. */
function locateD1File(): string | null {
	if (!existsSync(D1_DIR)) return null;
	const candidates = readdirSync(D1_DIR)
		.filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
		.map((name) => path.join(D1_DIR, name))
		.filter((file) => statSync(file).isFile());
	for (const file of candidates) {
		try {
			const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
			const row = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
				.get() as { name: string } | undefined;
			db.close();
			if (row) return file;
		} catch {
			// unreadable candidate — try the next
		}
	}
	return candidates[0] ?? null;
}

function readDevVars(): Record<string, string> {
	const file = path.join(ROOT, '.dev.vars');
	if (!existsSync(file)) {
		throw new Error(
			'.dev.vars missing — copy .dev.vars.example to .dev.vars and fill the three secrets (the dev server refuses to boot without them).'
		);
	}
	return Object.fromEntries(
		readFileSync(file, 'utf8')
			.split('\n')
			.filter((line) => line.includes('=') && !line.startsWith('#'))
			.map((line) => {
				const at = line.indexOf('=');
				return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
			})
	);
}

/**
 * QA2/QA3-scoped cleanup: removes every project/artist these suites ever
 * created (slug/email prefix `qa2-` / `qa3-`), leaving the developer's own
 * dev-DB fixtures (the seeded dogfooding drop + prior tasks' visual fixtures)
 * untouched. otp_pendings/otp_rate_counters are wiped wholesale — dev rate
 * state only, the established convention in this repo's logs. Left behind on
 * purpose: fan_identities/fan_sessions rows (hash-only, cookie-gated, inert —
 * the prior tasks' convention) so reruns stay idempotent without touching
 * anything not ours.
 */
function cleanupQa2State(db: DatabaseSync) {
	db.exec('PRAGMA busy_timeout = 5000');
	const run = (query: string) => db.prepare(query).run();
	run(`DELETE FROM reports WHERE claim_id IN (
		SELECT cl.id FROM claims cl JOIN projects p ON p.id = cl.project_id WHERE p.slug LIKE 'qa2-%' OR p.slug LIKE 'qa3-%')`);
	run(`DELETE FROM claims WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE 'qa2-%' OR slug LIKE 'qa3-%')`);
	run(`DELETE FROM codes WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE 'qa2-%' OR slug LIKE 'qa3-%')`);
	run(`DELETE FROM code_batches WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE 'qa2-%' OR slug LIKE 'qa3-%')`);
	run(`DELETE FROM projects WHERE slug LIKE 'qa2-%' OR slug LIKE 'qa3-%'`);
	run(`DELETE FROM artist_sessions WHERE artist_id IN (SELECT id FROM artists WHERE email LIKE 'qa2-%' OR email LIKE 'qa3-%')`);
	run(`DELETE FROM artists WHERE email LIKE 'qa2-%' OR email LIKE 'qa3-%'`);
	run('DELETE FROM otp_pendings');
	run('DELETE FROM otp_rate_counters');
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`dev server not ready at ${url} within ${timeoutMs}ms — log: ${DEV_LOG}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
	const secrets = readDevVars();

	// 1. Locate (or create) the local D1 — BEFORE any server boots.
	let dbPath = locateD1File();
	let fresh = false;
	if (!dbPath) {
		log('no local D1 found — applying migrations via wrangler (dev server still down)');
		const result = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 120_000
		});
		if (result.status !== 0) {
			throw new Error(`wrangler d1 migrations apply failed:\n${result.stdout}\n${result.stderr}`);
		}
		fresh = true;
		dbPath = locateD1File();
	}
	if (!dbPath) throw new Error('could not locate the local D1 sqlite file after migrations');
	log(`D1: ${path.relative(ROOT, dbPath)}${fresh ? ' (freshly migrated)' : ''}`);

	const db = new DatabaseSync(dbPath, { timeout: 5_000 });
	cleanupQa2State(db);
	db.close();

	// 2. Boot the real dev server (vite dev + platformProxy D1). strictPort
	//    fails fast if something stale holds the port.
	writeFileSync(DEV_LOG, '');
	const logStream = createWriteStream(DEV_LOG, { flags: 'a' });
	const server = spawn(
		process.execPath,
		[path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
		{ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	server.stdout?.pipe(logStream);
	server.stderr?.pipe(logStream);
	const exited = new Promise<number>((resolve) => server.once('exit', resolve));
	let stopping = false;
	void exited.then((code) => {
		if (!stopping && code !== 0 && code !== null) {
			log(`dev server exited early with code ${code} — see ${DEV_LOG}`);
		}
	});

	// 3. Wait for readiness (first request also warms workerd + the app).
	await waitForServer(`${BASE_URL}/`, 60_000);
	log(`dev server ready at ${BASE_URL} (log: ${DEV_LOG})`);

	process.env.E2E_BASE_URL = BASE_URL;
	process.env.E2E_DB_PATH = dbPath;
	process.env.E2E_SECRETS = JSON.stringify(secrets);

	return async () => {
		// Teardown: tidy the dev DB back to baseline, then stop the server.
		try {
			const tdb = new DatabaseSync(dbPath!, { timeout: 5_000 });
			cleanupQa2State(tdb);
			tdb.close();
			log('dev D1 returned to baseline (qa2-* rows removed)');
		} catch (error) {
			log(`teardown cleanup skipped: ${String(error)}`);
		}
		stopping = true;
		server.kill('SIGTERM');
		const killTimer = setTimeout(() => server.kill('SIGKILL'), 5_000);
		await exited;
		clearTimeout(killTimer);
		logStream.end();
		log(`dev server stopped — log: ${DEV_LOG}`);
	};
}
