# Playbook: Supabase Migration

Follow these steps to safely apply database schema changes.

## 1. Preparation
- **Backup**: If operating on production, export the current table schema.
- **Naming**: Use the format `YYYYMMDD_description.sql` (or follow the current `2026MMDD...` pattern).

## 2. Development
- Create the migration file in `supabase/migrations/`.
- Use idempotent SQL (`CREATE OR REPLACE`, `IF NOT EXISTS`).
- **Never** drop tables unless specifically instructed.

## 3. Local Validation
- Run the migration against your local or staging Supabase instance.
- Run the relevant proof script:
  ```bash
  node scripts/proof-routing.mjs  # for routing changes
  node scripts/proof-inbox.mjs    # for inbox/view changes
  ```

## 4. Application
- Copy the SQL into the Supabase Dashboard SQL Editor or use the CLI:
  ```bash
  supabase migration up
  ```

## 5. Verification
- Confirm that the UI still loads data correctly.
- Check for any RLS regressions (permissions being too restrictive or too loose).

## 6. Commit
- Commit the migration file and any updated proof scripts to Git.
