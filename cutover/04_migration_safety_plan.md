# Migration Safety Plan

_Determinism, reproducibility, blast-radius reduction. Planning only._

## 1. Rollback strategy
The cutover is **metadata + file moves only** (no DDL on prod). That makes rollback cheap:

| Step being rolled back | Rollback action |
|---|---|
| Archive move of obsolete files | `git revert`/restore — files return to `migrations/`. Pure git, no DB impact. |
| Baseline file added | Remove the file; no DB impact (never applied to prod). |
| Prod ledger repair (mark baseline applied) | Re-insert the removed `schema_migrations` rows from `PROD_LEDGER_SNAPSHOT.csv`; delete the baseline ledger row. **Ledger-only, reversible, no schema change.** |

**Invariant:** the cutover never runs DDL against prod, so prod schema is never at risk. The only mutable prod object is the `schema_migrations` ledger, and we snapshot it first. Keep `PROD_LEDGER_SNAPSHOT.csv` as the authoritative restore point.

**Hard rule:** never `DROP`/recreate `public` on prod. Baseline adoption on prod is **ledger reconciliation only** (tell Supabase "baseline is already applied"), because prod's schema already equals the baseline.

## 2. Branch validation strategy
Every change to `migrations/**` is validated on a **throwaway Supabase branch** before merge:
1. Create branch (`supabase branches create` or MCP).
2. Connect via psql (creds: `supabase branches get <name>`).
3. `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` → apply migrations in order with `-v ON_ERROR_STOP=1`.
4. Assert: table/view/function counts match the prod-derived expected counts; 0 errors.
5. Delete the branch (cost ~$0.013/hr — always tear down).

This is exactly the procedure already used to validate the baseline (117/70/79, 1 env-dep failure).

## 3. CI replay enforcement (prevents re-drift)
Add a required CI job on every PR touching `apps/api/supabase/migrations/**`:
```
1. Spin an ephemeral Postgres (or Supabase branch).
2. Pre-provision Supabase-isms: schemas auth/extensions/vault/supabase_functions,
   roles anon/authenticated/service_role, default extensions.
3. Apply migrations/ in lexical order, ON_ERROR_STOP=1.
4. Assert 0 failed statements AND expected object counts.
5. Fail the PR on any error or count drift.
```
This is the single control that stops the repo from drifting away from "reproducible from zero" again — the root cause that produced the broken 54-file history.

## 4. Schema drift detection (prod vs migrations)
Scheduled (e.g., nightly) job:
1. `pg_dump --schema-only` from prod → normalized.
2. Replay `migrations/` onto a fresh branch → `pg_dump --schema-only` → normalized.
3. `diff` the two normalized dumps.
4. Non-empty diff → alert (prod changed out-of-band, or a migration wasn't applied).
Normalization = strip comments/whitespace/`\restrict`, sort objects. This catches the exact failure mode that created the current mess (out-of-band prod changes not captured in migrations).

## 5. Future migration naming / versioning rules
- **Format:** 14-digit UTC timestamp prefix `YYYYMMDDHHMMSS_snake_case_description.sql`. **No 8-digit date-only prefixes** (they caused the duplicate-version collisions: `20260428`×5, etc.).
- **Uniqueness:** version prefix MUST be globally unique; CI rejects duplicate prefixes.
- **One concern per migration:** no mega-migrations; each file is independently reviewable and revertible.
- **Forward-only + idempotent-friendly:** prefer `IF NOT EXISTS` / `CREATE OR REPLACE` where semantically safe; never `ALTER` an object a prior migration in the same chain doesn't create.
- **No raw platform-schema DDL** (`supabase_functions`, `auth`, `storage`, `vault`) in schema migrations — guard with existence checks or manage via Supabase config.
- **Generated baseline is immutable:** once `00000000000001_baseline_schema.sql` is adopted, never edit it; all changes are new forward migrations.
- **CI gate (section 3) is required** for merge — non-optional.

## 6. Blast-radius controls
- Cutover work lives on its own branch/worktree (`baseline-cutover-prep`), zero overlap with workflow/theme churn.
- Migration freeze (see `02_…`) during the cutover window.
- Single operator, single sitting, ledger snapshot first.
- Re-generate + re-validate the baseline immediately before adoption (prod may have drifted since this draft).
