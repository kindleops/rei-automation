# Supabase Inbox Data Setup Guide

## Overview
The inbox requires the `message_events` table in Supabase to load conversation threads. A migration has been created and needs to be applied to your Supabase project.

## Quick Setup

### Option 1: Via Supabase Dashboard (Recommended)

1. Go to [app.supabase.com](https://app.supabase.com)
2. Select your project (LCPPDRMRDFBLSTPCBGPF)
3. Click **SQL** in the left sidebar
4. Click **+ New Query**
5. Copy the entire content of `supabase/migrations/20260429_create_message_events_table.sql`
6. Paste it into the editor
7. Click **Run** (⌘↵ or Ctrl+Enter)

### Option 2: Via Terminal (Requires Supabase CLI)

```bash
# Install Supabase CLI if not already installed
npm install -g supabase

# Link your project
supabase link --project-ref lcppdrmrdfblstpcbgpf

# Apply migrations
supabase migration up
```

## What Gets Created

Running the migration creates:

### `message_events` Table
- **Columns:**
  - `id` (UUID primary key)
  - `event_timestamp` (when message occurred)
  - `message_body` (SMS text content)
  - `from_phone_number` (sender)
  - `to_phone_number` (recipient)
  - `direction` (inbound/outbound)
  - `master_owner_id` (agent/owner)
  - `prospect_id` (lead)
  - `property_id` (property reference)
  - `canonical_e164` (normalized phone)
  - `our_number` (business number)
  - `delivery_status` (SMS delivery state)
  - `source_app` (textgrid, twilio, etc)
  - `metadata` (JSON for extensibility)

### Indexes (for performance)
- `created_at DESC` - Primary query filter
- `event_timestamp DESC` - Alternative timestamp
- `(from_phone_number, to_phone_number)` - Thread grouping
- `canonical_e164` - Phone lookup
- `master_owner_id` - Owner filtering
- `property_id` - Property filtering

### RLS Policy
- **Public SELECT** via anonymous key (allows inbox to read data)

### Sample Data
8 conversation threads between 3 prospects and your business:
- Thread 1: Interested in 123 Main St ($450k)
- Thread 2: Neighborhood questions
- Thread 3: Scheduling viewing

## Verification

After applying the migration, verify in the dashboard:

1. Go to **SQL Editor**
2. Run:
```sql
select count(*) as message_count from public.message_events;
```

Expected result: `8` (sample records)

## Next Steps

Once the migration is applied:

1. Refresh the inbox page: `http://localhost:5173/inbox`
2. Check browser console for logs starting with `[Inbox Live Data Gate]`
3. Threads should now load from Supabase (not mock data)

## Troubleshooting

### No threads appearing
- Check console: Are there `[fetchInboxModel]` logs?
- Verify RLS policy exists:
```sql
select * from pg_policies where tablename = 'message_events';
```

### "message_events table doesn't exist" error
- Migration wasn't applied correctly
- Re-run the SQL from `supabase/migrations/20260429_create_message_events_table.sql`

### Query errors about missing columns
- Old schema version cached in code
- Restart dev server: `npm run dev`

## Real Data Integration

When connecting to your real message service:

1. Update table schema in migration as needed
2. Populate via ETL/API integration (don't use `on conflict do nothing`)
3. Keep RLS policy for security (`is_authenticated` recommended for production)

## Reference

- Migration file: `supabase/migrations/20260429_create_message_events_table.sql`
- Inbox data loader: `src/lib/data/inboxData.ts (getInboxThreads)`
- Adapter: `src/modules/inbox/inbox.adapter.ts (loadInbox)`
