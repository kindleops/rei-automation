#!/usr/bin/env node
// V1.5 authority-routing EVIDENCE SPLIT (reporting only).
//
// Classifies every authority-resolution property (entity_authority_resolution +
// probate_counsel_first) by the evidence that CAUSED its route. Read-only over
// the ephemeral pilot DB; changes no route, no weight, no seller-pressure logic.
// Routes are re-derived with the frozen resolver and asserted equal to the
// frozen census — any drift aborts the run.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql } from './pg.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const jrows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const csvq = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
function writeCsv(path, rows) {
  if (!rows.length) { writeFileSync(path, '(empty)\n'); return; }
  const cols = Object.keys(rows[0]);
  writeFileSync(path, [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvq(r[c])).join(','))).join('\n') + '\n');
}
const nameMatch = (owner, name) => {
  const toks = (s) => String(s ?? '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  const a = new Set(toks(owner)); const b = toks(name);
  const shared = b.filter((t) => a.has(t)); return { name_match: shared.length >= 2, surname_match: shared.length === 1 };
};

// lexical markers — must stay byte-identical to the frozen resolver
const ESTATE_RE = /\b(estate\s+of|estate|deceased|heirs?|decedent)\b/i;
const TRUST_RE = /\b(trust|trustee|revocable|irrevocable|living\s+trust)\b/i;
const COMPANY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CORPORATION|LTD|LP|L\.?P|LLP|HOLDINGS|INVESTMENTS|PROPERTIES|GROUP|CAPITAL|VENTURES|REALTY|MANAGEMENT|PARTNERS|COMPANY|ENTERPRISES|ASSOCIATES|FUND|FOUNDATION|CHURCH|BANK|AUTHORITY|ASSN|ASSOCIATION)\b/i;

// same property projection as v15Reroute, plus per-source classification lineage
function loadProps() {
  return new Map(jrows(`select row_to_json(t) from (
    select p.id property_id, p.situs_state, o.owner_name_raw, o.mailing_state,
      nullif(btrim(p.raw->'raw_keep'->>'owner_2_name'), '') owner_two_name,
      p.raw->'raw_keep'->>'Owner1OwnershipRights' vesting_raw,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      (select string_agg(distinct cl.matching_type_code::text, '|') from seller_engine.property_company_links cl where cl.property_id=p.id) company_link_types,
      (select string_agg(distinct coalesce(cl.matched_party,'null_party'), '|' order by coalesce(cl.matched_party,'null_party')) from seller_engine.property_company_links cl where cl.property_id=p.id) company_link_parties,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification in ('corporate','trust','estate')) cls_entity,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='trust') cls_trust,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='estate') cls_estate,
      (select string_agg(distinct c.classification || ':' || c.evidence_source, '|' order by c.classification || ':' || c.evidence_source)
         from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id) cls_lineage,
      exists(select 1 from seller_engine.property_liens l where l.property_id=p.id and l.lifecycle_class='probate_life_event') probate,
      exists(select 1 from seller_engine.property_foreclosure_events f where f.property_id=p.id and f.stage='reo') reo
    from seller_engine.properties p left join seller_engine.property_ownerships o on o.property_id=p.id) t`).map((r) => [r.property_id, r]));
}
function loadLinks() {
  const m = new Map();
  for (const l of jrows(`select row_to_json(t) from (
    select l.property_id, l.person_id, pe.identity_tier, pe.full_name person_name, l.renter_flag, l.link_tier, l.is_matching_property_as_owner,
      (l.raw->'matching_flags') matching_flags, coalesce(ph.cnt,0) phones, coalesce(em.cnt,0) emails
    from seller_engine.property_person_links l join seller_engine.people pe on pe.id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_phones where phone_e164 is not null and coalesce(do_not_call,false)=false and coalesce(never_call,false)=false group by person_id) ph on ph.person_id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_emails where coalesce(blocked,false)=false group by person_id) em on em.person_id=l.person_id) t`)) {
    (m.get(l.property_id) ?? m.set(l.property_id, []).get(l.property_id)).push(l);
  }
  return m;
}
function candFor(links, p) {
  return (links ?? []).map((l) => {
    const tokens = Array.isArray(l.matching_flags) ? l.matching_flags : [];
    const ns = nameMatch(p.owner_name_raw, l.person_name);
    return { id: l.person_id, person_name: l.person_name, identity_tier: l.identity_tier, link_tier: l.link_tier ?? 'none',
      renter_flag: l.renter_flag === true, owner_token: tokens.some((t) => /likely owner|potential owner/i.test(String(t))),
      owner_verdict: l.is_matching_property_as_owner === true, name_match: ns.name_match, surname_match: ns.surname_match,
      exact_key_owner: l.is_matching_property_as_owner === true && l.identity_tier === 'key' && ns.name_match,
      mailing_match: p.mailing_state && p.situs_state ? p.mailing_state === p.situs_state : false,
      phones: Number(l.phones) || 0, emails: Number(l.emails) || 0 };
  });
}

// ---- evidence categorisation -------------------------------------------------
// A canonical-grade source is a structured public/vendor record: an
// ownership_classifications row, a property_company_links row, or a probate lien
// event. Owner-NAME regex is NOT canonical-grade — it is lexical fallback and is
// reported separately so lexical-only cases never read as confirmed ownership.
function evidenceProfile(p) {
  const lineage = String(p.cls_lineage ?? '').split('|').filter(Boolean);
  const has = (s) => lineage.includes(s);
  const src = {
    cls_corporate: lineage.some((s) => s.startsWith('corporate:')),
    cls_trust_flag: has('trust:is_trust'),
    cls_trust_vesting: has('trust:vesting'),
    cls_estate_vesting: has('estate:vesting'),
    probate_lien: p.probate === true,
    company_link: (Number(p.company_links) || 0) > 0,
  };
  const name = p.owner_name_raw ?? '';
  const lex = { estate: ESTATE_RE.test(name), trust: TRUST_RE.test(name), company: COMPANY_RE.test(name) };

  const fam = {
    company: src.cls_corporate || src.company_link,
    trust: src.cls_trust_flag || src.cls_trust_vesting,
    estate: src.cls_estate_vesting || src.probate_lien,
  };
  const canonicalSources = Object.entries(src).filter(([, v]) => v).map(([k]) => k);
  // A company LINK is a transaction-party association (buyer/seller/agent on a
  // transaction record). It does NOT assert that the CURRENT owner of record is
  // an entity. Tracked so link-only authority blocks are not mistaken for
  // confirmed entity ownership.
  const parties = String(p.company_link_parties ?? '').split('|').filter(Boolean);
  const transactionPartyOnly = parties.length > 0 && parties.every((x) => x.startsWith('transaction_'));
  const agentOnly = parties.length === 1 && parties[0] === 'transaction_real_estate_agent';
  const vestingOnly = canonicalSources.length > 0
    && canonicalSources.every((k) => k === 'cls_trust_vesting' || k === 'cls_estate_vesting');
  const famCount = Object.values(fam).filter(Boolean).length;

  // conflict: probate/estate authority co-asserted with entity/trust authority.
  // These need DIFFERENT instruments (letters testamentary vs officer/trustee
  // authority); V1.5 routes estate-first, so the other requirement is unmet.
  let conflictDetail = '';
  if (fam.estate && (fam.company || fam.trust)) {
    conflictDetail = `estate_or_probate + ${[fam.company && 'company', fam.trust && 'trust'].filter(Boolean).join('+')}`;
  } else if (canonicalSources.length > 0) {
    // lexical asserts an authority family that no canonical source supports
    const lexFams = [lex.estate && 'estate', lex.trust && 'trust', lex.company && 'company'].filter(Boolean);
    const unsupported = lexFams.filter((f) => !fam[f]);
    if (unsupported.length > 0) conflictDetail = `lexical_${unsupported.join('+')}_unsupported_by_canonical`;
  }

  let category;
  if (conflictDetail) category = 'unresolved_classification_conflict';
  else if (canonicalSources.length >= 2) category = 'multiple_corroborating_sources';
  else if (vestingOnly) category = 'ownership_rights_or_vesting_evidence';
  else if (fam.estate) category = 'canonical_estate_probate_classification';
  else if (src.cls_trust_flag) category = 'canonical_trust_classification';
  else if (src.cls_corporate) category = 'canonical_entity_classification';
  else if (src.company_link) category = 'company_relationship';
  else if (lex.estate) category = 'lexical_estate_probate_fallback_only';
  else if (lex.trust) category = 'lexical_trust_fallback_only';
  else if (lex.company) category = 'lexical_entity_fallback_only';
  else category = 'unresolved_classification_conflict';

  return { src, lex, fam, canonicalSources, famCount, category, conflictDetail, lineage, parties, transactionPartyOnly, agentOnly };
}

const AUTHORITY_NEEDED = {
  canonical_entity_classification: 'verified_officer_or_authorized_signer',
  canonical_trust_classification: 'verified_trustee_with_trust_instrument',
  canonical_estate_probate_classification: 'executor_administrator_with_letters_testamentary',
  company_relationship: 'verified_officer_or_authorized_signer',
  ownership_rights_or_vesting_evidence: 'verified_trustee_or_executor_per_vesting_instrument',
  lexical_entity_fallback_only: 'entity_status_confirmation_then_officer_verification',
  lexical_trust_fallback_only: 'trust_existence_confirmation_then_trustee_verification',
  lexical_estate_probate_fallback_only: 'death_record_confirmation_then_executor_verification',
  multiple_corroborating_sources: 'verified_signer_for_the_controlling_instrument',
  unresolved_classification_conflict: 'authority_family_adjudication_then_verified_signer',
};
const ENRICHMENT_LANE = {
  canonical_entity_classification: 'sos_business_registry_officer_lookup',
  canonical_trust_classification: 'trust_instrument_and_trustee_of_record_lookup',
  canonical_estate_probate_classification: 'probate_court_docket_and_letters_retrieval',
  company_relationship: 'sos_business_registry_officer_lookup',
  ownership_rights_or_vesting_evidence: 'deed_vesting_document_pull',
  lexical_entity_fallback_only: 'sos_entity_existence_check_before_officer_lookup',
  lexical_trust_fallback_only: 'deed_vesting_document_pull_to_confirm_trust',
  lexical_estate_probate_fallback_only: 'obituary_death_record_then_probate_docket_check',
  multiple_corroborating_sources: 'controlling_instrument_determination_then_signer_lookup',
  unresolved_classification_conflict: 'manual_title_review_authority_adjudication',
};

function main() {
  const props = loadProps();
  const links = loadLinks();

  // frozen route baseline — proves this pass changed no route
  const censusPath = join(PKG, 'SELLER_ENTITY_PRECEDENCE_FULL_CENSUS.csv');
  const frozen = new Map();
  const lines = readFileSync(censusPath, 'utf8').split('\n').filter(Boolean).slice(1);
  for (const l of lines) {
    const f = l.split('","');
    frozen.set(f[0].replace(/^"/, ''), f[8]);
  }

  const rows = []; let drift = 0; let checked = 0;
  let txnPartyOnly = 0; let agentOnlyCount = 0;
  const byCategory = {}; const byRoute = {}; const byLane = {};

  for (const [pid, p] of props) {
    const cands = candFor(links.get(pid), p);
    const property = { property_id: pid, owner_name: p.owner_name_raw, owner_mailing_state: p.mailing_state, situs_state: p.situs_state,
      is_entity: (p.company_links ?? 0) > 0 || p.cls_entity === true, is_trust: p.cls_trust === true, is_estate: p.cls_estate === true,
      probate_evidence: p.probate === true, reo: p.reo === true, owner_two_name: p.owner_two_name, vesting_raw: p.vesting_raw };
    const res = resolveCanonical(property, cands);
    const route = res.execution_route;

    const expected = frozen.get(pid);
    if (expected !== undefined) { checked += 1; if (expected !== route) drift += 1; }
    if (!['entity_authority_resolution', 'probate_counsel_first'].includes(route)) continue;

    const ev = evidenceProfile(p);
    // company-LINK-only authority blocks rest on transaction-party association,
    // which never asserts current entity ownership — verify owner status first
    // rather than paying for an officer lookup that may not be needed.
    const lane = (ev.category === 'company_relationship' && ev.transactionPartyOnly)
      ? 'current_owner_entity_status_verification_before_officer_lookup'
      : ENRICHMENT_LANE[ev.category];
    byCategory[ev.category] = (byCategory[ev.category] ?? 0) + 1;
    byRoute[route] = (byRoute[route] ?? 0) + 1;
    byLane[lane] = (byLane[lane] ?? 0) + 1;
    if (ev.transactionPartyOnly) txnPartyOnly += 1;
    if (ev.agentOnly) agentOnlyCount += 1;

    rows.push({
      property_id: pid,
      owner_of_record: p.owner_name_raw ?? '',
      v1_5_route: route,
      owner_resolution_status: res.owner_resolution_status,
      // authoritative classification fields
      canonical_corporate_classification: ev.src.cls_corporate,
      canonical_trust_classification: ev.src.cls_trust_flag || ev.src.cls_trust_vesting,
      canonical_estate_classification: ev.src.cls_estate_vesting,
      probate_life_event_lien: ev.src.probate_lien,
      company_link_count: Number(p.company_links) || 0,
      vesting_ownership_rights: p.vesting_raw ?? '',
      // lexical indicators (fail-closed gate only — never a classification)
      lexical_company_marker: ev.lex.company,
      lexical_trust_marker: ev.lex.trust,
      lexical_estate_marker: ev.lex.estate,
      lexical_fallback_only: ev.canonicalSources.length === 0,
      resolver_entity_lexical_fallback: res.entity_lexical_fallback,
      // source lineage
      classification_lineage: ev.lineage.join('|'),
      company_link_matching_types: p.company_link_types ?? '',
      company_link_party_roles: ev.parties.join('|'),
      company_link_transaction_party_only: ev.transactionPartyOnly,
      company_link_agent_only: ev.agentOnly,
      canonical_source_count: ev.canonicalSources.length,
      canonical_sources: ev.canonicalSources.join('|'),
      authority_families_asserted: [ev.fam.company && 'company', ev.fam.trust && 'trust', ev.fam.estate && 'estate'].filter(Boolean).join('|'),
      // classification + next action
      evidence_category: ev.category,
      conflict_detail: ev.conflictDetail,
      authority_type_needed: AUTHORITY_NEEDED[ev.category],
      missing_authority_evidence: res.missing_evidence.join('|'),
      recommended_enrichment_lane: lane,
      outreach_status: 'blocked_pending_authority_resolution',
    });
  }

  if (drift > 0) throw new Error(`ROUTE DRIFT: ${drift}/${checked} properties changed route — aborting, this pass must be report-only`);

  writeCsv(join(PKG, 'SELLER_V1_5_AUTHORITY_EVIDENCE_BREAKDOWN.csv'), rows);
  const out = { total: rows.length, route_parity_checked: checked, route_drift: drift, by_route: byRoute, by_category: byCategory, by_lane: byLane,
    company_link_transaction_party_only: txnPartyOnly, company_link_agent_only: agentOnlyCount,
    lexical_only_authority_routes: rows.filter((r) => r.lexical_fallback_only).length };
  writeFileSync(join(PKG, 'var', 'pilot', 'authority-evidence-summary.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main();
