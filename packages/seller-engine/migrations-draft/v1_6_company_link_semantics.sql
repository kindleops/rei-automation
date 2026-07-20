-- V1.6 — company link relationship semantics.
--
-- DRAFT. NOT APPLIED. Not run against production, and not run against the pilot
-- (the pilot derives these fields from source_records.payload at read time).
--
-- Problem: `property_company_links` carried one generic relationship and was
-- read as proof that the current owner of record is an entity. It is not — the
-- overwhelming majority of rows are TRANSACTION-PARTY associations (a company
-- that was a buyer, seller, or listing agent on some past transaction).
--
-- The importer additionally DROPS the two fields that carry the actual meaning:
--   company_source  ('property.transaction_linked_companies' | 'property.linked_company')
--   transaction_id  (the transaction the association came from)
-- Both survive on source_records.payload; this migration persists them and the
-- derived relationship semantics so historical associations stay available for
-- lineage WITHOUT contaminating current-ownership resolution.

alter table seller_engine.property_company_links
  -- what the relationship IS
  add column if not exists relationship_type      text,   -- e.g. historical_seller, current_owner_company
  add column if not exists relationship_scope     text,   -- ownership | transaction_party | unresolved | unknown
  add column if not exists current_or_historical  text,   -- current | historical | unknown

  -- where it came from
  add column if not exists source_collection      text,   -- payload.company_source (was dropped)
  add column if not exists source_role            text,   -- payload.matched_party
  add column if not exists transaction_id         text,   -- payload.transaction_id (was dropped)
  add column if not exists source_timestamp       timestamptz,

  -- when it was true
  add column if not exists effective_from         date,
  add column if not exists effective_to           date,

  -- what it is allowed to prove
  add column if not exists ownership_relevance    text,   -- establishes_current_entity_ownership
                                                          -- | insufficient_uncorroborated
                                                          -- | negative_after_transfer | none
  add column if not exists authority_relevance    text,   -- requires_verified_signer | none
  add column if not exists confidence             numeric,
  add column if not exists evidence_lineage       text[];

comment on column seller_engine.property_company_links.ownership_relevance is
  'ONLY establishes_current_entity_ownership may independently trigger entity_authority_resolution. '
  'A transaction-party association never establishes current entity ownership.';

comment on column seller_engine.property_company_links.source_collection is
  'property.transaction_linked_companies => transaction-party association (matching_type 21, a '
  'source-collection marker with no independent semantic meaning). property.linked_company => '
  'property-linked company, a current-ownership CANDIDATE still requiring corroboration.';

-- Guard: only current-ownership relationships may be treated as ownership evidence.
alter table seller_engine.property_company_links
  add constraint property_company_links_ownership_relevance_chk
  check (ownership_relevance is null or ownership_relevance in
    ('establishes_current_entity_ownership', 'insufficient_uncorroborated',
     'negative_after_transfer', 'none'));

create index if not exists property_company_links_ownership_relevance_idx
  on seller_engine.property_company_links (property_id, ownership_relevance);

-- Backfill from the retained source payloads (semantics per
-- scores/companyRelationship.mjs; classification itself stays in code).
--
-- update seller_engine.property_company_links cl
--    set source_collection = sr.payload->>'company_source',
--        transaction_id    = nullif(sr.payload->>'transaction_id',''),
--        source_role       = nullif(sr.payload->>'matched_party','')
--   from seller_engine.source_records sr
--   join seller_engine.properties p on p.vendor_property_id = sr.payload->>'property_id'
--  where cl.property_id = p.id
--    and sr.import_batch_id = 'batch_58091ee03d7c43cc467090b1';
