-- PROPOSED (not applied) — Campaign identity release evidence (2026-10-05).
--
-- WHY. Campaign builds hold rows under missing_identity_linkage,
-- entity_contact_requires_review and ambiguous_phone_ownership. The owner
-- approved deterministic releases (R1 co-owner on title, R2 same person,
-- R3 entity principal by Contact Matching Tags). The evidence lives in the
-- `seller` schema and public.prospects; PostgREST does not expose `seller`, so
-- the build reads it through this narrow, read-only SECURITY DEFINER accessor
-- (same pattern as campaign_entity_contact_review_flags). The DECISION stays
-- in apps/api/src/lib/domain/campaigns/identity-release.js — this function
-- returns facts only, never a verdict.
--
-- WHAT.
--   1. index seller.property_entity_contact_v1(selected_person_key) — the
--      "how many entities does this person front" count is otherwise a scan
--      of the 48K-row table per property (CONCURRENTLY is not allowed inside a
--      transaction; at 48K rows the plain build takes well under a second).
--   2. public.campaign_identity_release_evidence(text[], text[]) — one row per
--      input property with a jsonb evidence object. service_role only.
--
-- The block between BEGIN EVIDENCE QUERY / END EVIDENCE QUERY is also executed
-- verbatim (parameters bound) by apps/api/scripts/identity-hold-shadow-dry-run.mjs,
-- so the dry run and the live accessor cannot drift.
--
-- LOAD. Every lookup is an index probe: property_owner_resolution_v1 PK,
-- property_entity_contact_v1 PK + the new index, owner_portfolio_property
-- (property_id) / PK, owner_phone (individual_key), owner PK, prospects
-- (individual_key). Callers send ≤500 properties per call, and only the rows
-- the build would otherwise HOLD (a few hundred per campaign).
--
-- PRETEST: supabase/tests/campaign_identity_release_evidence_test.sql (one
-- transaction, ROLLBACK). ROLLBACK: PROPOSED_20261005120000_campaign_identity_release_evidence_rollback.sql
--
-- Apply only with owner approval, as ONE transaction:
--   psql "$SUPABASE_DB_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS property_entity_contact_v1_selected_person_idx
  ON seller.property_entity_contact_v1 (selected_person_key);

CREATE OR REPLACE FUNCTION public.campaign_identity_release_evidence(p_property_ids text[], p_phones text[])
RETURNS TABLE(property_id text, evidence jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'seller', 'pg_temp'
AS $function$
-- BEGIN EVIDENCE QUERY
with input as (
  select t.property_id, nullif(regexp_replace(coalesce(t.phone, ''), '^\+?1?(?=[0-9]{10}$)', ''), '') as phone
  from unnest(p_property_ids, p_phones) as t(property_id, phone)
  where t.property_id is not null
)
select i.property_id,
  jsonb_build_object(
    'resolution', (
      select jsonb_build_object(
        'status', r.owner_resolution_status,
        'co_owner_individual_key', r.co_owner_individual_key,
        'deed_owner_name', r.deed_owner_name,
        'operational_owner_name', r.operational_owner_name)
      from seller.property_owner_resolution_v1 r where r.property_id = i.property_id),
    -- People linked to THIS property whose own phone record is the graph phone.
    'phone_holders', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'individual_key', x.individual_key,
        'given_name', ow.given_name, 'surname', ow.surname, 'full_name', ow.full_name,
        'likely_renting', ow.likely_renting,
        'tags_on_property', (
          select string_agg(pr.matching_flags, ',') from public.prospects pr
          where pr.individual_key = x.individual_key and pr.linked_property_ids_json ? i.property_id)
      ) order by x.individual_key), '[]'::jsonb)
      from (
        select distinct op.individual_key
        from seller.owner_portfolio_property opp
        join seller.owner_phone op on op.individual_key = opp.individual_key
        where opp.property_id = i.property_id and i.phone is not null and op.phone_value = i.phone
      ) x
      left join seller.owner ow on ow.individual_key = x.individual_key),
    'entity', (
      select jsonb_build_object(
        'requires_review', ec.requires_review,
        'exclusion_reasons', to_jsonb(ec.exclusion_reasons),
        'evidence_codes', to_jsonb(ec.evidence_codes),
        'entity_status', ec.entity_status,
        'owning_entity_name', ec.owning_entity_name,
        'selected_person_key', ec.selected_person_key)
      from seller.property_entity_contact_v1 ec where ec.property_id = i.property_id),
    -- The entity's selected person: vendor match facts + Contact Matching Tags
    -- on the prospect row(s) that link this person to THIS property.
    'person', (
      select jsonb_build_object(
        'full_name', o.full_name, 'given_name', o.given_name, 'surname', o.surname,
        'matching_type', o.matching_type,
        'matches_property_owner', o.matches_property_owner,
        'likely_owner', o.likely_owner,
        'likely_renting', o.likely_renting,
        'in_portfolio', exists (
          select 1 from seller.owner_portfolio_property opp
          where opp.individual_key = ec.selected_person_key and opp.property_id = i.property_id),
        'phone_is_own', exists (
          select 1 from seller.owner_phone op
          where op.individual_key = ec.selected_person_key
            and op.phone_value = coalesce(i.phone, nullif(ec.selected_phone, ''))),
        'entity_fanout', (
          select count(distinct upper(e2.owning_entity_name)) from seller.property_entity_contact_v1 e2
          where e2.selected_person_key = ec.selected_person_key),
        'tags_on_property', (
          select string_agg(pr.matching_flags, ',') from public.prospects pr
          where pr.individual_key = ec.selected_person_key and pr.linked_property_ids_json ? i.property_id))
      from seller.property_entity_contact_v1 ec
      join seller.owner o on o.individual_key = ec.selected_person_key
      where ec.property_id = i.property_id)
  ) as evidence
from input i
-- END EVIDENCE QUERY
$function$;

REVOKE ALL ON FUNCTION public.campaign_identity_release_evidence(text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_identity_release_evidence(text[], text[]) TO service_role;

COMMENT ON FUNCTION public.campaign_identity_release_evidence(text[], text[]) IS
  'Read-only facts for the campaign identity release predicate (identity-release.js). Never a verdict. service_role only. 2026-10-05.';
