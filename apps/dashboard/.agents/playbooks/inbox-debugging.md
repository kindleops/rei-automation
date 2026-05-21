# Playbook: Inbox Debugging

Use this playbook when conversation threads are missing or incorrectly displayed in the UI.

## Step 1: Environment Check
- Verify that `VITE_USE_SUPABASE_DATA` is set to `true` in your `.env` file.
- Check that `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are correct.
- Restart the dev server: `npm run dev`.

## Step 2: Run Proof Script
- Execute the inbox proof script to check for database-level issues:
  ```bash
  node scripts/proof-inbox.mjs
  ```
- If this returns 0 threads, the issue is in the `message_events` table or the view filters.

## Step 3: Check Raw Data
- Run this in the Supabase SQL Editor:
  ```sql
  SELECT count(*) FROM message_events;
  ```
- If data exists, check if RLS is blocking your query:
  ```sql
  SELECT * FROM pg_policies WHERE tablename = 'message_events';
  ```

## Step 4: Verify View Hierarchy
- If raw data exists but doesn't show in `inbox_threads_hydrated`, check the intermediate views:
  1. `deduped_message_events`
  2. `nexus_inbox_threads_v`
- Common issue: `seller_phone_key` is null because `canonical_e164` was not populated.

## Step 5: Frontend Logs
- Open browser dev tools and filter for `[Inbox]`.
- Check for "Fetch error" or empty arrays returned from the Supabase client.
