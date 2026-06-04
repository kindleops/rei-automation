# Baseline Cutover — Readiness Report (master)

_Phase: Baseline Cutover Planning & Isolation. **No prod mutation, no apply, no archive, no ledger repair, no deploy were performed.** This is the go/no-go package for a future cutover._

## TL;DR
- Draft baseline is **generated and proven replayable from zero** (117 tables / 70 views / 79 functions; 1 environment-dependent failure).
- The cutover is **low-risk by design**: it runs **no DDL on prod** — only file moves + a `schema_migrations` ledger reconciliation, both reversible.
- **2 blockers** must be cleared before prod adoption (webhook trigger + GRANTs decision). Everything else is review/process.
- Cutover work is **isolated** on `baseline-cutover-prep` (separate worktree); zero file overlap with the active workflow/theme churn.

## Companion documents
1. `01_contamination_and_isolation.md` — workstream map, ownership overlap, collision zones.
2. `02_migration_classification_and_ordering.md` — obsolete vs must-survive, ordering, archive, freeze.
3. `03_baseline_validation.md` — static + replay validation (task 7).
4. `04_migration_safety_plan.md` — rollback, branch validation, CI replay, drift detection, naming.

## State recap
- Prod: healthy, 117 tables, ledger has 135 records; **history is not reproducible from the repo** (repo's 54 files create only ~57% of tables and fail on the first file). See `project_migration_history_broken` memory.
- Baseline draft: `apps/api/supabase/migrations/00000000000001_baseline_schema.sql` (untracked, ~970 KB). Mirrors prod schema.
- Must-survive forward migrations (not in prod/baseline): `20260603233000_campaign_lifecycle_state_machine.sql`, `20260603234000_campaign_progress_engine.sql`.

## Explicit blockers before prod adoption
| # | Blocker | Why | Resolution |
|---|---|---|---|
| **B1** | `supabase_functions.http_request` webhook trigger (`message_events_to_podio_sync`) | References platform-managed schema absent on fresh envs → the 1 replay failure | Move trigger out of schema baseline; re-establish via Supabase webhook config or a guarded forward migration. |
| **B2** | GRANTs stripped from draft (`--no-privileges`) | If app uses `anon`/`authenticated` (PostgREST), they'd lose table access | Regenerate adoption baseline **with** privileges, or add `00000000000002_grants.sql`. Confirm role model first. |
| **B3** (process) | Prod may drift before cutover | Draft was dumped at a point in time | Re-generate + re-validate baseline immediately before cutover, under migration freeze. |
| **B4** (process) | Parallel agent active in repo | Concurrent edits to `migrations/**` would corrupt the cutover | Enforce migration freeze; single operator; isolated branch. |

Review (not blockers): 13 SECURITY DEFINER funcs (all pin search_path — confirm), 25 RLS-on/no-policy tables (faithful to prod — document), 60 triggers (review AFTER-triggers for recursion).

## Recommended EXACT cutover sequence
> Execute only after B1–B2 cleared and B3–B4 controls in place. Each step gated; abort restores prior state.

### a. Baseline adoption
1. Announce migration freeze on `apps/api/supabase/migrations/**`.
2. Snapshot prod ledger → `migrations_archive/PROD_LEDGER_SNAPSHOT.csv` (read-only `SELECT`).
3. Re-generate baseline from current prod (`pg_dump`/`supabase db dump`, **with privileges**), apply B1 fix.
4. Validate on a throwaway branch: wipe `public`, replay `baseline + 2 must-survive deltas` with `ON_ERROR_STOP=1` → assert 0 errors and expected counts. Delete branch.
5. Place validated baseline at `migrations/00000000000001_baseline_schema.sql`.

### b. Migration archive
6. `git mv` the 52 obsolete files → `apps/api/supabase/migrations_archive/pre_baseline_20260604/` (+ README with provenance + audit link).
7. Keep only `baseline` + the 2 must-survive deltas in `migrations/`.
8. Commit on a dedicated branch; PR through the **CI replay gate** (must be green).

### c. Ledger repair (prod) — _requires explicit approval; ledger-only, no DDL_
9. With prod schema already == baseline, reconcile `schema_migrations` so Supabase treats the baseline as applied and does not attempt to re-run it:
   - Insert baseline version `00000000000001` as applied; mark the archived versions consistently (per `supabase migration repair` semantics).
   - **No schema DDL** runs on prod. Reversible via the snapshot.
10. Confirm the 2 must-survive deltas are then applied to prod (these DO run DDL — small, additive, already branch-validated) **with explicit approval**.

### d. Future migration restart
11. Unfreeze only after CI replay on a fresh branch is green.
12. All new migrations follow the naming/versioning + CI rules in `04_…`; baseline is immutable; forward-only.
13. Enable nightly schema-drift detection (prod vs replayed migrations).

## Go / No-Go
**NO-GO for prod adoption right now** (B1, B2 open; B3/B4 controls not yet established). **GO** to proceed with: clearing B1/B2 on this branch, wiring the CI replay gate, and preparing the archive move as a reviewable PR — all **without touching prod**.

## What this phase did NOT do (by instruction)
No prod mutation · no baseline apply to prod · no ledger repair · no migration archive · no deploy · no feature work.
