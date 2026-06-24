-- Align canonical_inbox_counts waiting/new_replies with JS bucket predicates (24h window).

DROP VIEW IF EXISTS public.v_inbox_thread_counts_live_v2 CASCADE;
DROP VIEW IF EXISTS public.canonical_inbox_counts CASCADE;

CREATE OR REPLACE VIEW public.canonical_inbox_counts
WITH (security_invoker = true)
AS
SELECT
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority') AS priority,
  COUNT(*) FILTER (
    WHERE inbox_bucket NOT IN ('dead', 'suppressed')
      AND (
        inbox_bucket = 'new_replies'
        OR (
          latest_message_direction = 'inbound'
          AND COALESCE(last_inbound_at, latest_message_at) >= NOW() - INTERVAL '24 hours'
          AND COALESCE(is_read, false) = false
          AND COALESCE(opt_out, false) = false
          AND COALESCE(wrong_number, false) = false
          AND COALESCE(not_interested, false) = false
        )
      )
  ) AS new_replies,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review') AS needs_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up') AS follow_up,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold') AS cold,
  COUNT(*) FILTER (WHERE inbox_bucket = 'dead') AS dead,
  COUNT(*) FILTER (WHERE not_interested = true OR lower(COALESCE(detected_intent, '')) = 'not_interested') AS not_interested,
  COUNT(*) FILTER (WHERE contact_identity_class = 'wrong_person') AS wrong_person,
  COUNT(*) FILTER (WHERE contact_identity_class = 'wrong_number' OR wrong_number = true) AS wrong_number,
  COUNT(*) FILTER (WHERE contact_identity_class = 'renter_occupant') AS renter_occupant,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed' OR opt_out = true) AS suppressed,
  COUNT(*) FILTER (WHERE opt_out = true OR inbox_bucket = 'suppressed') AS opt_out,
  COUNT(*) FILTER (WHERE inbox_bucket IS NULL) AS unclassified,
  COUNT(*) FILTER (WHERE unread_count > 0) AS unread,
  COUNT(*) FILTER (WHERE inbox_bucket IN ('priority', 'new_replies', 'needs_review', 'follow_up')) AS active,
  COUNT(*) FILTER (
    WHERE inbox_bucket NOT IN ('dead', 'suppressed')
      AND (
        inbox_bucket = 'waiting'
        OR (
          latest_message_direction = 'outbound'
          AND COALESCE(last_outbound_at, latest_message_at) >= NOW() - INTERVAL '24 hours'
          AND (
            last_inbound_at IS NULL
            OR last_inbound_at < COALESCE(last_outbound_at, latest_message_at)
          )
        )
      )
  ) AS waiting,
  COUNT(*) FILTER (WHERE property_id IS NULL) AS unlinked,
  COUNT(*) AS all,
  COUNT(*) AS all_messages,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review') AS automated,
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority') AS hot_leads,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies') AS new_inbound,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies') AS needs_reply,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review') AS manual_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up') AS outbound_active,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold') AS cold_no_response,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed') AS dnc_opt_out,
  COUNT(*) FILTER (
    WHERE inbox_bucket NOT IN ('dead', 'suppressed')
      AND (
        inbox_bucket = 'waiting'
        OR (
          latest_message_direction = 'outbound'
          AND COALESCE(last_outbound_at, latest_message_at) >= NOW() - INTERVAL '24 hours'
          AND (
            last_inbound_at IS NULL
            OR last_inbound_at < COALESCE(last_outbound_at, latest_message_at)
          )
        )
      )
  ) AS waiting_on_seller
FROM public.canonical_inbox_threads;

GRANT SELECT ON public.canonical_inbox_counts TO anon, authenticated, service_role;

CREATE VIEW public.v_inbox_thread_counts_live_v2
WITH (security_invoker = true)
AS
SELECT * FROM public.canonical_inbox_counts;

GRANT SELECT ON public.v_inbox_thread_counts_live_v2 TO anon, authenticated, service_role;