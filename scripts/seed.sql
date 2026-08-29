-- Dev seed for local D1 (BE1). Idempotent: safe to re-run.
--   npm run db:migrate:local   (first)
--   npm run db:seed
-- Seeds the dogfooding project from PRODUCT.md (arrangedgodly —
-- "Taxed, Tolled & Eternally Trolled") with demo codes, plus a few
-- claims/report so availability meters and states have something real to show.
-- All fan hashes are fake dev values — real ones are HMAC(email, EMAIL_PEPPER).

INSERT OR IGNORE INTO artists (email) VALUES ('dev-artist@bc-codes.test');

INSERT OR IGNORE INTO projects
	(artist_id, title, artist_name, album_url, slug, yum_url, status, artwork_status)
VALUES
	(
		(SELECT id FROM artists WHERE email = 'dev-artist@bc-codes.test'),
		'Taxed, Tolled & Eternally Trolled',
		'arrangedgodly',
		'https://arrangedgodly.bandcamp.com/album/taxed-tolled-eternally-trolled',
		'taxed-tolled-eternally-trolled',
		'https://arrangedgodly.bandcamp.com/yum',
		'active',
		'fallback'
	);

-- One batch row even across re-runs: filename has no UNIQUE constraint (an artist
-- may legitimately re-upload the same filename in production), so guard explicitly.
INSERT INTO code_batches (project_id, filename, code_count)
SELECT
	(SELECT id FROM projects WHERE slug = 'taxed-tolled-eternally-trolled'),
	'GetMusic codes.csv',
	25 -- corrected by the UPDATE at the end regardless of what lands here
WHERE NOT EXISTS (
	SELECT 1 FROM code_batches
	WHERE project_id = (SELECT id FROM projects WHERE slug = 'taxed-tolled-eternally-trolled')
		AND filename = 'GetMusic codes.csv'
);

-- 25 demo codes (d3m0-0001 .. d3m0-0025).
INSERT OR IGNORE INTO codes (project_id, batch_id, code)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 25)
SELECT
	(SELECT id FROM projects WHERE slug = 'taxed-tolled-eternally-trolled'),
	(SELECT MIN(id) FROM code_batches WHERE filename = 'GetMusic codes.csv'),
	'd3m0-' || printf('%04d', n)
FROM seq;

-- Three fake fans.
INSERT OR IGNORE INTO fan_identities (email_hash) VALUES
	('devfanhash0000000000000000000000000000000000000000000000000001'),
	('devfanhash0000000000000000000000000000000000000000000000000002'),
	('devfanhash0000000000000000000000000000000000000000000000000003');

-- Fan 1 claimed d3m0-0001. Fan 2 claimed d3m0-0002, reported it dead, then took
-- the single reissue d3m0-0003. Fan 3 claimed d3m0-0004.
-- NOTE (seed-authoring quirks): keep semicolons out of comments — `wrangler d1
-- execute --file` splits statements naively and in-comment semicolons corrupt
-- the split — and remember SQLite has no column aliases on FROM tables.
-- Re-running must not duplicate: guarded by NOT EXISTS per (project, fan_hash).
INSERT INTO claims (project_id, fan_id, fan_hash, code_id, kind)
SELECT
	(SELECT id FROM projects WHERE slug = 'taxed-tolled-eternally-trolled'),
	f.id,
	f.email_hash,
	(SELECT id FROM codes WHERE code = m.code),
	CASE WHEN m.code = 'd3m0-0003' THEN 'reissue' ELSE 'original' END
FROM fan_identities f
JOIN (
	SELECT 'devfanhash0000000000000000000000000000000000000000000000000001' AS email_hash, 'd3m0-0001' AS code
	UNION ALL
	SELECT 'devfanhash0000000000000000000000000000000000000000000000000002', 'd3m0-0003'
	UNION ALL
	SELECT 'devfanhash0000000000000000000000000000000000000000000000000003', 'd3m0-0004'
) m ON m.email_hash = f.email_hash
WHERE NOT EXISTS (
	SELECT 1 FROM claims x WHERE x.fan_hash = m.email_hash
);

UPDATE codes
SET status = 'claimed', claimed_at = datetime('now')
WHERE code IN ('d3m0-0001', 'd3m0-0003', 'd3m0-0004');

-- The dead code fan 2 originally got, then replaced.
UPDATE codes
SET status = 'reported', claimed_at = datetime('now'), reported_at = datetime('now')
WHERE code = 'd3m0-0002';

INSERT OR IGNORE INTO reports (claim_id, code_id, reason)
SELECT
	(SELECT id FROM claims WHERE fan_hash = 'devfanhash0000000000000000000000000000000000000000000000000002'),
	(SELECT id FROM codes WHERE code = 'd3m0-0002'),
	'seed: reported dead, reissued'
WHERE NOT EXISTS (SELECT 1 FROM reports);

-- Keep batch counts honest whatever happened above.
UPDATE code_batches
SET code_count = (SELECT COUNT(*) FROM codes WHERE codes.batch_id = code_batches.id);
