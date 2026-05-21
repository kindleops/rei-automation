# Prompt: Rebuild Inbox View Hierarchy

Act as a Senior Database Architect. I need to rebuild the inbox view hierarchy in Supabase starting from the raw `message_events` table up to the final `inbox_threads_hydrated` view.

## Requirements:
1. **Source of Truth**: Use `message_events` and `inbox_thread_state`.
2. **Deduplication**: Implement `deduped_message_events` using a window function on `message_body`, `from_phone_number`, and `to_phone_number` within a 10-second window.
3. **Threading Logic**: Group by `seller_phone_key` (canonical E164).
4. **Classification**: Apply CASE statements for `priority_marker` based on keywords:
   - **Hot**: "Interested", "Price?", "Call me"
   - **DNC**: "Stop", "Unsubscribe", "Remove"
5. **Hydration**: Join with `properties`, `prospects`, and `master_owners`. Use LEFT JOINs to avoid losing threads without property associations.

## Output:
Provide a single, idempotent SQL migration file. Use `CREATE OR REPLACE VIEW`. Ensure all column names match the existing TypeScript types in `src/types/supabaseData.ts`.
