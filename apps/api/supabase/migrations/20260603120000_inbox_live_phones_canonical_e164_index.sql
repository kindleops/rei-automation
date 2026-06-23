-- Inbox live performance: index phones.canonical_e164
--
-- The live inbox thread source (v_inbox_threads_live_v2, and the
-- inbox_threads_view wrapper on top of it) joins phones to threads on
-- phones.canonical_e164 = base.best_phone to resolve the owning master_owner_id.
-- There was no standalone index on phones.canonical_e164 (only the composite
-- uq_phones_master_key_e164 (master_key, canonical_e164), whose leading column
-- is master_key), so the planner fell back to a sequential scan of the entire
-- phones table (~121k rows) on every inbox list request.
--
-- Measured impact (limit 41, order by latest_message_at desc):
--   before: ~7,668 ms (Seq Scan on phones)
--   after:  ~2,138 ms (Index Scan using this index, ~1 row per thread)
--
-- This removes the dominant cost behind the /api/cockpit/inbox/live backend
-- timeouts that were tipping the inbox into degraded mode.

CREATE INDEX IF NOT EXISTS idx_phones_canonical_e164
  ON public.phones USING btree (canonical_e164);
