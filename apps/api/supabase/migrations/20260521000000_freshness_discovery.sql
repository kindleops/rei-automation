-- Rebuild candidate discovery with freshness and scoring prioritization

DROP VIEW IF EXISTS v_market_fresh_inventory CASCADE;
DROP VIEW IF EXISTS v_template_coverage_audit CASCADE;
DROP VIEW IF EXISTS v_candidate_exhaustion_metrics CASCADE;
DROP VIEW IF EXISTS v_outbound_discovery_fresh CASCADE;
DROP VIEW IF EXISTS v_outbound_candidate_freshness CASCADE;

-- 1. Outreach state junction view
CREATE OR REPLACE VIEW v_outbound_candidate_freshness AS
SELECT 
  c.*,
  p.property_type,
  p.property_class,
  s.last_sms_at,
  s.last_outbound_at,
  s.next_allowed_sms_at,
  s.current_touch_number,
  s.is_paused,
  s.pause_reason,
  (COALESCE(s.last_sms_at, s.last_outbound_at) IS NULL) as never_contacted,
  -- Freshness score: never contacted gets 100 points, recently contacted gets fewer
  (CASE 
    WHEN s.last_sms_at IS NULL THEN 100 
    ELSE GREATEST(0, 100 - EXTRACT(DAYS FROM (now() - s.last_sms_at)))
  END) as freshness_score
FROM v_sms_campaign_queue_candidates c
LEFT JOIN v_property_lead_command p ON c.property_id = p.property_id
LEFT JOIN contact_outreach_state s ON (
  c.master_owner_id = s.podio_master_owner_id 
  AND c.best_phone_e164 = s.to_phone_number
);

-- 2. Main Discovery View (Ordered for Feeder)
CREATE OR REPLACE VIEW v_outbound_discovery_fresh AS
SELECT *
FROM v_outbound_candidate_freshness
ORDER BY 
  never_contacted DESC,
  final_acquisition_score DESC NULLS LAST,
  best_phone_score DESC NULLS LAST,
  equity_percent DESC NULLS LAST;

-- 3. Exhaustion Metrics
CREATE OR REPLACE VIEW v_candidate_exhaustion_metrics AS
SELECT 
  market,
  priority_tier,
  COUNT(*) as total_candidates,
  COUNT(*) FILTER (WHERE never_contacted = true) as never_contacted_count,
  COUNT(*) FILTER (WHERE last_sms_at IS NOT NULL) as contacted_count,
  COUNT(*) FILTER (WHERE next_allowed_sms_at > now()) as suppressed_count,
  ROUND(AVG(final_acquisition_score), 2) as avg_score
FROM v_outbound_candidate_freshness
GROUP BY market, priority_tier;

-- 4. Template Coverage Audit by Market + Property Type
CREATE OR REPLACE VIEW v_template_coverage_audit AS
SELECT 
  c.market,
  c.property_type,
  COUNT(*) as total_candidate_count,
  COUNT(*) FILTER (WHERE c.never_contacted = true) as fresh_candidate_count,
  (SELECT COUNT(*) FROM sms_templates t 
   WHERE t.is_active = true 
   AND (t.property_type_scope IS NULL OR t.property_type_scope = '' OR t.property_type_scope ILIKE '%' || c.property_type || '%')
  ) as applicable_template_count
FROM v_outbound_candidate_freshness c
GROUP BY c.market, c.property_type;

-- 5. Fresh Inventory by Market
CREATE OR REPLACE VIEW v_market_fresh_inventory AS
SELECT 
  market,
  COUNT(*) as fresh_count,
  COUNT(*) FILTER (WHERE final_acquisition_score > 80) as high_score_fresh_count
FROM v_outbound_candidate_freshness
WHERE never_contacted = true
GROUP BY market
ORDER BY fresh_count DESC;
