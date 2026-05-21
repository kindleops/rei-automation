# Monorepo Vercel Deploy Plan (Review Required)

## Scope
This document defines the deployment plan only for the monorepo at `/Users/ryankindle/rei-automation`.

No deploy is performed by this plan.

## Hard Safety Constraints
- No SMS sends.
- No queue live runs.
- No feeder live inserts.
- No automation flag enablement.
- No migrations.
- No deploy execution until this plan is reviewed and approved.

## 1) Vercel Project Setup
Create or configure two separate Vercel projects from the monorepo:

1. `rei-api`
- Root directory: `apps/api`
- Runtime ownership: backend source of truth for cockpit and seller-facing logic.

2. `rei-dashboard`
- Root directory: `apps/dashboard`
- Runtime ownership: cockpit UI only.

## 2) Required Environment Variables Per Project

### `rei-api` (backend only)
Store backend secrets only in `rei-api`.

Required categories:
- Supabase backend credentials (including service-role level credentials where needed by backend runtime).
- Internal auth/shared secret values used by protected backend routes.
- Provider and integration secrets (TextGrid and any other backend-only integrations).
- Backend operational/env flags needed by `apps/api`.

Rules:
- All secrets remain server-side in `rei-api`.
- Never expose backend secret values to browser bundles.

### `rei-dashboard` (frontend only)
Allowed frontend env only:
- `VITE_BACKEND_API_URL` (points to deployed `rei-api` base URL).
- Frontend-safe public/anon values only (for read-only browser-safe usage).

Blocked in dashboard:
- Supabase service role.
- Backend internal secrets.
- TextGrid/provider auth secrets.
- Any `VITE_*SECRET` secret material.

## 3) Pre-Deploy Checks
Run and require pass before deploy promotion:

1. Monorepo safe build
- `npm run build:safe`

2. API build
- `cd apps/api && npm run build`

3. Cockpit parity tests
- `cd apps/api && node --import ./tests/register-aliases.mjs --test tests/critical/cockpit-parity.test.mjs`

4. Thread-key proofs
- `cd apps/api && node scripts/proof/no-live-legacy-thread-key-writers.mjs`
- `cd apps/api && node scripts/proof/post-thread-key-repair-proof.mjs`

5. Dashboard wiring proof
- `cd /Users/ryankindle/rei-automation && node scripts/proof/dashboard-cockpit-wiring-proof.mjs`

6. Boundary audit
- `cd /Users/ryankindle/rei-automation && npm run boundary:audit`

Gate rule:
- Any failure blocks deployment.

## 4) Deployment Sequence

1. Deploy `rei-api` first (from `apps/api`).
2. Smoke test API cockpit reads:
- `GET /api/cockpit/health`
- `GET /api/cockpit/queue/status`
- `GET /api/cockpit/inbox/live`
3. Confirm API auth behavior is as expected before frontend promotion.
4. Deploy `rei-dashboard` second (from `apps/dashboard`).
5. Verify dashboard startup and network wiring:
- Dashboard loads successfully.
- Calls route to `VITE_BACKEND_API_URL`.
- No local shadow-backend action routing.

## 5) Post-Deploy Smoke Tests

Read/status checks:
- `GET /api/cockpit/health`
- `GET /api/cockpit/queue/status`
- `GET /api/cockpit/inbox/live`

Mutation validation (dry-run only):
- Confirm cockpit mutation endpoints can be called in dry-run mode where supported.
- Confirm no live sending behavior is triggered.

Auth/guard validation:
- Verify unauthenticated mutation requests return `401/403` as expected.
- Verify unavailable backend actions surface `BACKEND_ENDPOINT_NOT_READY` to dashboard users (no fake success).

## 6) Rollback Plan

1. Keep old Vercel projects unchanged during initial rollout.
2. Do not switch production domains until all smoke tests pass.
3. Keep old repositories untouched:
- `/Users/ryankindle/real-estate-automation`
- `/Users/ryankindle/nexus-dashboard`
4. If any critical smoke test fails:
- Halt cutover.
- Keep traffic on previous production targets.
- Fix and re-validate before retry.

## 7) Explicit Blocked Actions During Validation/Deploy Window
- No SMS sending.
- No queue live execution.
- No feeder inserts.
- No auto-reply execution.
- No follow-up execution.
- No Podio sync execution.

## Review Checklist (Go/No-Go)
- Both Vercel project roots correctly set (`apps/api`, `apps/dashboard`).
- Environment boundaries enforced (no backend secrets in dashboard).
- All pre-deploy checks green.
- API-first then dashboard deployment order acknowledged.
- Post-deploy smoke test steps assigned.
- Rollback path confirmed.
