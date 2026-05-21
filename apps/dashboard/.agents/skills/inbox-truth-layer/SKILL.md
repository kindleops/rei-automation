# Inbox Truth Layer

## Overview
This skill governs the core data hierarchy that powers the Nexus Dashboard Inbox. All inbox state is deterministically derived from raw `message_events`.

## Architecture Truth Hierarchy

1. **`message_events` (Table)**
   - The absolute source of truth. Raw webhook payloads from TextGrid/Twilio are inserted here.
   - **Key Columns**: `id`, `direction`, `event_timestamp`, `message_body`, `delivery_status`, `from_phone_number`, `to_phone_number`, `master_owner_id`, `property_id`.

2. **`deduped_message_events` (View)**
   - Handles the reality that SMS providers send multiple webhooks per message (queued -> sent -> delivered).
   - **Dedupe Logic**: Partitions by `queue_id` or `id`, ordering by delivery status priority (`delivered` > `queued` > `failed`) and timestamp.

3. **`nexus_inbox_threads_v` (View)**
   - The "Aggregator".
   - **Canonical Thread Logic**: Groups messages using a synthetic `thread_key`.
     - Hierarchy: `phone:X` > `owner:X` > `prospect:X` > `property:X` > `event:X`.
   - **Latest Message Logic**: Uses `DISTINCT ON (thread_key)` ordered by `message_ts DESC`.
   - **Classification**: Cross joins with `nexus_inbox_priority_classify` to assign `ui_intent`, `priority_bucket`, and `show_in_priority_inbox`.

4. **`inbox_threads_hydrated` (View)**
   - The "Contextualizer".
   - **Deterministic Joins**: LEFT JOINs `nexus_inbox_threads_v` with `properties`, `master_owners`, `prospects`, and `inbox_thread_state`.
   - **Stage Derivation**: Maps priorities into `inbox_category` (`hot_leads`, `new_inbound`, `outbound_active`, `dnc_opt_out`, etc.).

5. **`inbox_command_center_v` (View - Planned/WIP)**
   - The unified command center rollup for UI consumption.

## Common Failure States & Debugging
- **Missing Threads**: Check `message_events` for missing `from_phone_number` or `to_phone_number`. The `thread_key` generation will fail or fragment if phones are null.
- **Duplicate Messages in Timeline**: The `deduped_message_events` view logic is failing. Check `delivery_status` values.
- **Wrong Classification**: The message body didn't match the regex in `nexus_inbox_priority_classify`.
- **Empty Hydration**: The `master_owner_id` or `property_id` on the `message_events` row does not match the respective tables.

## Production Validation Workflow
1. Run `node scripts/proof-inbox.mjs` (or `scripts/proof/inbox-integrity.mjs`).
2. Ensure thread counts match between `message_events` and the UI views.
3. Validate that RLS policies allow the `anon` key to `SELECT` from `inbox_threads_hydrated`.

## Proof SQL Queries
```sql
-- Check deduplication ratio
SELECT 
  (SELECT count(*) FROM message_events) as raw_count,
  (SELECT count(*) FROM deduped_message_events) as deduped_count;

-- Check hydration hit rate
SELECT 
  count(*) as total,
  count(*) filter (where owner_name is not null) as with_owner,
  count(*) filter (where property_address_full is not null) as with_property
FROM inbox_threads_hydrated;
```
