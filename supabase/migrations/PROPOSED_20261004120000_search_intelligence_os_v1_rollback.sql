-- ROLLBACK for PROPOSED_20261004120000_search_intelligence_os_v1.sql. PROPOSED, NOT APPLIED.
-- Drops only search_* objects created by that proposal; nothing outside the search domain.
begin;
drop table if exists
  public.search_opportunities, public.search_health_checks, public.search_keyword_research, public.search_events,
  public.search_page_metrics_daily, public.search_performance_daily, public.search_sync_runs,
  public.search_keyword_page_ownership, public.search_keywords, public.search_page_geographies,
  public.search_page_relationships, public.search_page_aliases, public.search_pages, public.search_keyword_clusters,
  public.search_geographies, public.search_launch_waves, public.search_property_connections, public.search_properties
  cascade;
drop function if exists public.search_alias_not_a_page();
drop function if exists public.search_touch_updated_at();
commit;
