-- BUYER / DISPOSITION OUTREACH TARGETS
--
-- Buyer outreach had no durable model at all. `send-buyer-blast.js` selected
-- recipients in memory and called the provider directly, so there was nothing to
-- reconcile a delivery receipt against, nothing to make a retry idempotent, and
-- nothing an inbound reply could be matched to. This table is the missing noun:
-- one row per (property, buyer, touch) that the product intends to contact.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
--   It does not create a second queue. Execution stays in `send_queue` under the
--   existing claim/lease/authority machinery; this table links to the queue row
--   rather than replacing it.
--
--   It does not duplicate buyer facts. Identity lives in the buyer/entity tables
--   and the match run; only the linkage needed to reconcile a send is stored.
--
--   It does not invent a suppression policy. Eligibility is decided against the
--   existing destination-keyed `sms_suppression_list`; this row records the
--   verdict, it does not define it.
--
-- Additive only: no existing table is altered, no historical row is rewritten,
-- and nothing reads this table until the code that writes it ships.

CREATE TABLE IF NOT EXISTS public.buyer_outreach_targets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The subject of the disposition. A buyer is contacted ABOUT a property.
  property_id              text NOT NULL,

  -- Buyer identity as the match engine knows it. `buyer_key` is the stable
  -- identifier `buyer_purchase_events_v2` and `buyer_match_candidates` share;
  -- the entity id and name are carried for display and for reply attribution.
  buyer_key                text NOT NULL,
  buyer_entity_id          text,
  buyer_name               text,

  -- Which analysis produced this target, so a stale run can be told apart from
  -- a current one without guessing.
  buyer_match_run_id       uuid,
  buyer_match_candidate_id uuid,

  -- Destination. Nullable because a buyer with no reachable phone is a REAL
  -- outcome worth persisting with its reason, not a row to silently drop.
  to_phone_number          text,

  touch_number             integer NOT NULL DEFAULT 1,
  outreach_source          text    NOT NULL DEFAULT 'buyer_match',

  template_id              text,
  message_body             text,

  scheduled_at             timestamptz,

  -- planned | queued | scheduled | sending | sent | delivered | failed
  -- | blocked | cancelled
  status                   text NOT NULL DEFAULT 'planned',
  -- Why a target is not going out, in the operator's terms: suppressed,
  -- no_phone, sender_ineligible, duplicate_touch, outside_contact_window.
  blocked_reason           text,

  /**
   * The same dedupe identity the queue row carries.
   *
   * `send_queue` already enforces live-touch uniqueness through
   * `uq_send_queue_active_dedupe_key` (UNIQUE on dedupe_key WHERE unsent and
   * status is live). Buyer work reuses that rather than inventing a second
   * idempotency mechanism, and stores the key here so the two sides can be
   * reconciled by value.
   */
  dedupe_key               text NOT NULL,

  -- Execution linkage. Populated at materialization and after dispatch.
  send_queue_id            uuid,
  send_queue_key           text,
  provider_message_id      text,
  delivery_status          text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

/**
 * ONE LIVE TOUCH PER BUYER PER PROPERTY.
 *
 * Partial, mirroring the send_queue contract: a superseded or completed attempt
 * may coexist with a new one, but two LIVE targets for the same buyer, property
 * and touch cannot. This is what makes a double-tap, a retried request or a
 * worker retry structurally incapable of creating duplicate outreach — rather
 * than relying on a disabled button.
 */
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_outreach_live_touch
  ON public.buyer_outreach_targets (property_id, buyer_key, touch_number)
  WHERE status IN ('planned', 'queued', 'scheduled', 'sending');

-- The dedupe key is the join to the queue row, so it is unique among live work
-- for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_outreach_live_dedupe_key
  ON public.buyer_outreach_targets (dedupe_key)
  WHERE status IN ('planned', 'queued', 'scheduled', 'sending');

-- Delivery reconciliation arrives holding the queue row or the provider id.
CREATE INDEX IF NOT EXISTS buyer_outreach_send_queue_id_idx
  ON public.buyer_outreach_targets (send_queue_id)
  WHERE send_queue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS buyer_outreach_provider_message_id_idx
  ON public.buyer_outreach_targets (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

/**
 * Inbound reply attribution.
 *
 * An inbound SMS arrives with a phone number and nothing else. This index is
 * what lets the router ask "is this number a buyer we recently contacted, and
 * about which property" deterministically instead of guessing. Ordered by
 * recency because the newest outreach to that number is the strongest linkage.
 */
CREATE INDEX IF NOT EXISTS buyer_outreach_phone_recent_idx
  ON public.buyer_outreach_targets (to_phone_number, created_at DESC)
  WHERE to_phone_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS buyer_outreach_property_idx
  ON public.buyer_outreach_targets (property_id, created_at DESC);

COMMENT ON TABLE public.buyer_outreach_targets IS
  'Durable buyer/disposition outreach targets. One row per (property, buyer, touch). Links Buyer Match selection to canonical send_queue execution and gives inbound buyer replies something deterministic to attribute to. Execution remains in send_queue; this is not a second queue.';
