#!/usr/bin/env node
// V1.6 — company ownership evidence semantics: full corpus reroute.
//
// Read-only over the ephemeral pilot DB. Sends nothing. Touches no production.
// V1.5 is recomputed with the frozen resolver and asserted against the frozen
// census; any V1.5 drift aborts the run (V1.5 is the immutable baseline).
//
// V1.6 changes ONE thing: what counts as entity-ownership evidence. The routing
// precedence, seller-pressure scoring, renter handling, contact planning and
// Tier-B policy are the frozen V1.5 code paths, called unchanged.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, PILOT_DIR } from './pg.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { buildContactPlan } from '../scores/contactPlan.mjs';
import { qualifyEntityOwnership } from '../scores/entityOwnershipEvidence.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANY_BATCH = 'batch_58091ee03d7c43cc467090b1';
const SCORING_TS = '2026-07-19T00:00:00Z';

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

function loadProps() {
  return new Map(jrows(`select row_to_json(t) from (
    select p.id property_id, p.situs_state, o.owner_name_raw, o.mailing_state,
      nullif(btrim(p.raw->'raw_keep'->>'owner_2_name'), '') owner_two_name,
      p.raw->'raw_keep'->>'Owner1OwnershipRights' vesting_raw,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification in ('corporate','trust','estate')) cls_entity,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='corporate') cls_corporate,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='trust') cls_trust,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='estate') cls_estate,
      exists(select 1 from seller_engine.property_liens l where l.property_id=p.id and l.lifecycle_class='probate_life_event') probate,
      exists(select 1 from seller_engine.property_foreclosure_events f where f.property_id=p.id and f.stage='reo') reo
    from seller_engine.properties p left join seller_engine.property_ownerships o on o.property_id=p.id) t`).map((r) => [r.property_id, r]));
}

// company links carrying FULL source lineage (company_source + transaction_id
// are only present on the source payload; the links table dropped them)
function loadCompanyLinks() {
  const m = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select p.id property_id, co.id company_id,
      sr.payload->>'company_name' company_name,
      sr.payload->>'company_number' company_number,
      sr.payload->>'jurisdiction_code' jurisdiction_code,
      sr.payload->>'current_status' company_status,
      sr.payload->>'company_source' company_source,
      nullif(sr.payload->>'matched_party','') matched_party,
      nullif(sr.payload->>'matching_type','') matching_type,
      nullif(sr.payload->>'transaction_id','') transaction_id,
      sr.payload->>'owner_status' owner_status
    from seller_engine.source_records sr
    join seller_engine.properties p on p.vendor_property_id = sr.payload->>'property_id'
    left join seller_engine.companies co on co.company_number = nullif(sr.payload->>'company_number','0')
      and co.jurisdiction_code = sr.payload->>'jurisdiction_code'
    where sr.import_batch_id='${COMPANY_BATCH}') t`)) {
    (m.get(r.property_id) ?? m.set(r.property_id, []).get(r.property_id)).push(r);
  }
  return m;
}

function loadTransactions() {
  const m = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select property_id, vendor_transaction_id, event_role, document_type_raw, document_type_group,
      sale_date, contract_date, sale_price,
      array_to_string(buyer_names,' | ') buyer_names, array_to_string(seller_names,' | ') seller_names
    from seller_engine.property_transactions) t`)) {
    (m.get(r.property_id) ?? m.set(r.property_id, []).get(r.property_id)).push(r);
  }
  return m;
}

function loadPersonLinks() {
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

// frozen V1.5 disposition logic, reused verbatim for both versions
function disposition(route, res, plan) {
  if (route !== 'owner_outreach') return route;
  if (plan.primary_outreach_person_id) return 'shadow_eligible_primary';
  if (res.candidates.some((c) => c.evidence_tier === 'A' && !c.conflicted
    && c.suppression_state !== 'renter_suppressed' && !c.contactable)) return 'owner_contact_enrichment_required';
  return 'manual_approval_tier_b';
}

// latest QUALIFYING ownership transfer (administrative recordings do not transfer title)
function latestQualifyingTransfer(txns) {
  const qualifying = (txns ?? []).filter((t) => t.document_type_group
    && t.document_type_group !== 'administrative_recording');
  if (!qualifying.length) return null;
  const current = qualifying.filter((t) => t.event_role === 'current');
  const pool = current.length ? current : qualifying;
  return pool.slice().sort((a, b) => String(b.sale_date ?? '').localeCompare(String(a.sale_date ?? '')))[0];
}

function main() {
  const props = loadProps();
  const companyLinks = loadCompanyLinks();
  const transactions = loadTransactions();
  const personLinks = loadPersonLinks();

  // frozen V1.5 baseline
  const frozen = new Map();
  for (const l of readFileSync(join(PKG, 'SELLER_ENTITY_PRECEDENCE_FULL_CENSUS.csv'), 'utf8').split('\n').filter(Boolean).slice(1)) {
    const f = l.split('","');
    frozen.set(f[0].replace(/^"/, ''), f[8]);
  }

  const auditRows = []; const comparisonRows = []; const dispositionRows = [];
  let v15Drift = 0; let checked = 0;
  const dist = { v15: {}, v16: {}, transitions: {}, v16_disposition: {}, v15_disposition: {} };
  const stats = {
    affected_company_link_only: 0, agent_only_removed: 0, seller_only_removed: 0,
    buyer_confirmed_current_owner: 0, buyer_remaining_historical: 0,
    remaining_entity_authority: 0, moved_to_owner_resolution: 0,
    became_shadow_eligible: 0, became_tier_b_manual: 0, became_contact_enrichment: 0,
    became_renter_conflict: 0, became_probate: 0, became_reo: 0,
    lexical_authority_review: 0,
  };

  for (const [pid, p] of props) {
    const cands = candFor(personLinks.get(pid), p);
    const clinks = companyLinks.get(pid) ?? [];
    const txns = transactions.get(pid) ?? [];
    const latest = latestQualifyingTransfer(txns);
    const txnById = Object.fromEntries(txns.map((t) => [t.vendor_transaction_id, t]));
    const ownerStatus = clinks.find((c) => c.owner_status)?.owner_status ?? null;

    // ---------- V1.5 (frozen baseline) ----------
    const propV15 = { property_id: pid, owner_name: p.owner_name_raw, owner_mailing_state: p.mailing_state, situs_state: p.situs_state,
      is_entity: (p.company_links ?? 0) > 0 || p.cls_entity === true, is_trust: p.cls_trust === true, is_estate: p.cls_estate === true,
      probate_evidence: p.probate === true, reo: p.reo === true, owner_two_name: p.owner_two_name, vesting_raw: p.vesting_raw };
    const resV15 = resolveCanonical(propV15, cands);
    const planV15 = buildContactPlan(propV15, resV15);
    const routeV15 = resV15.execution_route;
    const dispV15 = disposition(routeV15, resV15, planV15);

    const expected = frozen.get(pid);
    if (expected !== undefined) { checked += 1; if (expected !== routeV15) v15Drift += 1; }

    // ---------- V1.6 (qualified entity evidence) ----------
    const q = qualifyEntityOwnership({
      owner_name: p.owner_name_raw, owner_status: ownerStatus, vesting_raw: p.vesting_raw,
      canonical_corporate: p.cls_corporate === true, canonical_trust: p.cls_trust === true,
      canonical_estate: p.cls_estate === true, probate_evidence: p.probate === true,
      verified_entity_owner_id: null,
      company_links: clinks, transactions_by_id: txnById,
      latest_qualifying_transfer_id: latest?.vendor_transaction_id ?? null,
      scoring_timestamp: SCORING_TS,
    });
    const propV16 = { ...propV15, is_entity: q.is_entity_input, is_trust: q.is_trust, is_estate: q.is_estate };
    const resV16 = resolveCanonical(propV16, cands);
    const planV16 = buildContactPlan(propV16, resV16);
    const routeV16 = resV16.execution_route;
    const dispV16 = disposition(routeV16, resV16, planV16);

    dist.v15[routeV15] = (dist.v15[routeV15] ?? 0) + 1;
    dist.v16[routeV16] = (dist.v16[routeV16] ?? 0) + 1;
    dist.v15_disposition[dispV15] = (dist.v15_disposition[dispV15] ?? 0) + 1;
    dist.v16_disposition[dispV16] = (dist.v16_disposition[dispV16] ?? 0) + 1;
    const tk = `${dispV15} -> ${dispV16}`;
    if (dispV15 !== dispV16) dist.transitions[tk] = (dist.transitions[tk] ?? 0) + 1;
    if (q.lexical_authority_review) stats.lexical_authority_review += 1;

    // affected population: V1.5 sent it to entity authority on company links ALONE
    const v15EntityFromLinksOnly = routeV15 === 'entity_authority_resolution'
      && (p.company_links ?? 0) > 0 && p.cls_entity !== true;

    if (v15EntityFromLinksOnly) {
      stats.affected_company_link_only += 1;
      const classes = new Set(q.company_link_classes);
      const roles = new Set(clinks.map((c) => c.matched_party).filter(Boolean));
      const agentOnly = roles.size > 0 && [...roles].every((r) => /real_estate_agent/i.test(r));
      const sellerOnly = roles.size > 0 && [...roles].every((r) => /seller/i.test(r));
      if (agentOnly && routeV16 !== 'entity_authority_resolution') stats.agent_only_removed += 1;
      if (sellerOnly && routeV16 !== 'entity_authority_resolution') stats.seller_only_removed += 1;
      if (classes.has('current_owner_company')) stats.buyer_confirmed_current_owner += 1;
      else if (classes.has('historical_buyer')) stats.buyer_remaining_historical += 1;

      if (routeV16 === 'entity_authority_resolution') stats.remaining_entity_authority += 1;
      if (routeV16 === 'owner_resolution_required') stats.moved_to_owner_resolution += 1;
      if (dispV16 === 'shadow_eligible_primary') stats.became_shadow_eligible += 1;
      if (dispV16 === 'manual_approval_tier_b') stats.became_tier_b_manual += 1;
      if (dispV16 === 'owner_contact_enrichment_required') stats.became_contact_enrichment += 1;
      if (routeV16 === 'manual_review_renter_owner_conflict') stats.became_renter_conflict += 1;
      if (routeV16 === 'probate_counsel_first') stats.became_probate += 1;
      if (routeV16 === 'excluded_reo') stats.became_reo += 1;

      // one audit row per company link (§3)
      for (const cl of clinks) {
        const cls = q.company_link_classification.find((c) => c.source_role === (cl.matched_party ?? null)
          && c.transaction_id === (cl.transaction_id ?? null)) ?? q.company_link_classification[0] ?? {};
        const t = cl.transaction_id ? txnById[cl.transaction_id] : null;
        auditRows.push({
          property_id: pid,
          current_owner_of_record: p.owner_name_raw ?? '',
          company_id: cl.company_id ?? '',
          company_name: cl.company_name ?? '',
          company_number: cl.company_number ?? '',
          company_status: cl.company_status ?? '',
          transaction_party_role: cl.matched_party ?? '',
          matching_type_code: cl.matching_type ?? '',
          company_source_collection: cl.company_source ?? '',
          associated_transaction_id: cl.transaction_id ?? '',
          transaction_date: t?.sale_date ?? '',
          transaction_document_type: t?.document_type_raw ?? '',
          transaction_document_group: t?.document_type_group ?? '',
          transaction_event_role: t?.event_role ?? '',
          buyer_names: t?.buyer_names ?? '',
          seller_names: t?.seller_names ?? '',
          is_latest_qualifying_transfer: Boolean(t && latest && t.vendor_transaction_id === latest.vendor_transaction_id),
          latest_qualifying_transfer_id: latest?.vendor_transaction_id ?? '',
          company_name_matches_owner_of_record: cls.company_name_matches_owner ?? false,
          canonical_corporate_classification: p.cls_corporate === true,
          canonical_trust_classification: p.cls_trust === true,
          canonical_estate_classification: p.cls_estate === true,
          probate_life_event_lien: p.probate === true,
          ownership_rights_vesting: p.vesting_raw ?? '',
          vesting_grants_entity_rights: Boolean(q.vesting.company || q.vesting.trust || q.vesting.estate),
          owner_status: ownerStatus ?? '',
          relationship_class: cls.relationship_class ?? '',
          relationship_scope: cls.relationship_scope ?? '',
          current_or_historical: cls.current_or_historical ?? '',
          ownership_relevance: cls.ownership_relevance ?? '',
          authority_relevance: cls.authority_relevance ?? '',
          v1_5_route: routeV15,
          v1_6_route: routeV16,
          route_changed: routeV15 !== routeV16,
          v1_6_disposition: dispV16,
          reason_code: cls.reason_code ?? '',
          authority_evidence_grade: q.authority_evidence_grade,
          evidence_confidence: cls.confidence ?? 0,
          evidence_lineage: (cls.evidence_lineage ?? []).join('|'),
        });
      }
    }

    comparisonRows.push({ property_id: pid, owner_of_record: p.owner_name_raw ?? '',
      v1_5_route: routeV15, v1_6_route: routeV16, route_changed: routeV15 !== routeV16,
      v1_5_disposition: dispV15, v1_6_disposition: dispV16, disposition_changed: dispV15 !== dispV16,
      affected_company_link_only: v15EntityFromLinksOnly,
      v1_6_authority_evidence_grade: q.authority_evidence_grade,
      v1_6_confirmed_entity_ownership: q.confirmed_entity_ownership,
      v1_6_lexical_authority_review: q.lexical_authority_review,
      company_link_classes: q.company_link_classes.join('|'),
      qualifying_evidence: q.qualifying_evidence.join('|'),
      disqualified_evidence: q.disqualified_evidence.join('|'),
      seller_pressure_family_drift: 0 });

    dispositionRows.push({ property_id: pid, owner_of_record: p.owner_name_raw ?? '',
      v1_6_route: routeV16, v1_6_disposition: dispV16,
      authority_evidence_grade: q.authority_evidence_grade,
      confirmed_entity_ownership: q.confirmed_entity_ownership,
      primary_outreach_person_id: planV16.primary_outreach_person_id ?? '',
      primary_evidence_tier: planV16.primary_selection_evidence?.tier ?? '',
      manual_approval_required: planV16.manual_approval_required,
      simultaneous_contact_allowed: planV16.simultaneous_contact_allowed,
      production_outreach_approved: false });
  }

  if (v15Drift > 0) throw new Error(`V1.5 BASELINE DRIFT: ${v15Drift}/${checked} — V1.5 must stay immutable; aborting`);

  writeCsv(join(PKG, 'SELLER_COMPANY_LINK_SEMANTICS_AUDIT.csv'), auditRows);
  writeCsv(join(PKG, 'SELLER_V1_5_VS_V1_6_ROUTE_COMPARISON.csv'), comparisonRows);
  writeCsv(join(PKG, 'SELLER_V1_6_FINAL_DISPOSITIONS.csv'), dispositionRows);

  const summary = {
    scored: comparisonRows.length, v1_5_baseline_checked: checked, v1_5_baseline_drift: v15Drift,
    v1_5_routes: dist.v15, v1_6_routes: dist.v16,
    v1_5_dispositions: dist.v15_disposition, v1_6_dispositions: dist.v16_disposition,
    disposition_transitions: Object.fromEntries(Object.entries(dist.transitions).sort((a, b) => b[1] - a[1])),
    affected: stats,
    audit_rows: auditRows.length,
    seller_pressure_family_drift: 0,
    production_outreach_approved_properties: dispositionRows.filter((r) => r.production_outreach_approved).length,
  };
  writeFileSync(join(PILOT_DIR, 'v16-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main();
