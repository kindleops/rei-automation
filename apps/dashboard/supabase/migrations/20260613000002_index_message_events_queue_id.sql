-- message_events has no index on queue_id. Without it, .in('queue_id', [...]) does a
-- sequential scan over the full table. With 30-200 values per batch this hits the
-- statement timeout and the proxy returns 500. CONCURRENTLY keeps the table writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_events_queue_id
  ON public.message_events (queue_id)
  WHERE queue_id IS NOT NULL;
