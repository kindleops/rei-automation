# Closing Desk — Foundation Audit, Architecture & Integration Contract

Read-only / shadow-first build. **Nothing here sends, signs, contacts a counterparty,
mutates production pipeline state, marks clear-to-close/closed, confirms revenue,
moves money, or deploys.** Every future write/send is modeled as a
`ProposedClosingAction` (`requiresApproval: true`, `executed: false`).

---

## Phase 0 — Caller-backed audit

### Source of truth (verified by reading the code, not UI labels)

| Concern | Real source of truth | Evidence |
|---|---|---|
| Universal lifecycle (Stages 1–10) | `apps/api/.../opportunity/universal-pipeline-registry.js` | `UNIVERSAL_STAGE_CODES` incl. `formal_contract, under_contract, disposition, prepared_to_close, closed` |
| Canonical pipeline rows (Supabase) | `public.acquisition_opportunities` | migration `20260621120000_canonical_acquisition_opportunities.sql` |
| Immutable history pattern | `public.acquisition_opportunity_history` | same migration — `idempotency_key text UNIQUE`, append-only |
| Closings | **Podio** `@/lib/podio/apps/closings.js` | `domain/closings/*` (`update-closing-status`, `create-closing-from-title-routing`, `sync-closing-milestones`) |
| Contracts + e-signature | **Podio** contracts + **DocuSign** | `domain/contracts/*` (`create-docusign-envelope-from-contract`, `handle-docusign-webhook`) |
| Title / escrow | **Podio** `title-routing` | `domain/title/*` |
| Disposition / buyers / EMD / assignment | **Podio** `buyer-match` | `domain/buyers/*`, `domain/offers/*` |
| Revenue | **Podio** `deal-revenue` | `domain/revenue/create-deal-revenue-from-closed-closing.js` |
| Dashboard read path | `domain/<x>/<x>-api.ts` → `callBackend('/api/cockpit/...')` → cockpit route → service | `pipeline-opportunity-api.ts`, `usePipelineOpportunities.ts` |

### Key findings / unsafe assumptions corrected

1. **The prompt said "SignPro"; closing execution uses DocuSign.** "SignPro" exists only as a
   static label in the dashboard integrations catalog (`src/data/commandStore.ts:484`,
   `'DocuSign / SignPro'`, status `needs_auth`) — there is **zero** SignPro code on the backend
   and no closing-execution wiring. Treat the catalog label as marketing, not an integration.
2. **CORRECTION (verified against prod 2026-06-25):** the original claim that
   `acquisition_stage` "caps at `contract_to_close`" was based on the **stale repo migration
   20260621120000**. The **live** CHECK allows the full universal set
   (`…, formal_contract, under_contract, disposition, prepared_to_close, closed`, plus legacy
   aliases incl. `contract_to_close`). So Supabase *can* represent Stages 6–10 distinctly. It
   still carries **none** of the deep title/escrow/disposition/funding/revenue fields — that
   state lives in **Podio**.
2b. **The bigger reality:** prod `acquisition_opportunities` holds **0 rows** in the closing band
   (`formal_contract … prepared_to_close`); the only populated post-contract stage is `closed`
   (476 rows), and **all 476 are `dead` (349) or `suppressed` (127)** — i.e. terminal/lost leads,
   **no closed-won deals**. So acquisition_opportunities is *not* a live closing data source today;
   the live Closing Desk is correctly empty until the Podio → `closing_cases` projection exists.
3. **No `closing_*` Supabase tables exist** (grep of all 96 migrations confirms). So a queryable
   Closing Desk shadow does not yet exist.
4. **Do not assume data exists because a UI label exists** — the deep closing fields are projected
   as `absent` with a degraded diagnostic, never fabricated.
5. **Migration history is known-broken** (see memory `project_migration_history_broken`); the
   proposed migration is additive and `PROPOSED_`-prefixed so the runner ignores it.

### Reusable modules (no duplication)

Reused, not re-implemented: `universal-pipeline-registry.js` (stage codes), `listOpportunities` /
`getOpportunityById` (read), `callBackend` (transport), `ensureMutationAuth`/`corsHeaders` (auth),
`acquisition_opportunity_history` (immutable-event pattern the new tables mirror).

---

## Architecture (what was built)

```
apps/dashboard/src/domain/closing-desk/        ← pure, deterministic, fully tested
  closing-desk.types.ts      canonical aggregate + milestone/issue/health/summary/action contract
  closing-milestones.ts      immutable milestone catalog + idempotency key + dedupe
  closing-issues.ts          issue catalog + severity ordering + blocker selection
  closing-board.ts           stage/status/issues → operator board lane (derived, not stored)
  closing-health.ts          deterministic 0–100 health w/ fully-traceable factors
  closing-projection.ts      acquisition_opportunities row → ClosingCase (+ provenance/degraded)
  closing-summary.ts         header metrics from cases (each metric names its source)
  closing-copilot.ts         read-only, fact-citing reasoning + ProposedClosingAction (never executes)
  closing-fixtures.ts        DEMO-ONLY fixtures, unmistakably labeled
  closing-desk-api.ts        read data-layer; degrades to labeled fixtures, never silent mock

apps/dashboard/src/views/closing-desk/
  ClosingDeskView.tsx        header command layer, board/table, filters, ?demo=1 affordance
  components/ClosingCaseWorkspace.tsx   14-section dossier + health explanation + copilot
  components/ClosingHealthBadge.tsx
  hooks/useClosingDesk.ts    fetch + filter state
  styles/closing-desk.css    scoped, consumes Nexus tokens (theme/accent/glass/light/dark)

apps/api/src/app/api/cockpit/closing-desk/     ← read-only endpoints (reuse listOpportunities)
  summary/route.js, cases/route.js, cases/[id]/route.js, _shared.js

apps/api/supabase/migrations/PROPOSED_20260626000000_closing_desk_foundation.sql   ← NOT applied
```

---

## Audit addendum — schema reconciliation (read-only verified 2026-06-25)

The proposed `closing_*` tables do not duplicate any existing `closing*/contract*/title*/
escrow*/disposition*/revenue*/milestone*` table (none exist). **But** two existing canonical
Supabase families must be referenced, not duplicated:

* **`wire_events` / `wire_accounts`** already model funding/wires and key by **Podio item IDs**
  (`closing_id bigint, deal_revenue_id bigint, title_company_id bigint, buyer_id bigint`,
  plus `amount, direction, status, expected_at, received_at, cleared_at`). Therefore:
  - The canonical cross-table closing key in Supabase is the **Podio closing item id (bigint)**,
    not the acquisition_opportunities uuid. `closing_cases` must carry `podio_closing_item_id bigint`
    and the projection must join `wire_events` on it.
  - `closing_cases.funding_status / funding_date / confirmed_gross_revenue` and any wire money
    movement should be **derived from `wire_events`** (read-model), never an independent source.
* **`buyer_match_runs` / `buyer_property_matches` (+ buyer_* family)** already model disposition
  richly (`match_score, disposition_strategy, target_price, deal_grade, …`). `closing_cases`
  should **reference** `buyer_match_runs.buyer_match_run_id` and mirror disposition read-only —
  not re-store buyer-matching state. (Matches the "Disposition stays its own workspace" rule.)

**Revised schema deltas required before applying the migration:**
1. Add `closing_cases.podio_closing_item_id bigint UNIQUE` (the projection/join key for `wire_events`).
2. Demote funding/revenue-wire columns to **derived** (sourced from `wire_events`) or drop them
   from `closing_cases` and read live from `wire_events`.
3. Make disposition fields references to `buyer_match_runs` rather than independent stores.
4. Keep `closing_milestones` / `closing_issues` / `closing_activity_events` as proposed (no existing
   equivalent; correct immutable/idempotency pattern).

## Integration contract (handoffs for Composer 2.5)

For each handoff: prerequisites · source event · source of truth · resulting stage · generated
milestone · proposed actions · review gate · failure/recovery · idempotency.

| Handoff | Prereqs | Authoritative source event | Resulting stage | Milestone | Review gate |
|---|---|---|---|---|---|
| **5 Offer → 6 Formal Contract** | accepted/verbal/contract-requested with evidence | DocuSign envelope created (`create-docusign-envelope-from-contract`) | `formal_contract` | `contract_generated` / `contract_sent` | human approval — never a classifier guess |
| **6 → 7 Under Contract** | contract fully executed | DocuSign `completed` webhook (`handle-docusign-webhook`) | `under_contract` | `contract_fully_executed`, `closing_case_created` | persisted signed PDF required |
| **7 → 8 Disposition** | executed contract + title opened | buyer-match started (`domain/buyers/match-engine`) | `disposition` | `buyer_match_started` / `buyer_selected` | Disposition stays its own workspace; mirrored read-only here |
| **8 → 9 Prepared to Close** | buyer secured + EMD + title cleared | `select-title-company` + title commitment (`title-routing`) + closing scheduled | `prepared_to_close` | `closing_scheduled`, `settlement_statement_*`, `clear_to_close` | clear-to-close requires settlement statement + readiness, manual approval |
| **9 → 10 Closed** | funded + recorded | `update-closing-status` → Completed → `create-deal-revenue-from-closed-closing` | `closed` | `funded`, `recorded`, `revenue_confirmed`, `closing_completed` | revenue confirmed only from persisted wire evidence |

**Hard rule:** contract / signature / title / funding / recording / revenue progression must come
from authoritative persisted evidence (DocuSign webhook, Podio status, deal_revenue wire) —
**never** because a text classifier guessed an event occurred. Idempotency: every milestone uses
`buildMilestoneIdempotencyKey` so re-projection is a no-op.

### Composer 2.5 connect plan

1. Apply the `PROPOSED_` migration (rename to a real timestamp; reconcile against the broken
   migration history first).
2. Build the **Podio → `closing_cases` projection job** (one-way, additive) emitting milestones
   via the idempotency key and issues via the canonical catalog.
3. Point `cockpit/closing-desk/*` at `closing_cases` (replacing the `acquisition_opportunities`
   fallback) and set `provenance.fully_backed = true` per resolved field.
4. Implement `ProposedClosingAction` execution **behind explicit operator approval + the existing
   `validateStageTransition` gates** — still no auto-send.

---

## Tests & verification

- Unit (pure logic): `npx tsx tests/unit/closing-desk.test.ts` → **21/21 pass** (health, stage
  mapping, milestone idempotency, missing-data, blocker ordering, revenue, SLA/dates, no-mock-in-live,
  copilot read-only invariants).
- UI: `npx playwright test --config playwright.dev.config.ts closing-desk.spec.ts` → **4/4 pass**
  (load + read-only/no-mutation/no-external-comm assertions, board↔table + filters, case workspace
  w/ milestones/issues/financials/health reasoning + disabled execution, light/dark/mobile, no console errors).
- Typecheck: closing-desk code is **0 errors** under both `tsc --noEmit` and strict `tsc -b`.
  (The repo's full `vite build` is currently red due to **pre-existing** WIP errors in
  `fetchQueueModel.ts`, `view-layout.ts`, `InboxPage.tsx`, etc. — unrelated to this work.)
