-- =============================================================================
-- canonical_inbox_wiring
-- Adds classification/state columns to inbox_thread_state, then creates
-- canonical_inbox_threads and canonical_inbox_counts as the single source of
-- truth for the inbox API.  No REVOKE'd views are referenced; only base tables.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend inbox_thread_state with classification + control columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.inbox_thread_state
  ADD COLUMN IF NOT EXISTS canonical_e164               text,
  ADD COLUMN IF NOT EXISTS seller_phone                 text,
  ADD COLUMN IF NOT EXISTS prospect_id                  text,
  ADD COLUMN IF NOT EXISTS is_pinned                    boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_suppressed                boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_starred                   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_review                boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_user                text,
  ADD COLUMN IF NOT EXISTS unread_count                 integer     NOT NULL DEFAULT 0,
  -- operator-settable state (written by patchThreadStateSafe)
  ADD COLUMN IF NOT EXISTS conversation_status          text,
  ADD COLUMN IF NOT EXISTS seller_stage                 text,
  ADD COLUMN IF NOT EXISTS temperature                  text,
  ADD COLUMN IF NOT EXISTS autopilot_mode               text,
  -- delivery
  ADD COLUMN IF NOT EXISTS latest_provider_delivery_status text,
  -- classification (written by classifyToInboxFields via classify.js)
  ADD COLUMN IF NOT EXISTS inbox_bucket                 text,
  ADD COLUMN IF NOT EXISTS inbox_category               text,
  ADD COLUMN IF NOT EXISTS detected_intent              text,
  ADD COLUMN IF NOT EXISTS reply_intent                 text,
  ADD COLUMN IF NOT EXISTS lead_temperature             text,
  ADD COLUMN IF NOT EXISTS wrong_number                 boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opt_out                      boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS not_interested               boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_review                 boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suppression_status           text;

-- Indexes for common filter patterns
CREATE INDEX IF NOT EXISTS idx_its_canonical_e164    ON public.inbox_thread_state (canonical_e164);
CREATE INDEX IF NOT EXISTS idx_its_prospect_id       ON public.inbox_thread_state (prospect_id);
CREATE INDEX IF NOT EXISTS idx_its_inbox_bucket      ON public.inbox_thread_state (inbox_bucket);
CREATE INDEX IF NOT EXISTS idx_its_wrong_number      ON public.inbox_thread_state (wrong_number) WHERE wrong_number = true;
CREATE INDEX IF NOT EXISTS idx_its_opt_out           ON public.inbox_thread_state (opt_out) WHERE opt_out = true;

-- ---------------------------------------------------------------------------
-- 2. canonical_inbox_threads — security_invoker view over base tables only
--    (v_universal_lead_command has REVOKE ALL from anon/authenticated and
--     cannot be referenced in a security_invoker view)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.canonical_inbox_threads CASCADE;

CREATE OR REPLACE VIEW public.canonical_inbox_threads
WITH (security_invoker = true)
AS
SELECT
  -- Thread identity
  ts.id                                                           AS id,
  ts.thread_key,
  ts.master_owner_id,
  ts.property_id,
  ts.prospect_id,
  ts.canonical_e164,
  ts.seller_phone,

  -- Classification (written by classify.js / classifyToInboxFields)
  COALESCE(
    ts.inbox_bucket,
    CASE
      WHEN ts.opt_out      = true  THEN 'suppressed'
      WHEN ts.is_suppressed = true THEN 'suppressed'
      WHEN ts.wrong_number = true  THEN 'dead'
      WHEN ts.not_interested = true THEN 'dead'
      WHEN ts.latest_direction = 'inbound' THEN 'new_replies'
      ELSE 'cold'
    END
  )                                                               AS inbox_bucket,
  ts.inbox_category,
  ts.detected_intent,
  ts.reply_intent,
  ts.lead_temperature,
  ts.wrong_number,
  ts.opt_out,
  ts.not_interested,
  ts.needs_review,
  ts.suppression_status,

  -- Read / archive / pin state
  ts.is_read,
  ts.is_pinned,
  ts.is_archived,
  ts.is_suppressed,
  ts.is_starred,
  ts.unread_count,
  ts.archived_at,
  ts.read_at,

  -- Message hydration (populated by webhook handlers)
  ts.latest_message_body,
  ts.latest_message_at,
  ts.latest_direction                                             AS latest_message_direction,
  ts.latest_event_type,
  ts.message_count,
  ts.inbound_count,
  ts.outbound_count,
  ts.last_inbound_at,
  ts.last_outbound_at,
  ts.latest_message_event_id,

  -- Delivery status (prefer provider value)
  COALESCE(
    ts.latest_provider_delivery_status,
    ts.latest_delivery_status
  )                                                               AS delivery_status,
  ts.latest_delivery_status,
  ts.latest_provider_delivery_status,

  -- Operator state
  ts.conversation_status,
  ts.seller_stage,
  ts.temperature,
  ts.autopilot_mode,
  ts.manual_review,
  ts.assigned_user,
  ts.follow_up_at,

  -- Timestamps
  ts.created_at,
  ts.updated_at,

  -- Properties join
  p.property_address_full,
  p.property_address_city,
  p.property_address_state                                        AS property_state,
  p.property_address_zip                                          AS property_zip,
  p.market,
  p.property_type,
  p.latitude,
  p.longitude,

  -- Master owner join
  mo.display_name                                                 AS owner_name,

  -- Prospect join
  pr.full_name                                                    AS prospect_name,
  pr.first_name                                                   AS prospect_first_name

FROM public.inbox_thread_state ts
LEFT JOIN public.properties     p  ON p.property_id    = ts.property_id
LEFT JOIN public.master_owners  mo ON mo.master_owner_id = ts.master_owner_id
LEFT JOIN public.prospects      pr ON pr.prospect_id   = ts.prospect_id
WHERE ts.is_archived IS DISTINCT FROM true;

GRANT SELECT ON public.canonical_inbox_threads TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. canonical_inbox_counts — aggregate over canonical_inbox_threads
--    Uses the same resolved inbox_bucket so counts and thread lists align.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.canonical_inbox_counts CASCADE;

CREATE OR REPLACE VIEW public.canonical_inbox_counts
WITH (security_invoker = true)
AS
SELECT
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority')                                           AS priority,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies')                                        AS new_replies,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review')                                       AS needs_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up')                                          AS follow_up,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold')                                               AS cold,
  COUNT(*) FILTER (WHERE inbox_bucket = 'dead')                                               AS dead,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed')                                         AS suppressed,
  COUNT(*) FILTER (WHERE inbox_bucket IN ('priority','new_replies','needs_review','follow_up')) AS active,
  COUNT(*) FILTER (
    WHERE latest_message_direction = 'outbound'
      AND inbox_bucket NOT IN ('dead','suppressed')
  )                                                                                            AS waiting,
  COUNT(*) FILTER (WHERE property_id IS NULL)                                                 AS unlinked,
  COUNT(*)                                                                                     AS all,
  COUNT(*)                                                                                     AS all_messages,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review')                                       AS automated
FROM public.canonical_inbox_threads;

GRANT SELECT ON public.canonical_inbox_counts TO anon, authenticated, service_role;
