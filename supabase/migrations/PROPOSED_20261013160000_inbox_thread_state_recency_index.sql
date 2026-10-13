-- PROPOSED (2026-10-13): All-messages first load.
-- The Inbox boot query reads inbox_thread_state ordered by
-- latest_message_at DESC NULLS LAST, thread_key DESC (no bucket filter). The only
-- index with latest_message_at leads with inbox_bucket, so every first load scans
-- and sorts all ~17K rows: ~0.12 s warm, past the 4 s boot timeout cold — then an
-- hours-old snapshot with no cursor is served ("All" shows stale rows, Load More
-- does nothing). This index makes it a 26-row index scan.
-- CONCURRENTLY: no write lock on inbox_thread_state. Run OUTSIDE a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_its_latest_message_recency
  ON public.inbox_thread_state (latest_message_at DESC NULLS LAST, thread_key DESC);
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_its_latest_message_recency;
