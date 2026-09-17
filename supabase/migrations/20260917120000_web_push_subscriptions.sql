-- ════════════════════════════════════════════════════════════════════════════
-- WEB PUSH SUBSCRIPTIONS
-- ════════════════════════════════════════════════════════════════════════════
--
-- MOBILE-LOCK §5 asks for a real standards-based web push path. There was none:
-- sw.js had no `push` listener and nothing in the product had ever stored a
-- PushSubscription. This table is where the browser-issued subscription lives.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed or backfilled here; an absent table
-- simply meant push could not exist, and its presence changes no existing read.
--
-- `endpoint` is the natural key. A browser reissues the SAME endpoint for the same
-- service-worker registration, so upserting on it is what stops a re-subscribe
-- (after a permission toggle, or a fresh sign-in on the same handset) from
-- accumulating duplicate rows that would each deliver the same alert.
--
-- The keys stored here are the subscriber's PUBLIC ECDH key (p256dh) and the
-- shared auth secret the push service requires for RFC 8291 encryption. They are
-- per-device values issued by the browser, not account credentials, and they are
-- useless without the server's VAPID private key, which is never stored in the
-- database.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  -- Nullable on purpose: this deployment authenticates the dashboard at the edge
  -- rather than per-operator, so a device may legitimately have no user identity
  -- attached yet. Recording a fabricated one would be worse than recording none.
  user_key      text,
  user_agent    text,
  failure_count integer NOT NULL DEFAULT 0,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The delivery path reads "every live subscription" on every qualifying
-- notification, so that predicate gets the index rather than the whole table.
CREATE INDEX IF NOT EXISTS push_subscriptions_live_idx
  ON public.push_subscriptions (created_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.push_subscriptions IS
  'Web Push (RFC 8291) subscriptions, keyed by endpoint. Written by /api/cockpit/notifications/push; read by the notification write path to deliver critical/warning signals.';
