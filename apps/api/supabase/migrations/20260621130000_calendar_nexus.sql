-- Calendar Nexus — manual events + range indexes for unified temporal command center.

CREATE TABLE IF NOT EXISTS public.calendar_manual_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        text NOT NULL DEFAULT 'manual_task',
  title             text NOT NULL,
  description       text,
  start_at          timestamptz NOT NULL,
  end_at            timestamptz,
  all_day           boolean NOT NULL DEFAULT false,
  timezone          text NOT NULL DEFAULT 'UTC',
  status            text NOT NULL DEFAULT 'scheduled',
  priority          text NOT NULL DEFAULT 'normal',
  master_owner_id   text,
  property_id       text,
  opportunity_id    text,
  thread_key        text,
  recurrence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  reminder_minutes  integer,
  assigned_operator text,
  created_by        text,
  updated_by        text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_manual_events_status_check CHECK (
    status IN ('scheduled', 'completed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_calendar_manual_events_start
  ON public.calendar_manual_events (start_at, status);

CREATE INDEX IF NOT EXISTS idx_calendar_manual_events_owner
  ON public.calendar_manual_events (master_owner_id, start_at)
  WHERE master_owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_manual_events_property
  ON public.calendar_manual_events (property_id, start_at)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_send_queue_scheduled_for
  ON public.send_queue (scheduled_for, queue_status)
  WHERE scheduled_for IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_events_created_at
  ON public.message_events (created_at);