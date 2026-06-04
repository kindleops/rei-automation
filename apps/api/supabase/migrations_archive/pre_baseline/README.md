# Pre-baseline migration archive

These 52 files are the **pre-baseline migration history**, archived (not deleted) for provenance when the squashed production baseline (`migrations/00000000000001_baseline_schema.sql`) was adopted.

## Why archived
A migration-history audit (2026-06-04) found this chain is **not reproducible from zero**:
- The first file `20260419_add_podio_sync_columns_to_message_events.sql` ALTERs `message_events`, which no file in this set ever CREATEs (ordering/dependency violation) → fresh replay fails immediately.
- 57 of prod's 114 tables were never created by any file here (~50% missing).
- Duplicate version prefixes (`20260428`×5, `20260422`×3, `20260421`×2, `20260426`×2, `20260504`×2, `20260506`×2) and mixed 8-/14-digit formats.
- The repo set diverged from prod's real 135-migration ledger.

All schema objects these files *would* have created already exist in production and are therefore captured by the baseline. See `cutover/00_CUTOVER_READINESS.md` and the `project_migration_history_broken` engineering note.

## Status
**Inert.** The Supabase migration runner only reads `apps/api/supabase/migrations/`. These files are kept for history/audit only and must not be moved back into the active chain.

## Active chain after baseline
```
migrations/00000000000001_baseline_schema.sql                     # squashed prod baseline (WITH grants)
migrations/20260603233000_campaign_lifecycle_state_machine.sql    # forward delta (not in prod yet)
migrations/20260603234000_campaign_progress_engine.sql            # forward delta (not in prod yet)
migrations/20260604000000_optional_message_events_podio_webhook.sql  # guarded optional webhook (B1)
```
