-- ROLLBACK for PROPOSED_20261007010000_graph_sender_coverage_one_truth.sql
-- Restores resolve_campaign_safe_sender_route exactly as it was live in prod on
-- 2026-10-06 (pg_get_functiondef snapshot, md5 of the snapshot 949dbec4e3a1cc2c41edb075cc7e3dca),
-- then re-projects the graph through it.
BEGIN;
CREATE OR REPLACE FUNCTION public.resolve_campaign_safe_sender_route(p_market text, p_state text)
 RETURNS TABLE(sender_covered boolean, sender_id uuid, sender_phone_number text, sender_market text, route_type text, routing_rule_name text, exact_market_covered boolean, health_safe_exact boolean, fallback_covered boolean, safe_sender_count integer, health_blocked_sender_count integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH route_input AS (
    SELECT
      public.normalize_campaign_sender_market(COALESCE((SELECT r.market_name FROM public.resolve_canonical_market(NULL, NULL, NULL, p_state, p_market) r), p_market)) AS market_key,
      upper(COALESCE(
        NULLIF(trim(p_state), ''),
        substring(p_market from ',[[:space:]]*([A-Za-z]{2})[[:space:]]*$')
      )) AS state_key
  ),
  blocked_values AS (
    SELECT blocked.phone_number
    FROM (
      -- No hardcoded numbers: blocks are operator-managed
      -- (system_control.sms_blocked_sender_numbers) and registry status.
      SELECT NULL::text WHERE false
    ) AS blocked(phone_number)
    UNION ALL
    SELECT trim(entry.phone_number)
    FROM public.system_control sc
    CROSS JOIN LATERAL regexp_split_to_table(
      translate(COALESCE(sc.value, ''), '[]"', ''),
      '[[:space:]]*,[[:space:]]*'
    ) AS entry(phone_number)
    WHERE sc.key = 'sms_blocked_sender_numbers'
      AND NULLIF(trim(entry.phone_number), '') IS NOT NULL
  ),
  blocked_senders AS (
    SELECT DISTINCT public.normalize_campaign_sender_phone(phone_number) AS phone_number
    FROM blocked_values
    WHERE NULLIF(public.normalize_campaign_sender_phone(phone_number), '') IS NOT NULL
  ),
  active_inventory AS (
    SELECT
      tn.id,
      tn.phone_number,
      tn.market,
      public.normalize_campaign_sender_market(tn.market) AS market_key,
      COALESCE(tn.messages_sent_today, 0) AS messages_sent_today,
      tn.last_used_at,
      EXISTS (
        SELECT 1
        FROM blocked_senders blocked
        WHERE blocked.phone_number = public.normalize_campaign_sender_phone(tn.phone_number)
      ) AS health_blocked
    FROM public.textgrid_numbers tn
    WHERE NULLIF(public.normalize_campaign_sender_phone(tn.phone_number), '') IS NOT NULL
      AND COALESCE(NULLIF(lower(trim(tn.status)), ''), 'active') = 'active'
  ),
  safe_inventory AS (
    SELECT *
    FROM active_inventory
    WHERE NOT health_blocked
  ),
  route_rules(state_key, rule_name, route_priority, target_market) AS (
    VALUES
      ('CA', 'ca_to_los_angeles', 1, 'Los Angeles, CA'),
      ('OR', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('WA', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('NV', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('AZ', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('ID', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('UT', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('NM', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('CO', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('MN', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('WI', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('IA', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('ND', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('SD', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('NE', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('IL', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('IN', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('MI', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('OH', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('MO', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('OK', 'southern_plains_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('OK', 'southern_plains_to_dallas_then_houston', 2, 'Houston, TX'),
      ('AR', 'southern_plains_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('AR', 'southern_plains_to_dallas_then_houston', 2, 'Houston, TX'),
      ('KS', 'southern_plains_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('KS', 'southern_plains_to_dallas_then_houston', 2, 'Houston, TX'),
      ('LA', 'louisiana_to_houston', 1, 'Houston, TX'),
      ('TX', 'texas_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('TX', 'texas_to_dallas_then_houston', 2, 'Houston, TX'),
      ('GA', 'georgia_to_atlanta', 1, 'Atlanta, GA'),
      ('NC', 'carolinas_to_charlotte', 1, 'Charlotte, NC'),
      ('SC', 'carolinas_to_charlotte', 1, 'Charlotte, NC'),
      ('FL', 'florida_to_jacksonville_then_miami', 1, 'Jacksonville, FL'),
      ('FL', 'florida_to_jacksonville_then_miami', 2, 'Miami, FL'),
      ('NY', 'northeast_to_miami', 1, 'Miami, FL'),
      ('NJ', 'northeast_to_miami', 1, 'Miami, FL'),
      ('PA', 'northeast_to_miami', 1, 'Miami, FL'),
      ('MD', 'northeast_to_miami', 1, 'Miami, FL'),
      ('VA', 'northeast_to_miami', 1, 'Miami, FL'),
      ('DC', 'northeast_to_miami', 1, 'Miami, FL'),
      ('DE', 'northeast_to_miami', 1, 'Miami, FL'),
      ('CT', 'northeast_to_miami', 1, 'Miami, FL'),
      ('RI', 'northeast_to_miami', 1, 'Miami, FL'),
      ('MA', 'northeast_to_miami', 1, 'Miami, FL'),
      ('NH', 'northeast_to_miami', 1, 'Miami, FL'),
      ('VT', 'northeast_to_miami', 1, 'Miami, FL'),
      ('ME', 'northeast_to_miami', 1, 'Miami, FL'),
      ('AL', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('AL', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC'),
      ('MS', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('MS', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC'),
      ('TN', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('TN', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC'),
      ('KY', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('KY', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC')
  ),
  route_candidates AS (
    SELECT
      inventory.*,
      'exact_market_match'::text AS route_type,
      'exact_market_match'::text AS routing_rule_name,
      0::integer AS route_priority
    FROM safe_inventory inventory
    CROSS JOIN route_input input
    WHERE inventory.market_key = input.market_key
    UNION ALL
    SELECT
      inventory.*,
      'approved_state_fallback'::text AS route_type,
      rules.rule_name AS routing_rule_name,
      rules.route_priority
    FROM route_input input
    JOIN route_rules rules
      ON rules.state_key = input.state_key
    JOIN safe_inventory inventory
      ON inventory.market_key = public.normalize_campaign_sender_market(rules.target_market)
  ),
  selected AS (
    SELECT *
    FROM route_candidates
    ORDER BY
      route_priority,
      messages_sent_today,
      last_used_at NULLS FIRST,
      id
    LIMIT 1
  ),
  diagnostics AS (
    SELECT
      EXISTS (
        SELECT 1
        FROM active_inventory inventory
        CROSS JOIN route_input input
        WHERE inventory.market_key = input.market_key
      ) AS exact_market_covered,
      EXISTS (
        SELECT 1
        FROM safe_inventory inventory
        CROSS JOIN route_input input
        WHERE inventory.market_key = input.market_key
      ) AS health_safe_exact,
      (SELECT COUNT(*)::integer FROM active_inventory WHERE health_blocked) AS health_blocked_sender_count
  )
  SELECT
    selected.id IS NOT NULL AS sender_covered,
    selected.id AS sender_id,
    selected.phone_number AS sender_phone_number,
    selected.market AS sender_market,
    COALESCE(selected.route_type, 'no_sender_route') AS route_type,
    selected.routing_rule_name,
    diagnostics.exact_market_covered,
    diagnostics.health_safe_exact,
    COALESCE(selected.route_type = 'approved_state_fallback', false) AS fallback_covered,
    CASE
      WHEN selected.market_key IS NULL THEN 0
      ELSE (
        SELECT COUNT(*)::integer
        FROM safe_inventory inventory
        WHERE inventory.market_key = selected.market_key
      )
    END AS safe_sender_count,
    diagnostics.health_blocked_sender_count
  FROM diagnostics
  LEFT JOIN selected ON true;
$function$;
COMMIT;
-- then (long UPDATE, own session; poll pg_stat_activity):
-- SELECT * FROM public.refresh_campaign_target_graph_sender_coverage('rollback_one_truth_20261007');
