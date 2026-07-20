// V1.6 — COMPANY OWNERSHIP EVIDENCE SEMANTICS
//
// Separates COMPANY OWNERSHIP from COMPANY ASSOCIATION.
//
// V1.5 treated any `property_company_links` row as proof that the current owner
// of record is an entity. It is not. Traced source semantics (see
// SELLER_COMPANY_LINK_SEMANTICS_SUMMARY.md §1):
//
//   company_source = 'property.transaction_linked_companies'  (matching_type '21')
//     -> the company appeared as a PARTY ON A TRANSACTION (buyer/seller/agent).
//        Historical association. Never by itself current-ownership evidence.
//   company_source = 'property.linked_company'  (matching_type blank)
//     -> the company is linked to the PROPERTY itself, carries owner_status and
//        no transaction id. Current-ownership CANDIDATE, still requiring
//        corroboration.
//
// `matching_type = '21'` is NOT a semantic code: it is perfectly collinear with
// the transaction-linked collection and carries no independent meaning. Any
// other value is treated as unknown semantics and fails closed to review.
//
// Pure and deterministic. No seller-pressure logic, no scoring, no I/O.

export const COMPANY_RELATIONSHIP_VERSION = 'company-relationship-v1_6';

// ---- relationship classes (§1) ----
export const CURRENT_OWNERSHIP_CLASSES = ['current_owner_company', 'current_owner_trust',
  'current_owner_estate', 'current_owner_institution', 'verified_entity_owner'];
export const HISTORICAL_ASSOCIATION_CLASSES = ['historical_buyer', 'historical_seller',
  'transaction_agent', 'brokerage', 'title_or_escrow_party', 'lender_or_servicer',
  'transaction_other_party'];
export const UNRESOLVED_CLASSES = ['possible_current_owner', 'company_name_match_only',
  'role_unknown', 'source_semantics_unknown'];

export const ALL_RELATIONSHIP_CLASSES = [...CURRENT_OWNERSHIP_CLASSES,
  ...HISTORICAL_ASSOCIATION_CLASSES, ...UNRESOLVED_CLASSES];

// ONLY these may independently trigger entity_authority_resolution.
const CURRENT_OWNERSHIP = new Set(CURRENT_OWNERSHIP_CLASSES);
export const isCurrentOwnershipClass = (c) => CURRENT_OWNERSHIP.has(c);

// ---- known source semantics ----
export const TRANSACTION_SOURCE = 'property.transaction_linked_companies';
export const PROPERTY_LINK_SOURCE = 'property.linked_company';
const KNOWN_MATCHING_TYPES = new Set(['21', '', null, undefined]);

// ---- company-name shape (used only to refine an already-historical role, or
// to detect an institution that cannot be an individual owner) ----
const LENDER_RE = /\b(BANK|N\.?A\.?|MORTGAGE|LENDING|LOANS?|SAVINGS|CREDIT\s+UNION|FINANCIAL|FUNDING|SERVICING|FEDERAL|FANNIE|FREDDIE|HUD|VA|SECRETARY\s+OF\s+HOUSING)\b/i;
const TITLE_RE = /\b(TITLE|ESCROW|ABSTRACT|CLOSING\s+(CO|COMPANY|SERVICES))\b/i;
const BROKERAGE_RE = /\b(REALTY|REAL\s+ESTATE|BROKERS?|BROKERAGE|REALTORS?|KELLER\s+WILLIAMS|RE\/MAX|COLDWELL|CENTURY\s*21|COMPASS|SOTHEBY)\b/i;
const TRUST_RE = /\b(TRUST|TRUSTEE|REVOCABLE|IRREVOCABLE)\b/i;
const ESTATE_RE = /\b(ESTATE\s+OF|ESTATE|HEIRS?|DECEDENT)\b/i;
const INSTITUTION_RE = /\b(CITY\s+OF|COUNTY\s+OF|STATE\s+OF|AUTHORITY|HOUSING\s+AUTHORITY|CHURCH|SCHOOL\s+DISTRICT|UNIVERSITY|MUNICIPAL|GOVERNMENT)\b/i;

// normalized token overlap between a company name and the owner of record
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['LLC', 'INC', 'CORP', 'CORPORATION', 'LTD', 'LP', 'LLP', 'CO', 'COMPANY',
  'THE', 'AND', 'OF', 'A', 'NA', 'N', 'TRUST', 'GROUP', 'HOLDINGS']);
export function companyNameMatchesOwner(companyName, ownerName) {
  const a = norm(companyName).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
  const b = new Set(norm(ownerName).split(' ').filter((t) => t.length >= 3 && !STOP.has(t)));
  if (a.length === 0 || b.size === 0) return false;
  const shared = a.filter((t) => b.has(t));
  // every significant company token present in the owner name, or >=2 shared
  return shared.length === a.length || shared.length >= 2;
}

/**
 * Classify ONE company link.
 *
 * link: { company_source, matched_party, matching_type, company_name, transaction_id }
 * ctx:  { owner_name_of_record, owner_status,
 *         transaction: { vendor_transaction_id, event_role, document_type_group,
 *                        sale_date, buyer_names, seller_names } | null,
 *         latest_qualifying_transfer_id, scoring_timestamp,
 *         canonical_corporate, canonical_trust, canonical_estate }
 */
export function classifyCompanyLink(link, ctx = {}) {
  const role = String(link.matched_party ?? '').trim();
  const source = String(link.company_source ?? '').trim();
  const mt = link.matching_type === null || link.matching_type === undefined ? '' : String(link.matching_type).trim();
  const name = link.company_name ?? '';
  const evidence = [];
  const nameMatch = companyNameMatchesOwner(name, ctx.owner_name_of_record);
  if (nameMatch) evidence.push('company_name_matches_owner_of_record');
  if (source) evidence.push(`company_source:${source}`);
  if (role) evidence.push(`matched_party:${role}`);
  if (mt) evidence.push(`matching_type:${mt}`);

  const out = (o) => ({
    relationship_class: o.cls,
    relationship_type: o.type ?? o.cls,
    relationship_scope: o.scope,
    current_or_historical: o.when,
    ownership_relevance: o.ownership,
    authority_relevance: o.authority,
    confidence: o.confidence,
    transaction_id: link.transaction_id || ctx.transaction?.vendor_transaction_id || null,
    effective_from: o.from ?? null,
    effective_to: o.to ?? null,
    source_role: role || null,
    source_collection: source || null,
    matching_type_code: mt || null,
    company_name_matches_owner: nameMatch,
    evidence_lineage: evidence,
    reason_code: o.reason,
  });

  // ---- unknown source semantics fail closed (§2 blank/unknown role) ----
  if (!KNOWN_MATCHING_TYPES.has(mt)) {
    return out({ cls: 'source_semantics_unknown', scope: 'unknown', when: 'unknown',
      ownership: 'none', authority: 'none', confidence: 0.1,
      reason: 'matching_type_code_semantics_untraced' });
  }

  // ---- transaction-party association (never independently ownership) ----
  if (source === TRANSACTION_SOURCE || role.startsWith('transaction_')) {
    const txn = ctx.transaction ?? null;
    const saleDate = txn?.sale_date ?? null;

    if (/real_estate_agent/i.test(role)) {
      // §2: agents are NEVER ownership or authority evidence.
      const isBrokerage = BROKERAGE_RE.test(name);
      return out({ cls: isBrokerage ? 'brokerage' : 'transaction_agent', scope: 'transaction_party',
        when: 'historical', ownership: 'none', authority: 'none', confidence: 0.0,
        from: saleDate, reason: 'agent_or_brokerage_never_ownership_evidence' });
    }
    if (TITLE_RE.test(name)) {
      return out({ cls: 'title_or_escrow_party', scope: 'transaction_party', when: 'historical',
        ownership: 'none', authority: 'none', confidence: 0.0, from: saleDate,
        reason: 'title_or_escrow_party_never_ownership_evidence' });
    }
    if (/seller/i.test(role)) {
      // A company that SOLD is evidence the current owner is NOT that company,
      // once a qualifying transfer completed.
      const lender = LENDER_RE.test(name);
      const transferred = Boolean(txn && txn.document_type_group
        && txn.document_type_group !== 'administrative_recording');
      return out({ cls: lender ? 'lender_or_servicer' : 'historical_seller', scope: 'transaction_party',
        when: 'historical',
        ownership: transferred ? 'negative_after_transfer' : 'none',
        authority: 'none', confidence: 0.0, to: saleDate,
        reason: lender ? 'lender_or_servicer_disposed_property' : 'historical_seller_not_current_owner' });
    }
    if (/buyer/i.test(role)) {
      // §2 corroboration ladder — ALL must hold to become current ownership.
      const isLatest = Boolean(txn && ctx.latest_qualifying_transfer_id
        && txn.vendor_transaction_id === ctx.latest_qualifying_transfer_id);
      const qualifying = Boolean(txn && txn.document_type_group
        && txn.document_type_group !== 'administrative_recording');
      const beforeScoring = Boolean(saleDate && ctx.scoring_timestamp
        && new Date(saleDate) <= new Date(ctx.scoring_timestamp));
      const noLaterTransfer = isLatest;
      const classificationConsistent = Boolean(ctx.canonical_corporate || ctx.canonical_trust);
      const corroborated = isLatest && qualifying && beforeScoring && noLaterTransfer
        && nameMatch && classificationConsistent;
      if (corroborated) {
        evidence.push('latest_qualifying_transfer', 'transfer_precedes_scoring', 'no_later_transfer',
          'canonical_classification_consistent');
        return out({ cls: 'current_owner_company', scope: 'ownership', when: 'current',
          ownership: 'establishes_current_entity_ownership', authority: 'requires_verified_signer',
          confidence: 0.85, from: saleDate,
          reason: 'buyer_corroborated_as_current_owner_via_latest_qualifying_transfer' });
      }
      const missing = [!isLatest && 'not_latest_qualifying_transfer',
        !qualifying && 'not_a_qualifying_transfer', !beforeScoring && 'transfer_not_before_scoring_ts',
        !nameMatch && 'company_name_does_not_match_owner_of_record',
        !classificationConsistent && 'no_consistent_canonical_classification'].filter(Boolean);
      evidence.push(...missing.map((m) => `missing:${m}`));
      return out({ cls: 'historical_buyer', scope: 'transaction_party', when: 'historical',
        ownership: 'insufficient_uncorroborated', authority: 'none', confidence: 0.2, from: saleDate,
        reason: `historical_buyer_uncorroborated:${missing.join('+')}` });
    }
    return out({ cls: 'transaction_other_party', scope: 'transaction_party', when: 'historical',
      ownership: 'none', authority: 'none', confidence: 0.0, from: saleDate,
      reason: 'other_transaction_party_never_ownership_evidence' });
  }

  // ---- property-linked company (no transaction role) ----
  if (source === PROPERTY_LINK_SOURCE || (!source && !role)) {
    const corporateOwned = /corporate\s*owned/i.test(String(ctx.owner_status ?? ''));
    if (INSTITUTION_RE.test(name) && (nameMatch || corporateOwned)) {
      return out({ cls: 'current_owner_institution', scope: 'ownership', when: 'current',
        ownership: 'establishes_current_entity_ownership', authority: 'requires_verified_signer',
        confidence: 0.8, reason: 'institutional_owner_of_record' });
    }
    if (ESTATE_RE.test(name) && nameMatch) {
      return out({ cls: 'current_owner_estate', scope: 'ownership', when: 'current',
        ownership: 'establishes_current_entity_ownership', authority: 'requires_verified_signer',
        confidence: 0.8, reason: 'estate_named_as_owner_of_record' });
    }
    if (TRUST_RE.test(name) && nameMatch) {
      return out({ cls: 'current_owner_trust', scope: 'ownership', when: 'current',
        ownership: 'establishes_current_entity_ownership', authority: 'requires_verified_signer',
        confidence: 0.8, reason: 'trust_named_as_owner_of_record' });
    }
    if (nameMatch && (corporateOwned || ctx.canonical_corporate)) {
      return out({ cls: 'current_owner_company', scope: 'ownership', when: 'current',
        ownership: 'establishes_current_entity_ownership', authority: 'requires_verified_signer',
        confidence: 0.85, reason: 'company_name_matches_owner_of_record_with_corporate_status' });
    }
    if (nameMatch) {
      return out({ cls: 'company_name_match_only', scope: 'unresolved', when: 'unknown',
        ownership: 'insufficient_uncorroborated', authority: 'none', confidence: 0.4,
        reason: 'company_name_matches_owner_but_no_corroborating_ownership_status' });
    }
    if (corporateOwned) {
      return out({ cls: 'possible_current_owner', scope: 'unresolved', when: 'unknown',
        ownership: 'insufficient_uncorroborated', authority: 'none', confidence: 0.35,
        reason: 'property_flagged_corporate_owned_but_company_name_does_not_match' });
    }
    return out({ cls: 'role_unknown', scope: 'unresolved', when: 'unknown',
      ownership: 'insufficient_uncorroborated', authority: 'none', confidence: 0.15,
      reason: 'property_linked_company_without_role_or_ownership_corroboration' });
  }

  // ---- anything else: role present but unrecognised ----
  return out({ cls: 'role_unknown', scope: 'unresolved', when: 'unknown',
    ownership: 'insufficient_uncorroborated', authority: 'none', confidence: 0.1,
    reason: 'unrecognised_company_link_role_or_source' });
}

/**
 * Aggregate all company links for ONE property.
 * Returns whether any link independently establishes CURRENT entity ownership.
 */
export function classifyPropertyCompanyLinks(links, ctx = {}) {
  const classified = (links ?? []).map((l) => classifyCompanyLink(l, ctx));
  const ownership = classified.filter((c) => isCurrentOwnershipClass(c.relationship_class));
  const historical = classified.filter((c) => HISTORICAL_ASSOCIATION_CLASSES.includes(c.relationship_class));
  const unresolved = classified.filter((c) => UNRESOLVED_CLASSES.includes(c.relationship_class));
  return {
    version: COMPANY_RELATIONSHIP_VERSION,
    links: classified,
    establishes_current_entity_ownership: ownership.length > 0,
    current_ownership_links: ownership,
    historical_association_links: historical,
    unresolved_links: unresolved,
    classes: [...new Set(classified.map((c) => c.relationship_class))].sort(),
    best_confidence: classified.reduce((m, c) => Math.max(m, c.confidence), 0),
  };
}
