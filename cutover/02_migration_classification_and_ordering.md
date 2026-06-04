# Migration Classification, Ordering, Archive & Freeze

_Discovery/planning only. Nothing is moved, archived, or applied in this phase._

## Context
The draft baseline `00000000000001_baseline_schema.sql` was generated from the **live prod schema** and validated as replayable from zero (117 tables / 70 views / 79 functions; see `03_baseline_validation.md`). Because it mirrors prod exactly, **every object already in prod is, by definition, in the baseline.** That collapses the classification below to a simple test: _is the migration's object already in prod?_

## 1. Classification of the 54 existing repo migrations

### A. OBSOLETE after baseline adoption (52 files)
All migration files whose objects already exist in prod — superseded by the baseline. Verified spot-checks present in baseline: `campaign_target_graph`, `send_queue`, `message_events`, `inbox_thread_state`, `email_queue/senders/templates/emails` (brevo layer), dashboard view-models. These should be **archived** (not deleted) once the baseline is adopted.

> These files also carry the defects from the migration-history audit (ordering violation at `20260419`, 6 duplicate version prefixes, 57 never-created tables, mixed formats). They are unsafe to replay and must not remain in the active chain after baseline adoption.

### B. MUST-SURVIVE — live logic NOT represented in baseline (2 files)
Confirmed by grep: all 8 objects return **0** occurrences in the baseline (branch-validated, never applied to prod):

| Migration | Objects absent from baseline |
|---|---|
| `20260603233000_campaign_lifecycle_state_machine.sql` | `campaign_transition_status`, `campaign_acquire/renew/release_execution_lock`, `campaign_status_transitions`, lifecycle columns (`hydration_cursor`, `execution_lock_token`, `activation_attempt_count`, …) |
| `20260603234000_campaign_progress_engine.sql` | `campaign_recompute_progress`, `campaign_runtime_summary`, `idx_send_queue_campaign_id` |

These become the **first forward migrations applied on top of the baseline.**

### C. Migrations with live business logic still not in baseline
Only the two in (B). Everything else is schema already captured by the baseline. (The email/brevo layer and view-models are in the baseline → already in prod → obsolete.)

## 2. Proposed post-baseline migration ordering
```
apps/api/supabase/migrations/
  00000000000001_baseline_schema.sql            # squashed prod baseline (adopted)
  20260603233000_campaign_lifecycle_state_machine.sql   # must-survive forward #1
  20260603234000_campaign_progress_engine.sql           # must-survive forward #2
  <future timestamped migrations…>
```
The `00000000000001` prefix sorts before every real timestamp, guaranteeing the baseline runs first on any fresh replay; the two must-survive deltas then apply cleanly (they only ADD lifecycle/progress objects that the baseline doesn't contain).

> Pre-adoption fix required for the must-survive deltas: `20260603233000` includes legacy-status canonicalization in `campaign_transition_status` that assumes the lifecycle columns exist — fine, it creates them in the same file. No dependency on the obsolete files. Verified independent.

## 3. Proposed archive structure
```
apps/api/supabase/
  migrations/
    00000000000001_baseline_schema.sql
    20260603233000_campaign_lifecycle_state_machine.sql
    20260603234000_campaign_progress_engine.sql
  migrations_archive/
    pre_baseline_20260604/        # the 52 obsolete files, verbatim, read-only
      README.md                   # provenance: why archived, audit link, prod ledger snapshot
      20260419_add_podio_sync_columns_to_message_events.sql
      … (all 52)
    PROD_LEDGER_SNAPSHOT.csv       # supabase_migrations.schema_migrations @ cutover (135 rows)
```
Archiving (not deleting) preserves provenance and the audit trail. The Supabase migration runner only reads `migrations/`, so the archive is inert.

## 4. Proposed migration freeze protocol (during cutover window)
1. **Announce freeze** on `apps/api/supabase/migrations/**` across all agents/worktrees.
2. **Snapshot** the prod ledger (`schema_migrations`) → `PROD_LEDGER_SNAPSHOT.csv`.
3. **Re-generate** the baseline immediately before cutover (prod may have drifted) and re-validate on a throwaway branch — the baseline must be generated from the exact prod state being frozen.
4. **No new migrations** authored until cutover completes; queue them as drafts outside `migrations/`.
5. **Single operator** performs the cutover (archive move + ledger repair) in one sitting; no concurrent migration edits.
6. **Unfreeze** only after CI replay on a fresh branch is green.

## 5. Cross-checks performed
- Baseline contains all 8 spot-checked prod tables; absent for all 8 Phase-2A/2C objects (correct).
- No duplicate index/constraint names in baseline (see validation report).
- The two must-survive deltas have **no path overlap** with the parallel workflow/theme churn → cutover is isolatable.
