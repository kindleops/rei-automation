# Migration replay gate

Prevents the migration history from drifting away from "reproducible from zero"
again (the root cause of the pre-baseline breakage: 50% of tables were never
created by any migration, ALTER-before-CREATE, duplicate versions).

## Files
- `replay-validate.sh` — environment-agnostic gate. Given `DB_URL` for a
  **throwaway** database, it drops/recreates `public`, replays every file in
  `../migrations/` in lexical order with `ON_ERROR_STOP=1`, and asserts:
  - ≥ `MIN_TABLES` base tables,
  - all required tables + functions exist,
  - no duplicate migration version prefixes.
  Exits non-zero on any failed statement or missing object.
- `migration-replay.workflow.yml.template` — GitHub Actions gate (move to
  `.github/workflows/migration-replay.yml` to activate). Spins an isolated
  Supabase preview branch per PR touching `migrations/**`, runs the script,
  tears the branch down.

## Why a Supabase branch (not vanilla Postgres)
The baseline faithfully includes Supabase-isms: `GRANT … TO anon/authenticated`,
RLS policies referencing `auth.uid()`, objects in the `extensions` schema, and a
defensive `CREATE EXTENSION pg_net` (Supabase-only). A vanilla Postgres CI would
need a shim (stub roles `anon/authenticated/service_role`, schemas
`auth/extensions/vault`, `auth.uid()`/`auth.role()` stubs, and `pg_net` made
optional). The Supabase-branch gate avoids that fragility and matches prod.

## Local use
```bash
# against a throwaway Supabase branch:
supabase branches create scratch --project-ref <ref> --experimental
DB_URL=$(supabase branches get scratch --project-ref <ref> -o json | jq -r .POSTGRES_URL_NON_POOLING) \
  bash apps/api/supabase/ci/replay-validate.sh
supabase branches delete scratch --project-ref <ref> --experimental
```

## Drift detection (companion, scheduled — see cutover/04_migration_safety_plan.md)
Nightly: `pg_dump --schema-only` prod vs a fresh migration replay; diff normalized
dumps; alert on non-empty diff (catches out-of-band prod changes).
