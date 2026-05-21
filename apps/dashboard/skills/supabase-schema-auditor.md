# Supabase Schema Auditor

## Purpose
Ensure that the Supabase database schema, views, and Row Level Security (RLS) policies are correctly configured and in sync with the application's expectations, specifically for the Inbox and message handling systems.

## When to use
- After applying a new migration.
- When the Inbox fails to load threads or messages.
- Before implementing major changes to the data layer.
- When "table not found" or "permission denied" errors appear in the browser console.

## Exact steps
1. **Connectivity Check**: Run the Supabase connectivity test to ensure the environment variables are correct and the database is reachable.
   ```bash
   node scripts/test-supabase.mjs
   ```
2. **Table Verification**: Confirm that core tables exist and have the expected row counts.
   - `message_events`
   - `inbox_thread_state`
3. **View Verification**: Confirm that the "truth" views are valid and returning data.
   - `nexus_inbox_threads_v` (Core thread grouping)
   - `inbox_threads_hydrated` (Thread data joined with property/owner info)
   - `inbox_category_counts` (Sidebar counts)
4. **RLS Audit**: Check that the `anon` key has `SELECT` access to the necessary tables and views.
   ```sql
   -- Run in Supabase SQL Editor
   select * from pg_policies where schemaname = 'public';
   ```
5. **Deduplication Check**: Ensure the deduplication logic is active.
   ```bash
   node scripts/proof/inbox-integrity.mjs
   ```

## Safety rules
- **Never** run `DROP TABLE` or `TRUNCATE` on production tables.
- **Always** backup or script the current view definition before using `CREATE OR REPLACE VIEW`.
- **Avoid** modifying `message_events` directly; use migrations for schema changes.

## Commands to run
- `node scripts/test-supabase.mjs`: Basic connectivity and table check.
- `node scripts/check-view.mjs`: Detailed check for a specific view.
- `node scripts/proof/inbox-integrity.mjs`: Validates thread counts and deduplication.
- `npm run setup:inbox`: (Optional) Re-initializes the inbox table and sample data if needed.

## Proof requirements
- Successful output from `scripts/test-supabase.mjs` showing "Table accessible" and "Found X messages".
- Successful output from `scripts/proof/inbox-integrity.mjs` showing "Count Match" and "Deduplication is active".

## “Do not” rules
- Do not ignore RLS errors; they are often the root cause of "empty inbox" bugs.
- Do not assume `inbox_threads_hydrated` is correct if `nexus_inbox_threads_v` is broken (it depends on it).
- Do not commit changes to `message_events` without updating the corresponding migration files.
