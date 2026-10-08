-- ============================================================================
-- Prominent Cash Offer — appointment types and pools (scheduling core client #1)
-- ============================================================================
-- Brand-owned configuration, not core mechanics. Pools are created EMPTY: no
-- staff assignment is invented here. A team member joins a pool from the
-- Calendar (cockpit/scheduling pool-member) once their hours are set; until
-- someone is in a pool, Prominent honestly shows no available times.
--
-- Routing:
--   property_conversation   round robin across seller advisors
--   offer_review            the opportunity's owner; if they are not free at a
--                           time, any seller advisor
--   title_closing_question  transaction team (closing cases record no owner
--                           today), falling back to seller advisors
--   closing_support         same, short notice, short horizon

BEGIN;

INSERT INTO public.scheduling_pools (brand_key, pool_key, name) VALUES
  ('prominent_cash_offer', 'seller_advisors', 'Seller advisors'),
  ('prominent_cash_offer', 'transaction_team', 'Transaction team')
ON CONFLICT (brand_key, pool_key) DO NOTHING;

INSERT INTO public.scheduling_event_types
  (brand_key, type_key, name, description, duration_minutes, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes, horizon_days, location_kind, routing)
VALUES
  ('prominent_cash_offer', 'property_conversation', 'Property conversation', 'A first conversation about the property and the seller''s goals.', 30, 30, 0, 10, 120, 14, 'outbound_phone',
    '{"strategy":"round_robin","pool":"seller_advisors"}'),
  ('prominent_cash_offer', 'offer_review', 'Offer review', 'Walk through the written offer and answer questions.', 30, 30, 0, 10, 120, 14, 'outbound_phone',
    '{"strategy":"specific_owner","owner":"opportunity_owner","owner_unavailable":"route_to_pool","pool":"seller_advisors"}'),
  ('prominent_cash_offer', 'title_closing_question', 'Title / closing question', 'Questions about title, documents or the closing.', 30, 30, 0, 10, 120, 14, 'outbound_phone',
    '{"strategy":"specific_owner","owner":"transaction_owner","owner_unavailable":"route_to_pool","pool":"transaction_team","fallback_pool":"seller_advisors"}'),
  ('prominent_cash_offer', 'closing_support', 'Closing support', 'Help on or right before closing day.', 20, 20, 0, 5, 30, 7, 'outbound_phone',
    '{"strategy":"specific_owner","owner":"transaction_owner","owner_unavailable":"route_to_pool","pool":"transaction_team","fallback_pool":"seller_advisors"}')
ON CONFLICT (brand_key, type_key) DO NOTHING;

COMMIT;
