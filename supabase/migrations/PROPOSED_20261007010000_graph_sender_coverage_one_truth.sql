-- PROPOSED — NOT APPLIED. Graph sender coverage = what first-touch routing actually allows.
--
-- Why (measured read-only in prod, 2026-10-06):
--   campaign_target_graph.sender_covered is projected by
--   resolve_campaign_safe_sender_route(market, state). That function carries a
--   HARDCODED legacy state-fallback table (MO/MI/IL/OH/... -> Minneapolis,
--   PA/NY/MD/VA/... -> Miami, AZ/NV/UT/CO -> Los Angeles, ...) and counts any of
--   those as "covered". The dispatch router never uses it for a first text:
--   the campaign launch planner (campaign-automation-service.js launchOptions:
--   first_touch true, no allow_regional_fallback_for_first_touch) and the Composer
--   cohort (campaign-launch-readiness.js evaluateSenderCoverage) both call the
--   feeder's chooseTextgridNumber, which then requires an exact-market number
--   (supabase-candidate-feeder.js exact_market_required). The operator-approved
--   regional pools (Sender Routing 2.0) are gated OFF and their tables are not
--   applied in prod. (system_control.allow_regional_fallback_for_first_touch is
--   'true' since 2026-06-07 but only the legacy candidate feeder and the send-time
--   health guard read it; the campaign planner never passes it. Owner decision —
--   see the report — not changed here.) Result: 45 markets read "queue-ready" in the
--   graph while the Composer's cohort (the planner's own router) sends 0 there.
--     St. Louis, MO  2,249 queue-ready in graph  ->  0 sendable (NO_VALID_LOCAL_TEXTGRID_NUMBER)
--     Detroit, MI    1,236 queue-ready in graph  ->  0 sendable (same)
--     Chicago, IL    4,008, Phoenix, AZ 3,520, Inland Empire 3,595, ... (same)
--   It also ignores number health: Miami 2999 is health_state='cooling'
--   (spam_flagged_operator_note), which the router refuses, so Miami reads covered
--   in the graph and LOCAL_NUMBERS_BLOCKED_BY_OPERATOR in the router.
--   Atlanta is the opposite (all 4,576 rows sender_covered=false): the graph was
--   last projected before Atlanta 0588 was unblocked (system_control
--   sms_blocked_sender_numbers edited 2026-10-03 21:11Z) and no coverage refresh
--   has run since. Today both this function and the router route Atlanta to 0588.
--
-- What changes: ONE rule, the planner's. A row is sender_covered only when a number
-- in the row's own canonical market passes evaluateOutboundNumberEligibility
-- (apps/api/src/lib/supabase/sms-engine.js) minus today's caps, plus the blocklist:
--   status NOT IN BLOCKING_NUMBER_STATUS, health_state NOT IN BLOCKING_HEALTH_STATE,
--   not cooling_until > now(), not on system_control.sms_blocked_sender_numbers.
-- apps/api/tests/critical/graph-sender-coverage-one-truth.test.mjs pins these lists
-- to the JS sets so they cannot drift.
-- The legacy state table is removed: it was never approved as a first-touch route
-- and contradicts the owner's Routing 2.0 graph (e.g. Detroit -> Indianapolis
-- first, not Minneapolis). When the owner approves Routing 2.0 (dry-run first),
-- this function must read the APPROVED market_sender_routes rows in priority order
-- instead of returning no route — that is part of the 2.0 activation, not this fix.
-- Time-of-day pacing (local send window, hourly/daily caps) is pacing, not coverage,
-- and stays out, exactly as the Composer's router call passes ignore_daily_limit.
--
-- Signature and columns are unchanged, so refresh_campaign_target_graph_sender_coverage,
-- refresh_campaign_target_graph_seller_batch and campaign_preview_sender_route_map keep
-- working. fallback_covered is now always false (no unapproved fallback exists).
--
-- Expected effect after the refresh (from the same prod read): covered markets =
-- Miami (only if 2999 cools down or 5670 is unblocked -> today UNCOVERED), Los Angeles,
-- Houston, Dallas, Tampa, Minneapolis, Atlanta (NEWLY covered, 0588), Jacksonville,
-- Indianapolis, Charlotte. Every other market drops to queue_block_reason
-- 'no_sender_coverage' — which is the truth the Composer already shows per cohort.
--
-- Apply: owner approval required (prod write). Run the CREATE in one transaction,
-- then the graph re-projection in its own session (full-table UPDATE; the function
-- lifts its own statement_timeout; poll pg_stat_activity). Rollback: the paired
-- _rollback.sql restores the exact live definition and re-projects.

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_campaign_safe_sender_route(p_market text, p_state text)
 RETURNS TABLE(sender_covered boolean, sender_id uuid, sender_phone_number text, sender_market text, route_type text, routing_rule_name text, exact_market_covered boolean, health_safe_exact boolean, fallback_covered boolean, safe_sender_count integer, health_blocked_sender_count integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH route_input AS (
    SELECT
      public.normalize_campaign_sender_market(COALESCE((SELECT r.market_name FROM public.resolve_canonical_market(NULL, NULL, NULL, p_state, p_market) r), p_market)) AS market_key
  ),
  blocked_senders AS (
    SELECT DISTINCT public.normalize_campaign_sender_phone(trim(entry.phone_number)) AS phone_number
    FROM public.system_control sc
    CROSS JOIN LATERAL regexp_split_to_table(
      translate(COALESCE(sc.value, ''), '[]"', ''),
      '[[:space:]]*,[[:space:]]*'
    ) AS entry(phone_number)
    WHERE sc.key = 'sms_blocked_sender_numbers'
      AND NULLIF(trim(entry.phone_number), '') IS NOT NULL
      AND NULLIF(public.normalize_campaign_sender_phone(trim(entry.phone_number)), '') IS NOT NULL
  ),
  active_inventory AS (
    SELECT
      tn.id,
      tn.phone_number,
      tn.market,
      public.normalize_campaign_sender_market(tn.market) AS market_key,
      COALESCE(tn.messages_sent_today, 0) AS messages_sent_today,
      tn.last_used_at,
      (
        EXISTS (
          SELECT 1 FROM blocked_senders blocked
          WHERE blocked.phone_number = public.normalize_campaign_sender_phone(tn.phone_number)
        )
        -- = BLOCKING_HEALTH_STATE + cooling_until in evaluateOutboundNumberEligibility (sms-engine.js)
        OR lower(trim(COALESCE(tn.health_state, ''))) IN ('cooling', 'blocked', 'quarantined', 'spam_flagged', 'suspended')
        OR (tn.cooling_until IS NOT NULL AND tn.cooling_until > now())
      ) AS health_blocked
    FROM public.textgrid_numbers tn
    WHERE NULLIF(public.normalize_campaign_sender_phone(tn.phone_number), '') IS NOT NULL
      -- = BLOCKING_NUMBER_STATUS in evaluateOutboundNumberEligibility (a deny-list: every
      -- prod number is health 'unverified' and that must NOT block — see the comment there)
      AND lower(trim(COALESCE(tn.status, ''))) NOT IN ('paused', 'inactive', 'disabled', 'suspended', 'released', 'retired')
  ),
  safe_inventory AS (
    SELECT * FROM active_inventory WHERE NOT health_blocked
  ),
  selected AS (
    SELECT inventory.*
    FROM safe_inventory inventory
    CROSS JOIN route_input input
    WHERE inventory.market_key = input.market_key
    ORDER BY inventory.messages_sent_today, inventory.last_used_at NULLS FIRST, inventory.id
    LIMIT 1
  ),
  diagnostics AS (
    SELECT
      EXISTS (
        SELECT 1 FROM active_inventory inventory CROSS JOIN route_input input
        WHERE inventory.market_key = input.market_key
      ) AS exact_market_covered,
      EXISTS (
        SELECT 1 FROM safe_inventory inventory CROSS JOIN route_input input
        WHERE inventory.market_key = input.market_key
      ) AS health_safe_exact,
      (SELECT COUNT(*)::integer FROM active_inventory WHERE health_blocked) AS health_blocked_sender_count
  )
  SELECT
    selected.id IS NOT NULL AS sender_covered,
    selected.id AS sender_id,
    selected.phone_number AS sender_phone_number,
    selected.market AS sender_market,
    CASE WHEN selected.id IS NOT NULL THEN 'exact_market_match' ELSE 'no_sender_route' END AS route_type,
    CASE WHEN selected.id IS NOT NULL THEN 'exact_market_match' END AS routing_rule_name,
    diagnostics.exact_market_covered,
    diagnostics.health_safe_exact,
    false AS fallback_covered,
    CASE
      WHEN selected.market_key IS NULL THEN 0
      ELSE (SELECT COUNT(*)::integer FROM safe_inventory inventory WHERE inventory.market_key = selected.market_key)
    END AS safe_sender_count,
    diagnostics.health_blocked_sender_count
  FROM diagnostics
  LEFT JOIN selected ON true;
$function$;

COMMIT;

-- Pre-check (read-only; expected per the 2026-10-06 measurement):
--   SELECT 'stl', sender_covered FROM resolve_campaign_safe_sender_route('St. Louis, MO','MO');   -- f
--   SELECT 'det', sender_covered FROM resolve_campaign_safe_sender_route('Detroit, MI','MI');     -- f
--   SELECT 'atl', sender_covered, right(sender_phone_number,4) FROM resolve_campaign_safe_sender_route('Atlanta, GA','GA'); -- t, 0588
--   SELECT 'mia', sender_covered FROM resolve_campaign_safe_sender_route('Miami, FL','FL');       -- f (2999 cooling, 5670 blocked)
-- Then re-project the graph (own session):
--   SELECT * FROM public.refresh_campaign_target_graph_sender_coverage('one_truth_exact_market_20261007');
