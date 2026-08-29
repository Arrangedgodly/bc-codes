-- Claim metadata (BE5): the dispense engine records WHERE a claim came from.
--   ip_hash — HMAC-SHA256(client IP, EMAIL_PEPPER) hex, nullable: abuse
--     analytics without plaintext IPs at rest. EMAIL_PEPPER is reused (it is
--     the one fan-PII pepper; both hashes are unlinkable without the secret).
--   source  — free-form surface tag ('web'), nullable; deliberately no CHECK
--     so later surfaces don't need a migration to enumerate.
-- The claim's created_at already exists as claims.claimed_at (BE1); BE6's
-- reissue flips kind + reissued_at on the SAME row, so no new columns there.

ALTER TABLE claims ADD COLUMN ip_hash TEXT;
ALTER TABLE claims ADD COLUMN source TEXT;
