-- LOCAL DISPOSABLE DB ONLY. Minimal stand-in for public.send_queue (only the columns the
-- repeat-asking-price trigger reads / writes) so the PROPOSED mirror can be exercised.
create table public.send_queue (
  id uuid primary key default gen_random_uuid(),
  thread_key text,
  queue_status text,
  use_case_template text,
  scheduled_for_utc timestamptz,
  paused_reason text
);
