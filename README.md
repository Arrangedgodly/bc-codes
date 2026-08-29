# bc-codes

Artists upload Bandcamp giveaway-code CSVs; the site dispenses one random code per
verified fan — atomically, fairly, pipelined to Bandcamp's `/yum`. See `PRODUCT.md`
and `docs/ultron/plan.md`.

## Stack

SvelteKit 2 + TypeScript on Cloudflare Workers (Static Assets, not Pages) + D1 +
R2 (artwork cache, reserved) — decided in `docs/ultron/research/R1-cloudflare-stack.md`.
Bindings and secrets are typed in `src/app.d.ts`.

## Developing

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill with `openssl rand -hex 32` values
npm run db:migrate:local         # apply migrations/ to local D1 (.wrangler/state)
npm run db:seed                  # idempotent dev seed (dogfooding project + demo codes)
npm run dev                      # SvelteKit dev server; platform.env emulated via wrangler
```

Useful scripts: `npm run check` (svelte-check), `npm run build` (adapter-cloudflare
build into `.svelte-kit/cloudflare`), `npm run db:migrate` (remote production D1).
Secrets are never committed: `.dev.vars` locally, `wrangler secret put` in
production.

## Deploying (OP1)

Two artifacts, in order — both yours to run (no automation deploys this repo):

1. **`scripts/provision.sh`** — the provisioning wizard for the human-only
   steps: Cloudflare account + scoped API token, `bc-codes` +
   `bc-codes-staging` D1 databases, the `bc-codes-art` R2 bucket, Resend
   account + sending domain + send-only API key, and the four Cloudflare DNS
   records (SPF/DKIM/DMARC per `docs/ultron/research/R2-email-provider.md`).
   Re-runnable; writes the captured values to `.deploy.env` (gitignored).
2. **`docs/ultron/deploy-runbook.md`** — the ordered deploy: build, D1
   migrations, Worker secrets (with generation commands), staging deploy +
   smoke (board, console-OTP, and the safe QA1 250-burst re-run via
   `scripts/burst-smoke.mjs` against real remote D1 — never against
   production data), production deploy, custom domain + SSL, Resend mailer
   enablement, and a post-deploy smoke checklist. Deploys are manual by
   decision (runbook §11 has the rationale).

## Testing

- `npm test` — 269 unit/integration tests (vitest inside workerd via
  `@cloudflare/vitest-plugin`, against real D1; includes the QA1 invariant suite).
- `npm run test:e2e` — the QA2 E2E happy-path journeys plus the QA3 a11y +
  security scans (Playwright chromium, 64 tests): artist CSV → share link; fan
  claim → slab → redeem; my-codes on a new device; report → reissue; drained;
  axe + keyboard/focus/reduced-motion journeys; CSP + header posture. The
  harness boots its own `vite dev` (local D1, port 5317), runs every journey at
  1440×900 AND 390×844, twice each, and restores the dev D1 afterwards.
  Requirements: Node ≥ 24 (`node:sqlite`), a one-time
  `npx playwright install chromium`, and `.dev.vars` present. Lives in `e2e/`
  (outside svelte-check/vitest scopes).
