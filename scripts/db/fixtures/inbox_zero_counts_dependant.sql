-- Fixture: a dependant of v_inbox_bucket_counts shaped like production's v_inbox_zero_counts (reads the counts
-- view by name), so the migration test proves CREATE OR REPLACE keeps every dependant. Schema only.
create or replace view public.v_inbox_zero_counts as
  select (select count(*) from public.inbox_thread_state where coalesce(is_archived, false)) as archived,
         (select c.scheduled from public.v_inbox_bucket_counts c) as scheduled;
