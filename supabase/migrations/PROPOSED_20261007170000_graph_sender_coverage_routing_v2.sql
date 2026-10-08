-- PROPOSED — NOT APPLIED. Graph sender coverage reads the APPROVED Sender Routing 2.0 graph.
--
-- Supersedes PROPOSED_20261007010000_graph_sender_coverage_one_truth.sql (that file's
-- header: "when the owner approves Routing 2.0 this function must read the APPROVED
-- market_sender_routes rows in priority order"). Owner approved regional first-touch
-- routing on 2026-10-07 (graph r3, apps/api/src/lib/domain/routing/sender-routing/
-- proposed-initial-graph.js). Apply THIS file instead of 010000 (it contains 010000's
-- exact-market rule as its gate-off branch); applying both in order is also safe.
--
-- ONE RULE, the planner's, in both states of the switch:
--   system_control.sender_routing_v2_enabled OFF (or absent)
--     -> exact-market only, byte-for-byte the 010000 rule: a row is covered only when a
--        number in its own canonical market passes the canonical dispatch eligibility.
--        (= feeder chooseTextgridNumber exact_market_required for a first touch)
--   ON -> the Routing 2.0 walk (sender-routing-policy.js selectSender, purpose proactive,
--        ignore_daily_limit like the Composer cohort): the row's canonical market's
--        enabled routes in priority order, skipping blocked_never, inactive pools and
--        inactive members; the first route with an ELIGIBLE number covers the row.
--        Eligible = the canonical dispatch eligibility (status / health / cooling_until /
--        operator blocklist) PLUS the v2 gates: not retired, registration_status
--        'registered', inbound webhook verified, onboarding stage not pre-production.
--        apps/api/tests/critical/graph-sender-coverage-routing-v2.test.mjs pins every list
--        here to the JS sets so the two cannot drift.
--   The SQL sees only the runtime half of the double gate. The env ceiling
--   (SENDER_ROUTING_V2_ENABLED) must already be 'true' in the deployed API before
--   system_control is flipped, or the graph would read regional rows as covered while
--   the router (ceiling off) still routes exact-only. See the apply order below.
--
-- Recorded per row (refresh_campaign_target_graph_sender_coverage, unchanged):
--   route_type          'exact_market_match' (the market's own pool) |
--                       'approved_regional_fallback' (another approved pool) | 'no_sender_route'
--                       (the vocabulary the send-time health guard and the planner already use)
--   routing_rule_name   'sender_routing_v2:<pool_key>:<affinity_tier>' | 'exact_market_match'
--   sender_market       the chosen number's market (e.g. 'Los Angeles, CA' for Phoenix)
--   fallback_covered    true when the row is covered by a regional pool
--   safe_sender_count   eligible numbers in the chosen route's pool
-- Within a pool the displayed sender is least-used-first (messages_sent_today, last_used_at),
-- the allocator's order; coverage is boolean and never depends on which number is shown.
-- Pacing (recipient-local contact window, daily / per-number caps) stays out of coverage,
-- exactly as before.
--
-- APPLY ORDER (owner present; each step its own session; revised 2026-10-07 evening for the live fleet):
--   0. pretest   PROPOSED_20261007170000_graph_sender_coverage_routing_v2_pretest.sql
--                (one transaction, ends in ROLLBACK: applies 1-4 in-txn, flips the flag in-txn,
--                asserts every market that sends today still resolves; nothing persists)
--   1. psql --single-transaction -f 20261002130000_sender_routing_v2.sql        (tables, switches OFF)
--   2. psql --single-transaction -f 20261002130100_sender_routing_v2_seed_proposed_graph.sql (r3 pools/routes; Chicago kept as is)
--   3. psql --single-transaction -f PROPOSED_20261007171000_sender_routing_v2_evidence_backfill.sql
--        (registration + inbound evidence from the delivery/inbound ledgers — WITHOUT it v2 ON stops sending)
--   4. psql --single-transaction -f PROPOSED_20261007170000_graph_sender_coverage_routing_v2.sql (this file)
--   5. SELECT * FROM public.refresh_campaign_target_graph_sender_coverage('routing_v2_exact_20261007');
--        flag still OFF -> exact-only truth (the 010000 effect: legacy state fallback removed)
--   6. deploy env SENDER_ROUTING_V2_ENABLED=true (inert while system_control is 'false')
--   7. UPDATE public.system_control SET value='true', updated_at=now() WHERE key='sender_routing_v2_enabled';
--   8. SELECT * FROM public.refresh_campaign_target_graph_sender_coverage('routing_v2_regional_20261007');
--   Re-run step 3 after Chicago's first inbound lands (idempotent) so v2 starts using it.
--   Turning routing OFF later = step 6 with 'false' + step 7 (the graph returns to exact-only).
--   The send-time health guard refuses regional first touches unless
--   system_control.allow_regional_fallback_for_first_touch is truthy ('true' since 2026-06-07)
--   and require_local_routing is not; the pretest asserts both.
--
-- ROLLBACK: PROPOSED_20261007170000_graph_sender_coverage_routing_v2_rollback.sql
--   (drops the helper, restores the live resolve_campaign_safe_sender_route snapshot, then
--   re-project). The routing tables have their own rollback (20261002130000_..._ROLLBACK.sql).
--
-- No BEGIN/COMMIT inside: apply with psql --single-transaction (or MCP apply_migration) so the
-- pretest can \ir it inside its own rolled-back transaction.

-- ── helper: the v2 first-touch pick for one canonical market (also the preview tool) ──
CREATE OR REPLACE FUNCTION public.sender_routing_v2_first_touch_pick(p_market_id text)
 RETURNS TABLE(sender_id uuid, sender_phone_number text, sender_market text, pool_key text, affinity_tier text, route_priority integer, is_local boolean, pool_eligible_count integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH blocked_senders AS (
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
  eligible AS (
    SELECT tn.id, tn.phone_number, tn.market, COALESCE(tn.messages_sent_today, 0) AS messages_sent_today, tn.last_used_at
    FROM public.textgrid_numbers tn
    WHERE NULLIF(public.normalize_campaign_sender_phone(tn.phone_number), '') IS NOT NULL
      -- = BLOCKING_NUMBER_STATUS (sms-engine.js evaluateOutboundNumberEligibility)
      AND lower(trim(COALESCE(tn.status, ''))) NOT IN ('paused', 'inactive', 'disabled', 'suspended', 'released', 'retired')
      -- = BLOCKING_HEALTH_STATE + cooling_until
      AND lower(trim(COALESCE(tn.health_state, ''))) NOT IN ('cooling', 'blocked', 'quarantined', 'spam_flagged', 'suspended')
      AND NOT (tn.cooling_until IS NOT NULL AND tn.cooling_until > now())
      -- operator blocklist (the health guard's list) always wins
      AND NOT EXISTS (
        SELECT 1 FROM blocked_senders blocked
        WHERE blocked.phone_number = public.normalize_campaign_sender_phone(tn.phone_number)
      )
      -- v2 gates = evaluateSenderEligibility (sender-routing-policy.js)
      AND lower(trim(COALESCE(tn.metadata->>'lifecycle_state', ''))) <> 'retired'
      AND lower(trim(COALESCE(tn.registration_status, ''))) = 'registered'
      AND (
        NULLIF(trim(COALESCE(tn.metadata->>'inbound_verified_at', '')), '') IS NOT NULL
        OR lower(trim(COALESCE(tn.metadata->>'sms_webhook_status', ''))) = 'verified'
      )
      -- = PRE_PRODUCTION_STAGES
      AND lower(trim(COALESCE(tn.metadata->>'onboarding_stage', ''))) NOT IN ('discovered', 'configuring', 'inbound_verified')
  ),
  candidates AS (
    SELECT
      e.id, e.phone_number, e.market, e.messages_sent_today, e.last_used_at,
      sp.pool_key, msr.affinity_tier, msr.priority,
      (sp.home_market_id IS NOT NULL AND sp.home_market_id = msr.market_id) AS is_local
    FROM public.market_sender_routes msr
    JOIN public.sender_pools sp ON sp.id = msr.sender_pool_id AND sp.is_active
    JOIN public.sender_pool_numbers spn ON spn.sender_pool_id = sp.id AND spn.status = 'active'
    JOIN eligible e ON e.id = spn.textgrid_number_id
    WHERE msr.market_id = p_market_id
      AND msr.enabled
      AND msr.affinity_tier <> 'blocked_never'
  )
  SELECT
    c.id, c.phone_number, c.market, c.pool_key, c.affinity_tier, c.priority, c.is_local,
    (SELECT COUNT(*)::integer FROM candidates c2 WHERE c2.priority = c.priority)
  FROM candidates c
  ORDER BY c.priority, c.messages_sent_today, c.last_used_at NULLS FIRST, c.id
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.sender_routing_v2_first_touch_pick(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sender_routing_v2_first_touch_pick(text) TO service_role;

-- ── the projection resolver (signature and columns unchanged) ──
CREATE OR REPLACE FUNCTION public.resolve_campaign_safe_sender_route(p_market text, p_state text)
 RETURNS TABLE(sender_covered boolean, sender_id uuid, sender_phone_number text, sender_market text, route_type text, routing_rule_name text, exact_market_covered boolean, health_safe_exact boolean, fallback_covered boolean, safe_sender_count integer, health_blocked_sender_count integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH resolved_market AS (
    SELECT r.market_id, r.market_name
    FROM public.resolve_canonical_market(NULL, NULL, NULL, p_state, p_market) r
    LIMIT 1
  ),
  route_input AS (
    SELECT
      public.normalize_campaign_sender_market(COALESCE((SELECT rm.market_name FROM resolved_market rm), p_market)) AS market_key,
      (SELECT rm.market_id FROM resolved_market rm) AS market_id,
      EXISTS (
        SELECT 1 FROM public.system_control sc
        WHERE sc.key = 'sender_routing_v2_enabled'
          -- = TRUE_VALUES (sender-routing-gate.js)
          AND lower(trim(COALESCE(sc.value, ''))) IN ('true', '1', 'yes', 'on', 'enabled')
      ) AS v2_on
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
      -- = BLOCKING_NUMBER_STATUS in evaluateOutboundNumberEligibility
      AND lower(trim(COALESCE(tn.status, ''))) NOT IN ('paused', 'inactive', 'disabled', 'suspended', 'released', 'retired')
  ),
  safe_inventory AS (
    SELECT * FROM active_inventory WHERE NOT health_blocked
  ),
  -- gate OFF: exact-market only (the 010000 rule)
  exact_selected AS (
    SELECT inventory.*
    FROM safe_inventory inventory
    CROSS JOIN route_input input
    WHERE NOT input.v2_on
      AND inventory.market_key = input.market_key
    ORDER BY inventory.messages_sent_today, inventory.last_used_at NULLS FIRST, inventory.id
    LIMIT 1
  ),
  -- gate ON: the approved graph, priority order (no route / unresolved market = not covered)
  v2_selected AS (
    SELECT pick.*
    FROM route_input input
    CROSS JOIN LATERAL public.sender_routing_v2_first_touch_pick(input.market_id) pick
    WHERE input.v2_on
      AND input.market_id IS NOT NULL
  ),
  chosen AS (
    SELECT
      e.id AS sender_id, e.phone_number AS sender_phone_number, e.market AS sender_market,
      'exact_market_match'::text AS route_type, 'exact_market_match'::text AS routing_rule_name,
      false AS regional,
      (SELECT COUNT(*)::integer FROM safe_inventory s WHERE s.market_key = e.market_key) AS safe_sender_count
    FROM exact_selected e
    UNION ALL
    SELECT
      v.sender_id, v.sender_phone_number, v.sender_market,
      CASE WHEN v.is_local THEN 'exact_market_match' ELSE 'approved_regional_fallback' END,
      'sender_routing_v2:' || v.pool_key || ':' || v.affinity_tier,
      NOT v.is_local,
      v.pool_eligible_count
    FROM v2_selected v
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
    chosen.sender_id IS NOT NULL AS sender_covered,
    chosen.sender_id,
    chosen.sender_phone_number,
    chosen.sender_market,
    COALESCE(chosen.route_type, 'no_sender_route') AS route_type,
    chosen.routing_rule_name,
    diagnostics.exact_market_covered,
    diagnostics.health_safe_exact,
    COALESCE(chosen.regional, false) AS fallback_covered,
    COALESCE(chosen.safe_sender_count, 0) AS safe_sender_count,
    diagnostics.health_blocked_sender_count
  FROM diagnostics
  LEFT JOIN chosen ON true;
$function$;
