-- Rollback for PROPOSED_20261007100000_campaign_graph_list_text_trgm_indexes.sql
DROP INDEX CONCURRENTLY IF EXISTS public.idx_ctg_property_flags_text_trgm;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_ctg_podio_tags_trgm;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_ctg_matching_flags_text_trgm;
