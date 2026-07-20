#!/usr/bin/env node
// V1.5 full reroute: entity/authority precedence census + V1.4-vs-V1.5
// comparison + regenerated contact plans + joint-party audit. Read-only over
// the pilot DB; sends nothing. Seller-pressure read-only.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, PILOT_DIR } from './pg.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { outreachEligibility } from '../scores/outreachEligibility.mjs';
import { buildContactPlan } from '../scores/contactPlan.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
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
    select p.id property_id, p.asset_class, p.situs_state, o.owner_name_raw, o.mailing_state, o.occupancy_raw,
      nullif(btrim(p.raw->'raw_keep'->>'owner_2_name'), '') owner_two_name,
      p.raw->'raw_keep'->>'Owner1OwnershipRights' vesting_raw,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification in ('corporate','trust','estate')) cls_entity,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='trust') cls_trust,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='estate') cls_estate,
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
// legacy (V1.4) person-level eligibility: Tier A OR approved Tier B on a legacy owner_outreach property
function legacyEligible(c, legacyRoute) {
  if (legacyRoute !== 'owner_outreach') return false;
  if (c.suppression_state === 'renter_suppressed' || c.conflicted) return false;
  if (!(c.phones + c.emails > 0)) return false;
  const approvedB = c.evidence_tier === 'B' && ((c.evidence.includes('owner_token') && c.evidence.includes('owner_match_verdict')) || (c.evidence.includes('owner_name_match') && c.evidence.includes('mailing_address_match')));
  return c.evidence_tier === 'A' || approvedB;
}

function main() {
  const props = loadProps();
  const links = loadLinks();

  const census = []; const comparison = []; const planRows = []; const jointRows = [];
  const dist = { v14_route: {}, v15_route: {}, transitions: {}, final_disposition: {} };
  let leakReconciled = 0; let eligRevoked = 0; let eligRetained = 0; let tierBtoManual = 0;
  let entityMoves = 0; let enrichmentCases = 0;
  let leak2944 = 0; let leak2944Rerouted = 0;   // exact Phase-5 ENTITY_NAME_RE reconciliation
  const OLD_ENTITY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CORPORATION|LTD|LP|L\.?P|LLP|HOLDINGS|INVESTMENTS|PROPERTIES|GROUP|CAPITAL|VENTURES|REALTY|MANAGEMENT|PARTNERS|TRUST|ESTATE|BANK|COMPANY|ENTERPRISES|ASSOCIATES|FUND|FOUNDATION|CHURCH|CITY OF|COUNTY OF|AUTHORITY|ASSN|ASSOCIATION)\b/i;

  for (const [pid, p] of props) {
    const cands = candFor(links.get(pid), p);
    const property = { property_id: pid, owner_name: p.owner_name_raw, owner_mailing_state: p.mailing_state, situs_state: p.situs_state,
      is_entity: (p.company_links ?? 0) > 0 || p.cls_entity === true, is_trust: p.cls_trust === true, is_estate: p.cls_estate === true,
      probate_evidence: p.probate === true, reo: p.reo === true, owner_two_name: p.owner_two_name, vesting_raw: p.vesting_raw };
    const res = resolveCanonical(property, cands);
    const v14 = res.legacy_route_v1_4; const v15 = res.execution_route;
    dist.v14_route[v14] = (dist.v14_route[v14] ?? 0) + 1;
    dist.v15_route[v15] = (dist.v15_route[v15] ?? 0) + 1;
    const tk = `${v14} -> ${v15}`; dist.transitions[tk] = (dist.transitions[tk] ?? 0) + 1;

    // leak reconciliation: V1.4 owner_outreach but entity/trust/estate name -> now authority
    const wasLeak = v14 === 'owner_outreach' && (res.is_entity || res.is_estate);
    if (wasLeak && v15 !== 'owner_outreach') leakReconciled += 1;
    if (v14 === 'owner_outreach' && (v15 === 'entity_authority_resolution' || v15 === 'probate_counsel_first')) entityMoves += 1;
    // exact reconciliation of the Phase-5-identified 2,944 (OLD ENTITY_NAME_RE on V1.4 owner_outreach)
    const phase5Leak = v14 === 'owner_outreach' && OLD_ENTITY_RE.test(p.owner_name_raw ?? '');
    if (phase5Leak) { leak2944 += 1; if (v15 !== 'owner_outreach') leak2944Rerouted += 1; }

    // person-level eligibility revoked/retained
    for (const c of res.candidates) {
      const wasElig = legacyEligible(c, v14);
      const nowElig = outreachEligibility(c, res).status === 'outreach_eligible';
      if (wasElig && !nowElig) { eligRevoked += 1; if (c.evidence_tier === 'B') tierBtoManual += 1; }
      if (wasElig && nowElig) eligRetained += 1;
    }

    const plan = buildContactPlan(property, res);
    // sharpened final disposition. NOTE: `shadow_eligible_primary` means eligible
    // for SHADOW EVALUATION ONLY — it is not an operational clearance to send.
    // Production outreach requires separate approval from Ryan after outcome and
    // operational validation (production_outreach_approved_properties = 0).
    let finalDisposition;
    if (v15 === 'owner_outreach') {
      if (plan.primary_outreach_person_id) finalDisposition = 'shadow_eligible_primary'; // Tier-A primary + compliant contact
      else if (res.candidates.some((c) => c.evidence_tier === 'A' && !c.conflicted && c.suppression_state !== 'renter_suppressed' && !c.contactable)) finalDisposition = 'owner_contact_enrichment_required';
      else finalDisposition = 'manual_approval_tier_b';                                 // owner_outreach but only Tier-B evidence
    } else finalDisposition = v15;                                                      // entity/probate/conflict/resolution/reo
    if (finalDisposition === 'owner_contact_enrichment_required') enrichmentCases += 1;
    dist.final_disposition[finalDisposition] = (dist.final_disposition[finalDisposition] ?? 0) + 1;
    const routeOut = finalDisposition;

    // census row
    const best = res.candidates.find((c) => c.id === res.best_candidate_id) ?? null;
    census.push({ property_id: pid, canonical_owner_name: p.owner_name_raw ?? '',
      owner_type: res.is_estate ? 'estate' : res.is_trust ? 'trust' : res.is_company ? 'company' : 'individual',
      entity_indicator: res.is_company, trust_indicator: res.is_trust, estate_indicator: res.is_estate,
      lexical_fallback: res.entity_lexical_fallback, v1_4_route: v14, v1_5_route: v15,
      selected_person: res.best_candidate_id ?? '', candidate_relationship: best?.ownership_relationship ?? '',
      authority_evidence: best ? best.evidence.join('|') : '', missing_authority_evidence: res.missing_evidence.join('|'),
      outreach_eligibility_revoked: wasLeak, reason_code: wasLeak ? 'entity_authority_precedence' : (v14 === v15 ? 'unchanged' : 'reordered') });

    comparison.push({ property_id: pid, v1_4_route: v14, v1_5_route: v15, route_changed: v14 !== v15,
      is_entity_or_estate: res.is_entity || res.is_estate, lexical_fallback: res.entity_lexical_fallback,
      final_route: routeOut, plan_status: plan.plan_status });

    if (['shadow_eligible_primary', 'owner_contact_enrichment_required', 'manual_approval_tier_b'].includes(finalDisposition)) {
      planRows.push({ property_id: pid, owner_of_record: p.owner_name_raw ?? '', final_route: routeOut,
        primary_outreach_person_id: plan.primary_outreach_person_id ?? '', primary_evidence_tier: plan.primary_selection_evidence?.tier ?? '',
        verified_required_signers: plan.verified_required_signers.length, probable_co_owners: plan.probable_co_owners.length,
        alternate_owner_candidates: plan.alternate_owner_candidates.length, authority_unknown_parties: plan.authority_unknown_parties.length,
        simultaneous_contact_allowed: plan.simultaneous_contact_allowed, manual_approval_required: plan.manual_approval_required, plan_status: plan.plan_status });
    }

    // joint audit for properties that would have had joint parties (owner_2 / vesting / trust / multi owner-cands)
    const hadJointSignal = Boolean(p.owner_two_name) || /tenants in common|joint tenan|et al|et ux|life tenant|remainder/i.test(p.vesting_raw ?? '') || res.is_trust || res.is_estate || plan.probable_co_owners.length > 0;
    if (hadJointSignal) {
      jointRows.push({ property_id: pid, owner_of_record: p.owner_name_raw ?? '', owner_two_name: p.owner_two_name ?? '',
        vesting_raw: (p.vesting_raw ?? '').slice(0, 60), trust_or_estate: res.is_trust || res.is_estate,
        verified_required_signers: plan.verified_required_signers.length, probable_co_owners: plan.probable_co_owners.length,
        authority_unknown_parties: plan.authority_unknown_parties.length, simultaneous_contact_allowed: plan.simultaneous_contact_allowed,
        joint_evidence_class: plan.verified_required_signers.length > 0 ? 'verified_required_signer'
          : (res.is_trust || res.is_estate) ? 'authority_unknown_trust_estate'
            : p.owner_two_name ? 'probable_co_owner_owner2_name'
              : plan.probable_co_owners.length > 0 ? 'probable_co_owner_multi_candidate' : 'none' });
    }
  }

  writeCsv(join(PKG, 'SELLER_ENTITY_PRECEDENCE_FULL_CENSUS.csv'), census);
  writeCsv(join(PKG, 'SELLER_V1_4_VS_V1_5_ROUTE_COMPARISON.csv'), comparison);
  writeCsv(join(PKG, 'SELLER_V1_5_CONTACT_PLAN_COUNTS.csv'), planRows);
  writeCsv(join(PKG, 'SELLER_JOINT_PARTY_CLASSIFICATION_AUDIT.csv'), jointRows);

  const jointByClass = jointRows.reduce((m, r) => { m[r.joint_evidence_class] = (m[r.joint_evidence_class] ?? 0) + 1; return m; }, {});
  const summary = {
    scored: census.length,
    v1_4_route_distribution: dist.v14_route, v1_5_route_distribution: dist.v15_route,
    final_disposition: dist.final_disposition,
    top_transitions: Object.fromEntries(Object.entries(dist.transitions).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    phase5_2944_leak_identified: leak2944, phase5_2944_leak_rerouted: leak2944Rerouted,
    total_entity_estate_leak_rerouted: leakReconciled, entity_estate_moves: entityMoves,
    outreach_eligibility_revoked: eligRevoked, outreach_eligibility_retained: eligRetained, tier_b_to_manual: tierBtoManual,
    contact_enrichment_required: enrichmentCases,
    joint_party_by_class: jointByClass, joint_rows: jointRows.length,
    v15_entity_authority: dist.v15_route.entity_authority_resolution ?? 0,
    v15_probate: dist.v15_route.probate_counsel_first ?? 0,
  };
  STATE.stages.v15 = { at: new Date().toISOString(), ...summary };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main();
