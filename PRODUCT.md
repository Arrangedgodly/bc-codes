# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: research commits the exact stack (user directive at plan approval: deploy on **GitHub
Pages or Cloudflare**; the app needs a server + DB + email, so Cloudflare full-stack shapes are
the realistic candidates — verify in research). Greenfield — no scaffold yet.

## Users

1. **Artists** — independent musicians and small labels on Bandcamp who generate giveaway
   code sets and want one shareable link instead of manually pasting codes into DMs and
   comments. Comfortable with CSV downloads and email; not necessarily technical.
2. **Fans** — music fans arriving from an artist's link or the directory, usually on a
   phone, wanting a free download in under a minute with no account creation.

## Product Purpose

bc-codes (working title) is a web app where artists upload their Bandcamp giveaway-code
CSV exports per project, and the site dispenses one random code per fan — atomically,
fairly, and with a pipelined path straight to Bandcamp's `/yum` redemption page. It exists
because manual distribution is tedious and one greedy fan can drain a whole batch.
Success: artists go CSV → shareable link in minutes; every fan who plays fair gets a
working code; pools serve many fans, not one.

## Positioning

The only distribution path that atomically enforces one-random-code-per-verified-fan and
deep-links redemption. Pastebins, comment drops, and manual DMs cannot truthfully claim
per-fan fairness or dispense-state correctness (never two fans holding the same code).

## Operating Context

- Artists download CSV exports from Bandcamp's tools page (header block: code-set name,
  dates, `"album: ..."` line, quantities, redeem URL `https://<artist>.bandcamp.com/yum`,
  then one `xxxx-xxxx` lowercase code per line).
- Fans redeem codes on the artist's Bandcamp `/yum` page; redemption adds the album to
  the fan's Bandcamp library for streaming/download.
- Links get shared on socials, Discord, newsletters — arrival is bursty around a drop.
- Both artist and fan flows use email verification codes (OTP); no passwords anywhere.

## Capabilities and Constraints

Confirmed MVP (scoping brief docs/ultron/town-hall.md, approved 2026-08-28):
- Artist: email-OTP sign-in; projects (title, artist name, Bandcamp album URL,
  og:image artwork auto-fetch with text-card fallback); CSV upload (lenient parser,
  deduped, count reported); states draft/active/paused/drained; stats
  total/claimed/reported; pause/resume; shareable project URL.
- Fan: directory of active projects with availability; project page → "Get my code" →
  email + OTP (verify once per browser) → code + copy button + redeem deep-link; revisit
  re-shows same code; "my codes" page (email + OTP, all claims, any device); dead-code
  report → exactly one replacement per project per email; graceful drained/paused/limit
  states.
- Identity & privacy: fan emails stored hash-only (HMAC + server pepper); artist emails
  stored for OTP sign-in; no readable fan PII at rest.
- Hard invariants (test contract): (1) no code dispensed twice even under concurrent
  claims; (2) a verified email cannot exceed 1 code + 1 reissue per project;
  (3) paused/drained projects dispense nothing.
- Non-goals: fan profiles/settings, fan marketing emails, payments/tips, label teams,
  Bandcamp redemption-status sync (no public API), theming, i18n, mobile apps.
- Constraints: small scale (dozens of artists), cheap hosting; transactional email
  dependency for OTP; no Bandcamp API — "claimed" means dispensed by bc-codes.

## Brand Commitments

- Product name "bc-codes" is a **working title** — design must not bake the name into
  anything hard to change (wordmark-agnostic layout, configurable name string).
- Clean slate: no logo, palette, typography, or visual references exist yet.

## Evidence on Hand

- Sample Bandcamp CSV export: /Users/arrangedgodly/Downloads/GetMusic codes.csv
  (to be copied into the repo as a parser fixture during planning).
- Founding artist available for dogfooding (the user's own Bandcamp presence —
  arrangedgodly, album "Taxed, Tolled & Eternally Trolled", 100-code set, 99 redeemed).
- Absences future work must not fabricate: no testimonials, no user counts, no press,
  no logo or brand assets.

## Product Principles

1. Fairness is the product — the dispense invariants outrank every feature.
2. Friction budgets are sacred — artists ≤ 3 min CSV→link; fans ≤ 30 s page→Bandcamp
   (after one email verification per browser).
3. Fans are guests, not accounts — verify, dispense, remember; hold nothing readable.
4. Honest states everywhere — drained says drained, paused says paused; no fake
   scarcity, no fake availability.
5. Small-scale simplicity — choose boring, cheap, operable over growth-first
   architecture until reality says otherwise.

## Accessibility & Inclusion

- Fan flow must survive on a phone with one hand: single large primary action per
   screen; codes in high-contrast monospace; copy button with manual-select fallback.
- Core flows must not depend on CAPTCHAs; rate limiting is server-side and invisible to
  honest fans.
