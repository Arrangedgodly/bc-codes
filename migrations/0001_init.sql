-- bc-codes initial schema (BE1)
-- Stack decision + invariants: docs/ultron/research/R1-cloudflare-stack.md
--   - D1 enforces foreign keys by default (no PRAGMA needed).
--   - Timestamps are UTC TEXT via datetime('now').
--   - The 1-code+1-reissue invariant is defended in-schema by UNIQUE(project_id, fan_hash)
--     on claims: one row per (project, fan); a reissue re-points that row to a
--     replacement code and flips kind to 'reissue' (guarded UPDATE ... WHERE kind='original'),
--     so the bound is structural, not just procedural.

-- Artists: email-OTP sign-in (BE3). Artist emails are stored readably (they are the
-- login identity and the contactable party; only FAN emails are hash-only).
CREATE TABLE artists (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	email TEXT NOT NULL UNIQUE, -- normalized lowercase
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_login_at TEXT
);

CREATE TABLE artist_sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE, -- hash of the opaque cookie token; raw token never at rest
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_artist_sessions_artist ON artist_sessions(artist_id);

-- OTP pendings for BOTH populations (BE3 artist / BE4 fan), discriminated by purpose:
--   subject = lowercase email for artists, fan_hash (HMAC) for fans — so no readable
--   fan PII ever lands here either. The 6-digit code itself is stored hashed only.
CREATE TABLE otp_pendings (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	purpose TEXT NOT NULL CHECK (purpose IN ('artist', 'fan')),
	subject TEXT NOT NULL,
	code_hash TEXT NOT NULL, -- HMAC(code, OTP_PEPPER)
	attempts INTEGER NOT NULL DEFAULT 0, -- failed verifies; lockout counter (BE3)
	send_count INTEGER NOT NULL DEFAULT 0, -- sends for this pending; per-identity rate-limit signal (BE3)
	last_sent_at TEXT,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE (purpose, subject) -- one live OTP per identity; resend replaces the row
);
CREATE INDEX idx_otp_pendings_expires ON otp_pendings(expires_at); -- lazy cleanup / cron janitor

-- Projects (BE7): one Bandcamp album drop per project.
CREATE TABLE projects (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	artist_name TEXT NOT NULL, -- display name, may differ from account email owner
	album_url TEXT NOT NULL, -- Bandcamp album page (og:image source for BE8)
	slug TEXT NOT NULL UNIQUE, -- share URL path
	yum_url TEXT NOT NULL, -- https://<artist>.bandcamp.com/yum — FE3 redeem deep-link base
	status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'drained')),
	artwork_url TEXT, -- og:image result (BE8; R2-cached)
	artwork_status TEXT NOT NULL DEFAULT 'pending'
		CHECK (artwork_status IN ('pending', 'fetched', 'fallback')),
	artwork_checked_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_projects_status ON projects(status);

-- One uploaded CSV per batch (BE2/BE7); codes dedupe across batches via codes UNIQUE.
CREATE TABLE code_batches (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	filename TEXT,
	code_count INTEGER NOT NULL, -- codes accepted after dedupe
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_code_batches_project ON code_batches(project_id);

-- Codes: the dispense pool. status is the single source of truth for availability;
-- BE5 dispenses via UPDATE ... WHERE id IN (SELECT ... status='available' ...
-- ORDER BY RANDOM() LIMIT 1) RETURNING inside db.batch() (R1-verified pattern).
CREATE TABLE codes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	batch_id INTEGER NOT NULL REFERENCES code_batches(id) ON DELETE CASCADE,
	code TEXT NOT NULL, -- xxxx-xxxx lowercase
	status TEXT NOT NULL DEFAULT 'available'
		CHECK (status IN ('available', 'claimed', 'reported')),
	claimed_at TEXT,
	reported_at TEXT,
	UNIQUE (project_id, code) -- dedupe across batches within a project
);
CREATE INDEX idx_codes_project_status ON codes(project_id, status);

-- Fans: hash-only identity (HMAC-SHA256(email, EMAIL_PEPPER)) — no readable fan PII at rest.
CREATE TABLE fan_identities (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	email_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_seen_at TEXT
);

CREATE TABLE fan_sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	fan_id INTEGER NOT NULL REFERENCES fan_identities(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE, -- hash of the opaque cookie token
	expires_at TEXT NOT NULL, -- long-lived: verify once per browser (BE4)
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fan_sessions_fan ON fan_sessions(fan_id);

-- Claims: one row per (project, fan) — the 1+1 invariant's structural defense.
-- Original dispense and its single reissue are the SAME row (code_id re-pointed,
-- kind flipped under a `WHERE kind='original'` guard), so a fan can never hold
-- two live codes from one project even under fully concurrent racing claims:
-- the second insert violates UNIQUE(project_id, fan_hash) and the whole dispense
-- batch rolls back (db.batch transactionality, R1-verified).
CREATE TABLE claims (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	fan_id INTEGER NOT NULL REFERENCES fan_identities(id) ON DELETE CASCADE,
	fan_hash TEXT NOT NULL, -- denormalized from fan_identities for the constraint below
	code_id INTEGER NOT NULL UNIQUE REFERENCES codes(id),
	kind TEXT NOT NULL DEFAULT 'original' CHECK (kind IN ('original', 'reissue')),
	claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
	reissued_at TEXT,
	UNIQUE (project_id, fan_hash)
);
CREATE INDEX idx_claims_fan ON claims(fan_id);

-- Reports (BE6): dead-code reports, artist-visible. Exactly one replacement per
-- project per email is bounded by claims.kind (above); UNIQUE(claim_id) additionally
-- makes the report itself once-per-claim, so a second dead replacement cannot
-- trigger another reissue.
CREATE TABLE reports (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	claim_id INTEGER NOT NULL UNIQUE REFERENCES claims(id) ON DELETE CASCADE,
	code_id INTEGER NOT NULL REFERENCES codes(id),
	reason TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reports_code ON reports(code_id);
