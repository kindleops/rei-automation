-- Immutable seller automation execution timeline for Workflow Studio live view.

CREATE TABLE IF NOT EXISTS public.seller_automation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL DEFAULT 'seller-inbound-v1',
  property_id text,
  participant_id text,
  thread_id text NOT NULL,
  source_message_id text,
  lifecycle_stage text,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  replay_only boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.seller_automation_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES public.seller_automation_executions(id) ON DELETE CASCADE,
  workflow_id text NOT NULL DEFAULT 'seller-inbound-v1',
  action_key text NOT NULL,
  node_id text NOT NULL,
  property_id text,
  participant_id text,
  thread_id text,
  source_message_id text,
  lifecycle_stage text,
  execution_status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_template text,
  rendered_response_preview text,
  queue_id text,
  provider_status text,
  block_reason text,
  retry_count integer NOT NULL DEFAULT 0,
  error_details jsonb,
  next_action text,
  manual boolean NOT NULL DEFAULT false,
  operator_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_automation_executions_thread
  ON public.seller_automation_executions (thread_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_automation_executions_property
  ON public.seller_automation_executions (property_id, started_at DESC)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seller_automation_executions_participant
  ON public.seller_automation_executions (participant_id, started_at DESC)
  WHERE participant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seller_automation_execution_steps_execution
  ON public.seller_automation_execution_steps (execution_id, started_at ASC);
CREATE INDEX IF NOT EXISTS idx_seller_automation_execution_steps_action
  ON public.seller_automation_execution_steps (action_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_automation_execution_steps_thread
  ON public.seller_automation_execution_steps (thread_id, started_at DESC)
  WHERE thread_id IS NOT NULL;

COMMENT ON TABLE public.seller_automation_executions IS 'Seller-flow automation execution runs for Workflow Studio live/history views.';
COMMENT ON TABLE public.seller_automation_execution_steps IS 'Immutable per-action execution steps emitted by seller-flow orchestrator.';

-- Realtime publication for targeted Workflow Studio execution patches
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'seller_automation_execution_steps'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.seller_automation_execution_steps;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'seller_automation_executions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.seller_automation_executions;
  END IF;
END $$;