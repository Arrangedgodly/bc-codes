-- OTP send-rate accounting (BE3). Fixed-window counters for the scopes the
-- rate-limit matrix needs beyond the per-subject columns already on
-- otp_pendings (see src/lib/server/otp.ts for the full matrix + rationale):
--   scope 'ip10m:<address>' -> per-IP short window (5 sends / 10 min)
--   scope 'ip1d:<address>'  -> per-IP daily window (20 sends / 24 h)
--   scope 'global1d'        -> whole-app daily window (80 sends / 24 h, keeping
--                              actual OTP mail comfortably under Resend's free
--                              100/day cap — R2: docs/ultron/research/R2-email-provider.md)
-- The scope encodes the window LENGTH as well as the subject so a short window
-- starting exactly at UTC midnight never shares a row with the daily window.
-- Counters are incremented atomically (INSERT ... ON CONFLICT DO UPDATE ...
-- RETURNING) and checked after increment, so a blocked attempt consumes its own
-- quota — conservative by design. Rows for closed windows are lazily deleted.
CREATE TABLE otp_rate_counters (
	scope TEXT NOT NULL, -- 'ip:<address>' | 'global'
	window_start TEXT NOT NULL, -- UTC fixed-window start, 'YYYY-MM-DD HH:MM:SS'
	sends INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (scope, window_start)
);
