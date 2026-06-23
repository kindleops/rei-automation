# Canonical Integration Manifest

**Worktree:** `/Users/ryankindle/rei-automation-canonical`  
**Branch:** `integration/canonical-20260622`  
**Base SHA:** `da5340b6140b73278a76e8eceb3f41aa932da79e`  
**Final SHA:** `20b3239e` (see `git rev-parse HEAD` for full hash)  
**Integration date:** 2026-06-22

## Base verification (Step 0)

| Check | Result |
| --- | --- |
| `da5340b` is exact base | PASS |
| `b972cd1` ancestor of `da5340b` | PASS |
| Outbound 21610 / timestamp repairs (`990625d` ancestry) | Present in base |
| Canonical queue writer | Present in base |
| Multilingual template routing (`b972cd1`) | Present in base |
| Workflow Studio V2 (`c4c1a36` ancestry) | Present in base |
| Universal entity context / shell modules | Present in base |
| Buyer Match clean baseline (`5aafa4e`/`da5340b`) | Present in base |
| Comp Intelligence baseline (`9efe5e6`) | Present in base (superseded by Slice A) |
| Pipeline production lock (`7a94cab` ancestry) | Present in base |

**Missing vs preservation audit (pre-integration):** Comp restore `7dc7a3f`, Campaign release `55aebc6`, stash overlays (`dfd12558`, `1b9b734`).

**Dev env reference (hashes only, no secrets):**

| Worktree | API `.env.local` SHA-256 (prefix) | Dashboard `.env.local` SHA-256 (prefix) |
| --- | --- | --- |
| `rei-automation-inbox-fix` | `ac9e70d0…` | `a6477f8b…` |
| `rei-automation-buyer-match-lock` | matched inbox-fix API hash | matched inbox-fix dashboard hash |

Copied into canonical worktree before integration gates.

## Commit ledger

| SHA | Message | Slice |
| --- | --- | --- |
| `da5340b` | (base) buyer-match production lock | — |
| `f858f93` | fix(api): remove duplicate use_case binding blocking production build | Step 0 baseline repair |
| `2d07ea2` | integrate(comp-intelligence): restore complete canonical implementation | A |
| `684ab09` | integrate(campaign-command): port production control plane without outbound regression | B |
| `97a426e` | integrate(campaign-command): dashboard build coherence and Vercel TS fixes | B |
| `015958e` | integrate(buyer-match): reconcile preserved route and engine corrections | C |
| `423faee` | integrate(pipeline): reconcile preserved pipeline UX and cockpit shared helpers | D (partial) |
| `f4f374d` | fix(api): restore Workflow Studio envelope helpers removed during pipeline slice | D repair |
| `02a271e` | integrate(inbox): canonicalize Workflow Studio V2 workspace routing | D |
| `12c6d88` | fix(api): restore outbound feeder deps hooks for campaign gate proofs | B repair |
| `21226e6` | refactor(core): reconcile canonical shared contracts after integration | §6 |
| `20b3239` | chore(dev): add runtime identity and mixed-worktree drift guard | §8 |

## Slice A — Comp Intelligence (`7dc7a3f`)

**Source SHA:** `7dc7a3f9f9a579a3623f6fb84b73f819e82bd1cb`  
**Commit:** `2d07ea2`

**Included paths:**

- `apps/api/src/lib/domain/comp-intelligence/canonical-subject-property.js`
- `apps/api/src/lib/domain/comp-intelligence/comp-discovery.js`
- `apps/api/src/lib/domain/comp-intelligence/comp-scoring.js`
- `apps/api/src/app/api/cockpit/properties/[property_id]/subject/route.js` (via base + service wiring)
- `apps/dashboard/src/domain/comp-intelligence/direct-pipeline.ts`
- `apps/dashboard/src/domain/comp-intelligence/useCompIntelligence.ts`
- `apps/dashboard/src/views/comp-intelligence/CompIntelligenceWorkspace.tsx`
- `apps/dashboard/src/views/comp-intelligence/comp-intelligence.css`

**Excluded:** Buyer Match dirty work, shell changes, generated/env files, stale Vite proxy edits.

**Tests:** `comp-intelligence-coordinate-resolver.test.mjs`, `comp-intelligence-scoring.test.mjs` — PASS

## Slice B — Campaign Command (`55aebc6`)

**Source SHA:** `55aebc63cfb64e2be46aa5c8db14967d4c6d8c02`  
**Commits:** `684ab09`, `97a426e`

**Included paths:**

- `apps/api/src/lib/domain/campaigns/*` (summary, failures, operator-state, automation-service)
- `apps/api/src/lib/domain/outbound/run-supabase-outbound-feeder.js` (canSend gate only)
- `apps/api/tests/critical/risk-017-campaign-gate.test.mjs`
- `apps/dashboard/src/views/campaign-command/*`
- Dashboard TS coherence files from `55aebc6` (QueuePage, backendClient, canonical-property resolver)

**Explicitly NOT ported:** `canonical-queue-writer.js` deletion, wholesale `canonical-queue-writer` replacement, English fallback, direct queue inserts.

**Tests:** `campaign-command-summary.test.mjs`, `risk-017-campaign-gate.test.mjs`, `send-queue-canonical-writer.test.mjs`, `acquisition-template-routing-correction.test.mjs`, `outbound-production-incident-repair.test.mjs`, `outbound-safety-guards.test.mjs` — PASS (after deps-hook repair)

## Slice C — Buyer Match (stash `1b9b734`)

**Stash object:** `1b9b73477a9f092cc06977f04b45cf2e91c23048` (not applied wholesale)  
**Commit:** `015958e`

**Included paths:**

- Buyer Match API routes (`property/*`, `intel/buyer-match`)
- `apps/api/src/lib/intel/buyer-match-engine.js` (imports comp-intelligence canonical subject)
- `apps/api/src/lib/intel/buyer-match-api-errors.js`, `buyer-match-demand.js`, `buyer-match-job-service.js` (from stash untracked tree)
- `apps/dashboard/src/domain/buyer/buyer-match-errors.ts`

**Excluded:** Stash `canonical-subject-property.js` (Comp Intelligence owns contract)

**Tests:** `buyer-match-production-lock.test.mjs` — PASS

## Slice D — Shell / Inbox / Pipeline (stash `dfd12558`)

**Stash object:** `dfd12558b4fe75046719bfecd732acb8549b86fa` (inspected path-by-path; not applied wholesale)  
**Commit:** `423faee` (+ inbox/WFv2 follow-up pending)

**Ported:**

- Pipeline field resolver, operational KPIs, theme CSS, cockpit `_shared.js` helpers (restored in `f4f374d`)
- `main.tsx` shell-primitives import
- Inbox activity/KPI components from stash where compatible with `55aebc6` dashboard

**Conflicts deferred:** Full `InboxPage.tsx` / `NexusTopBar.tsx` stash versions (patch conflicts); `55aebc6` + WFv2 canonicalization used instead.

**Tests:** Workflow Studio V2 routing/recovery — PASS after inbox/route fixes

## Self-storage exclusion

**Source SHA:** `d3cc075` and related self-storage files — **NOT INTEGRATED**. Documented for post-canonical feature pass.

## Shared contract reconciliation

See `docs/backend/canonical_shared_contracts.md`.

## Reproducibility gate

- Clean worktree required before release validation
- Remove `.next`, `dist`, `.vite` caches before proof build
- Single dev pair: API `:3000`, Dashboard `:5173` from canonical worktree only

## Runtime identity guardrails

- API: `GET /api/cockpit/dev/runtime-identity` (non-production only)
- Dashboard: `DevRuntimeDiagnostics` banner (SHA match/mismatch)
- Startup: `npm run doctor:dev` (`scripts/dev-runtime-doctor.mjs`)