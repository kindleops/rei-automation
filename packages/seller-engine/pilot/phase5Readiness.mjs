#!/usr/bin/env node
// Phase 5 operational-readiness pass. Read-only over the pilot DB. Produces:
//   - SELLER_PROPERTY_CONTACT_PLAN.csv  (one plan per owner_resolved property)
//   - Tier-A vs Tier-B eligibility breakdown (for the policy + approval packet)
//   - SELLER_OUTREACH_ELIGIBILITY_AUDIT_SAMPLE.csv (stratified audit)
// No scoring/routing change; sends nothing.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, PILOT_DIR } from './pg.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { ENTITY_NAME_RE } from '../scores/ownerResolution.mjs';
import { propertyOutreachSummary, outreachEligibility } from '../scores/outreachEligibility.mjs';
import { buildContactPlan } from '../scores/contactPlan.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
const jrows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => JSON.parse(l));

function loadProps() {
  return new Map(jrows(`select row_to_json(t) from (
    select p.id property_id, p.asset_class, p.situs_state,
      o.owner_name_raw, o.mailing_state, o.occupancy_raw,
      nullif(btrim(p.raw->'raw_keep'->>'owner_2_name'), '') owner_two_name,
      p.raw->'raw_keep'->>'Owner1OwnershipRights' vesting_raw,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id
             where oo.property_id=p.id and c.classification in ('corporate','trust','estate')) cls_entity,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id
             where oo.property_id=p.id and c.classification='trust') cls_trust,
      exists(select 1 from seller_engine.property_liens l where l.property_id=p.id and l.lifecycle_class='probate_life_event') probate,
      exists(select 1 from seller_engine.property_foreclosure_events f where f.property_id=p.id and f.stage='reo') reo,
      v.equity_percent
    from seller_engine.properties p
    left join seller_engine.property_ownerships o on o.property_id=p.id
    left join seller_engine.property_valuation_tax_snapshots v on v.property_id=p.id) t`).map((r) => [r.property_id, r]));
}
function loadLinks() {
  const m = new Map();
  for (const l of jrows(`select row_to_json(t) from (
    select l.property_id, l.person_id, pe.identity_tier, pe.full_name person_name,
      l.renter_flag, l.link_tier, l.is_matching_property_as_owner,
      (l.raw->'matching_flags') matching_flags, coalesce(ph.cnt,0) phones, coalesce(em.cnt,0) emails
    from seller_engine.property_person_links l
    join seller_engine.people pe on pe.id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_phones
               where phone_e164 is not null and coalesce(do_not_call,false)=false and coalesce(never_call,false)=false group by person_id) ph on ph.person_id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_emails where coalesce(blocked,false)=false group by person_id) em on em.person_id=l.person_id) t`)) {
    (m.get(l.property_id) ?? m.set(l.property_id, []).get(l.property_id)).push(l);
  }
  return m;
}
function loadPressure() {
  const m = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select fs.property_id,
      sum(case when ss.family = any(array['seller_propensity','financial_pressure','legal_title_pressure','foreclosure_urgency','property_distress','physical_obsolescence','landlord_fatigue','portfolio_liquidation']) then coalesce(ss.score,0) else 0 end) motivation
    from seller_engine.seller_score_snapshots ss join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id
    group by fs.property_id) t`)) m.set(r.property_id, Number(r.motivation) || 0);
  return m;
}
const nameMatch = (owner, name) => {
  const toks = (s) => String(s ?? '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  const a = new Set(toks(owner)); const b = toks(name);
  const shared = b.filter((t) => a.has(t)); return { name_match: shared.length >= 2, surname_match: shared.length === 1 };
};
function candFor(links, p) {
  return (links ?? []).map((l) => {
    const tokens = Array.isArray(l.matching_flags) ? l.matching_flags : [];
    const ns = nameMatch(p.owner_name_raw, l.person_name);
    return { id: l.person_id, person_name: l.person_name, identity_tier: l.identity_tier,
      link_tier: l.link_tier ?? 'none', renter_flag: l.renter_flag === true,
      owner_token: tokens.some((t) => /likely owner|potential owner/i.test(String(t))),
      owner_verdict: l.is_matching_property_as_owner === true, name_match: ns.name_match, surname_match: ns.surname_match,
      exact_key_owner: l.is_matching_property_as_owner === true && l.identity_tier === 'key' && ns.name_match,
      mailing_match: p.mailing_state && p.situs_state ? p.mailing_state === p.situs_state : false,
      phones: Number(l.phones) || 0, emails: Number(l.emails) || 0 };
  });
}

// which eligibility rule qualified a candidate (Tier A rule or Tier-B subset)
function eligibilityRule(c) {
  if (c.evidence_tier !== 'A' && c.evidence_tier !== 'B') return 'not_eligible';
  if (c.evidence_tier === 'A') {
    if (c.evidence.includes('exact_individual_key_owner')) return 'A_exact_individual_key';
    if (c.evidence.includes('owner_hash_corroborated_name')) return 'A_owner_hash_corroborated';
    if (c.evidence.includes('deed_grantee_identity')) return 'A_deed_grantee';
    if (c.evidence.some((e) => e.startsWith('verified_'))) return 'A_verified_authority';
    return 'A_other';
  }
  // Tier B approved subset
  const tokenVerdict = c.evidence.includes('owner_token') && c.evidence.includes('owner_match_verdict');
  const nameMailing = c.evidence.includes('owner_name_match') && c.evidence.includes('mailing_address_match');
  if (tokenVerdict) return 'B_token_plus_verdict';
  if (nameMailing) return 'B_name_plus_mailing';
  return 'B_not_approved';
}

function main() {
  const props = loadProps();
  const links = loadLinks();
  const pressure = loadPressure();

  const planRows = [];
  const tierBreakdown = {};          // rule -> eligible person count
  const eligiblePropertyPeople = []; // per (property, eligible person) for audit
  const eligiblePeoplePerProperty = {}; // property -> eligible count (for 1/2/3+ distribution)
  let entityNameLeak = 0;            // owner_resolved properties whose owner name reads as an entity/trust/estate

  for (const [pid, p] of props) {
    const cands = candFor(links.get(pid), p);
    const property = { property_id: pid, owner_name: p.owner_name_raw, owner_mailing_state: p.mailing_state,
      situs_state: p.situs_state, is_entity: (p.company_links ?? 0) > 0 || p.cls_entity === true,
      probate_evidence: p.probate === true, reo: p.reo === true,
      owner_two_name: p.owner_two_name, vesting_raw: p.vesting_raw, is_trust: p.cls_trust === true };
    const res = resolveCanonical(property, cands);
    if (res.execution_route !== 'owner_outreach') continue; // contact plans only for owner_resolved

    const sum = propertyOutreachSummary(res);
    const eligibleCands = res.candidates.filter((c) => sum.outreach_eligible_ids.includes(c.id));
    const plan = buildContactPlan(property, res);
    eligiblePeoplePerProperty[pid] = eligibleCands.length;
    if (ENTITY_NAME_RE.test(p.owner_name_raw ?? '')) entityNameLeak += 1;

    for (const c of eligibleCands) {
      const rule = eligibilityRule(c);
      tierBreakdown[rule] = (tierBreakdown[rule] ?? 0) + 1;
      eligiblePropertyPeople.push({ pid, p, c, rule, is_primary: c.id === plan.primary_outreach_person_id, priority: pressure.get(pid) ?? 0 });
    }

    planRows.push({
      property_id: pid, asset_class: p.asset_class, situs_state: p.situs_state, owner_of_record: p.owner_name_raw ?? '',
      primary_outreach_person_id: plan.primary_outreach_person_id ?? '',
      alternate_outreach_person_ids: plan.alternate_outreach_person_ids.join('|'),
      alternate_count: plan.alternate_outreach_person_ids.length,
      required_joint_decision_makers: plan.required_joint_decision_makers.join('|'),
      joint_authority_reasons: plan.joint_authority_reasons.join(';'),
      unlinked_co_owner_present: plan.unlinked_co_owner_present,
      primary_evidence_tier: plan.primary_selection_evidence?.tier ?? '',
      primary_confidence: plan.primary_selection_evidence?.confidence ?? '',
      ownership_relationship: plan.ownership_relationship ?? '', authority_relationship: plan.authority_relationship ?? '',
      primary_phone_available: plan.primary_phone_available, primary_email_available: plan.primary_email_available,
      contact_method_compliance: plan.contact_method_compliance,
      contact_sequence: plan.contact_sequence.join('>'),
      simultaneous_contact_allowed: plan.simultaneous_contact_allowed,
      eligible_people: eligibleCands.length, plan_status: plan.plan_status,
    });
  }

  writeCsv(join(PKG, 'SELLER_PROPERTY_CONTACT_PLAN.csv'), planRows);

  // eligible-people-per-property distribution
  const perPropCounts = Object.values(eligiblePeoplePerProperty);
  const bucket = { one: 0, two: 0, three: 0, four_plus: 0 };
  for (const n of perPropCounts) { if (n === 1) bucket.one += 1; else if (n === 2) bucket.two += 1; else if (n === 3) bucket.three += 1; else if (n >= 4) bucket.four_plus += 1; }

  // stratified audit sample
  const auditRows = buildAudit(eligiblePropertyPeople);
  writeCsv(join(PKG, 'SELLER_OUTREACH_ELIGIBILITY_AUDIT_SAMPLE.csv'), auditRows);

  const tierA = Object.entries(tierBreakdown).filter(([k]) => k.startsWith('A_')).reduce((s, [, v]) => s + v, 0);
  const tierB = Object.entries(tierBreakdown).filter(([k]) => k.startsWith('B_')).reduce((s, [, v]) => s + v, 0);
  const uncategorized = Object.entries(tierBreakdown).filter(([k]) => !k.startsWith('A_') && !k.startsWith('B_')).reduce((s, [, v]) => s + v, 0);

  const summary = {
    owner_resolved_properties: planRows.length,
    total_eligible_people: eligiblePropertyPeople.length,
    eligible_people_per_property: bucket,
    tier_breakdown: tierBreakdown,
    tier_A_total: tierA, tier_B_total: tierB, uncategorized_eligible: uncategorized,
    audit_sample_rows: auditRows.length,
    contact_plans_single_primary: planRows.filter((r) => r.plan_status === 'single_primary').length,
    contact_plans_with_joint: planRows.filter((r) => r.plan_status === 'primary_plus_required_joint').length,
    contact_plans_no_eligible_primary: planRows.filter((r) => r.plan_status === 'no_eligible_primary').length,
    entity_name_owner_routed_to_outreach: entityNameLeak,
    audit_dispositions: auditRows.reduce((m, r) => { m[r.audit_disposition] = (m[r.audit_disposition] ?? 0) + 1; return m; }, {}),
  };
  STATE.stages.phase5_readiness = { at: new Date().toISOString(), ...summary };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function buildAudit(elig) {
  // deterministic stratified sample: up to N per stratum by stable id ordering
  const byId = (a, b) => (String(a.c.id) < String(b.c.id) ? -1 : 1);
  const perPid = {};
  for (const e of elig) perPid[e.pid] = (perPid[e.pid] ?? 0) + 1;
  const multiPids = new Set(Object.entries(perPid).filter(([, n]) => n >= 2).map(([k]) => k));
  const strata = {
    tierA_exact_key: elig.filter((e) => e.rule === 'A_exact_individual_key'),
    tierA_owner_hash: elig.filter((e) => e.rule === 'A_owner_hash_corroborated'),
    tierA_deed_or_authority: elig.filter((e) => ['A_deed_grantee', 'A_verified_authority'].includes(e.rule)),
    tierB_token_verdict: elig.filter((e) => e.rule === 'B_token_plus_verdict'),
    tierB_name_mailing: elig.filter((e) => e.rule === 'B_name_plus_mailing'),
    multi_eligible: elig.filter((e) => multiPids.has(e.pid)),
    absentee_owner: elig.filter((e) => /absentee/i.test(e.p.occupancy_raw ?? '')),
    corp_name_as_individual: elig.filter((e) => /\b(LLC|INC|CORP|TRUST|ESTATE|COMPANY|PROPERTIES|HOLDINGS)\b/i.test(e.p.owner_name_raw ?? '') && (e.p.company_links ?? 0) === 0 && e.p.cls_entity !== true),
    high_priority: [...elig].sort((a, b) => b.priority - a.priority).slice(0, 100),
    low_confidence_boundary: elig.filter((e) => e.c.evidence_tier === 'B'),
  };
  const rows = [];
  const seen = new Set();
  for (const [stratum, list] of Object.entries(strata)) {
    for (const e of [...list].sort(byId).slice(0, 100)) {
      const key = `${stratum}:${e.pid}:${e.c.id}`;
      if (seen.has(key)) continue; seen.add(key);
      rows.push(auditRow(stratum, e));
    }
  }
  return rows;
}
function auditRow(stratum, e) {
  const c = e.c; const p = e.p;
  // an owner-of-record name that reads as a trust/estate/company but was routed
  // to owner_outreach means an INDIVIDUAL name-match won precedence over the
  // entity/authority check — the matched person is not a verified trustee/
  // officer, so this belongs in entity/authority resolution, not auto-outreach.
  const entityName = ENTITY_NAME_RE.test(p.owner_name_raw ?? '');
  const disposition = entityName ? 'entity_authority_required'
    : c.evidence_tier === 'A' ? (e.is_primary ? 'safe_with_one_primary' : 'safe_automatic_outreach')
      : c.evidence_tier === 'B' ? 'safe_with_one_primary'
        : 'manual_approval_required';
  return {
    stratum, property_id: e.pid, owner_of_record: p.owner_name_raw ?? '', selected_person: c.id,
    is_primary: e.is_primary, evidence_tier: c.evidence_tier, eligibility_rule: e.rule,
    evidence_sources: c.evidence.join('|'), contradictory_evidence: c.contradictory_evidence.join('|'),
    person_status: c.person_status, phones: c.phones, emails: c.emails,
    compliance_state: (c.phones + c.emails) > 0 ? 'compliant_contact_present' : 'no_compliant_contact',
    entity_name_of_record: entityName,
    audit_disposition: disposition,
  };
}
const csvq = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
function writeCsv(path, rows) {
  if (!rows.length) { writeFileSync(path, '(empty)\n'); return; }
  const cols = Object.keys(rows[0]);
  writeFileSync(path, [cols.join(',')].concat(rows.map((r) => cols.map((cc) => csvq(r[cc])).join(','))).join('\n') + '\n');
}

main();
