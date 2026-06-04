# Baseline Cutover — PR-Ready Summary

_Branch `baseline-cutover-prep` (isolated worktree). **No prod mutation, no apply to prod, no ledger repair, no deploy.** B1/B2 cleared; archive prepared; chain validated._

## Blockers cleared
### B1 — webhook / platform dependency ✅
- Removed `CREATE TRIGGER message_events_to_podio_sync` (calls `supabase_functions.http_request`) from the baseline.
- Relocated to a **guarded, idempotent** forward migration `20260604000000_optional_message_events_podio_webhook.sql` — installs only when the platform function exists, else logs a NOTICE (exception-guarded). Fresh replay on a bare branch: **skipped, 0 errors**.
- Also stripped 12 `ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"` statements (B1b) — Supabase-managed, `permission denied` on bare replay. Kept the 12 `FOR ROLE "postgres"` ones (auto-grant future objects to anon/authenticated; matches prod).

### B2 — grants/privileges ✅ (verified, not guessed)
- Dashboard uses `VITE_SUPABASE_ANON_KEY` and makes **217 direct `.from()` reads** of public tables; API uses `service_role`. Prod even has a `grant_anon_read_access_for_dashboard` migration.
- **Conclusion: anon/authenticated access is required.** Regenerated the baseline **WITH privileges** (`pg_dump` without `--no-privileges`): **784 GRANT/REVOKE lines, 278 anon / 287 authenticated grants** included.

## Files moved (52 obsolete → archive)
`git mv apps/api/supabase/migrations/<obsolete>.sql → apps/api/supabase/migrations_archive/pre_baseline/` (history preserved). Added `migrations_archive/pre_baseline/README.md` (provenance + audit link).

## Migrations kept (active chain — 4 files)
```
migrations/00000000000001_baseline_schema.sql                      # squashed prod baseline, WITH grants, webhook removed
migrations/20260603233000_campaign_lifecycle_state_machine.sql     # forward delta (not in prod)
migrations/20260603234000_campaign_progress_engine.sql             # forward delta (not in prod)
migrations/20260604000000_optional_message_events_podio_webhook.sql # guarded optional webhook (B1)
```

## CI replay gate added
- `apps/api/supabase/ci/replay-validate.sh` — env-agnostic from-zero replay + assertions (≥117 tables, required tables/functions, unique versions).
- `apps/api/supabase/ci/migration-replay.workflow.yml.template` — per-PR Supabase-branch gate (move to `.github/workflows/` to activate).
- `apps/api/supabase/ci/README.md`.

## Validation result (throwaway branch, wiped public → replayed 4-file chain from zero)
| Metric | Result |
|---|---|
| Tables | **118** (117 baseline + `campaign_status_transitions`) |
| Views | **71** (70 + `campaign_runtime_summary`) |
| Functions | **84** (79 + 5 lifecycle/progress) |
| Required tables | campaigns, properties, prospects, phones, master_owners, send_queue, message_events, campaign_target_graph → **all ✅** |
| `campaign_transition_status()` / `campaign_recompute_progress()` / `campaign_acquire_execution_lock()` | **present ✅** |
| anon grants applied | **1,276 table grants** |
| Webhook trigger | **skipped with NOTICE** (no supabase_functions on branch) |
| Failed statements | **0** _(after B1/B1b fixes; pre-fix run had exactly the 12 supabase_admin ADP errors that were then removed)_ |

> Note: branch direct-IPv6 connections were intermittently timing out (known machine-network flakiness); the stable validation path is the pooler **session-mode** URL (`…pooler.supabase.com:5432`).

## Remaining prod-adoption steps (NOT done here — require explicit approval)
1. **Migration freeze** on `apps/api/supabase/migrations/**` (a second agent is active in the repo).
2. **Re-generate baseline from current prod** under freeze (it may have drifted) WITH privileges + B1 fix; re-validate via the CI gate.
3. **Apply forward deltas to prod** (`20260603233000`, `20260603234000`, `20260604000000`) — real but small additive DDL, already branch-validated.
4. **Ledger repair** (below) — ledger-only, no schema DDL.
5. Activate the CI gate + nightly drift detection; unfreeze.

## Exact prod ledger-repair command proposal — DO NOT RUN
```bash
# 0. snapshot the ledger (restore point) — READ ONLY
psql "$PROD_DB_URL" -c "\copy (select * from supabase_migrations.schema_migrations order by version) \
  to 'apps/api/supabase/migrations_archive/pre_baseline/PROD_LEDGER_SNAPSHOT.csv' csv header"

# 1. mark the baseline as ALREADY-APPLIED so Supabase never re-runs it
#    (prod schema already == baseline; this writes ONLY the ledger, no DDL)
supabase migration repair --status applied 00000000000001 --project-ref <PROD_REF>

# 2. apply the 3 forward migrations to prod (REAL additive DDL — requires approval)
supabase db push --project-ref <PROD_REF>     # applies 233000, 234000, webhook; baseline is skipped (already applied)
```
**Open decision before running:** prod's ledger holds **135 historical records** whose `.sql` files never matched the repo. They don't correspond to local files; the safe default is to **leave them** (harmless history) and only ensure the 4 local versions are marked correctly. Confirm `supabase db push` does not attempt to reconcile/cleanup those 135 orphans before running (dry-run / `--dry-run` first).

## Rollback
All cutover changes are git file moves + one ledger row → revert via git + re-insert ledger rows from `PROD_LEDGER_SNAPSHOT.csv`. **No prod schema DDL is performed by the cutover itself** (the 3 deltas are separate, approved, branch-validated).
