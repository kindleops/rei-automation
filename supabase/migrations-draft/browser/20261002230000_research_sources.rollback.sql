-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK for 20261002230000_research_sources.sql (Browser 1.0 Save Source).
--
-- Drops only the two tables that migration created; nothing else depends on
-- them (the API answers research_store_unavailable again and the dashboard
-- falls back to keeping sources on the device; the Machine Feed research
-- adapter reads nothing and stays quiet).
--
-- Rollback-only test: run the forward migration and this file inside one
-- transaction that ends in ROLLBACK, e.g.
--   begin; \i 20261002230000_research_sources.sql; \i 20261002230000_research_sources.rollback.sql; rollback;
-- ════════════════════════════════════════════════════════════════════════════

drop table if exists public.research_source_audit;
drop table if exists public.research_sources;
