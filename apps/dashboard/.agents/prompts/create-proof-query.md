# Prompt: Create Proof Query

Act as a QA Engineer. I need a new proof script (Node.js/MJS) to validate the integrity of the inbox thread aggregation.

## Requirements:
1. **Connectivity**: Use `@supabase/supabase-js` and environment variables from `.env`.
2. **Checks**:
   - Verify that the total count of messages in `message_events` matches the sum of message counts in `nexus_inbox_threads_v`.
   - Identify any threads where `last_message_at` does not match the `MAX(event_timestamp)` of its constituent messages.
   - Detect orphaned threads (threads with no messages).
3. **Output**: Log a clean table of results using `console.table`.

## Reference:
Look at `scripts/proof-inbox.mjs` for the existing pattern.
