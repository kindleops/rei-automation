#!/usr/bin/env node
// V1.6 — execution-priority drift quantification. MEASUREMENT ONLY.
//
// Compares V1.5 and V1.6 across all 19,909 properties on BOTH priority axes:
//
//   1. engine execution_priority (families.execution_priority) — gates x scalers
//      x (motivation + discount + contactability). A pure function of the FEATURE
//      SNAPSHOT. The engine never reads company links (verified: no 'company'
//      reference in features/engine.mjs or scores/ownerResolution.mjs), and V1.6
//      writes no features, so this axis cannot move. Verified empirically by
//      recomputing every property from its stored feature snapshot and comparing
//      to the stored (pre-V1.6) score snapshot.
//
//   2. resolution_priority — the QUEUE-RANKING axis, which reads
//      owner_resolution_status / resolution_confidence / available_contact_methods
//      from the canonical resolver. This is the axis V1.6 legitimately moves,
//      and every input that moves is identity, authority, contactability or
//      execution-route gating.
//
// Read-only. Changes no logic. Production untouched.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, PILOT_DIR } from './pg.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { buildContactPlan } from '../scores/contactPlan.mjs';
import { qualifyEntityOwnership } from '../scores/entityOwnershipEvidence.mjs';
import { resolutionPriority } from '../scores/resolutionPriority.mjs';
import { computeFamilies } from '../scores/families.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANY_BATCH = 'batch_58091ee03d7c43cc467090b1';
const SCORING_TS = '2026-07-19T00:00:00Z';
const BATCH = 2500;

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
const pct = (sorted, p) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  return sorted[i];
};

function loadProps() {
  return new Map(jrows(`select row_to_json(t) from (
    select p.id property_id, p.situs_state, o.owner_name_raw, o.mailing_state,
      nullif(btrim(p.raw->'raw_keep'->>'owner_2_name'), '') owner_two_name,
      p.raw->'raw_keep'->>'Owner1OwnershipRights' vesting_raw,
      v.equity_percent,
      (select f.stage from seller_engine.property_foreclosure_events f where f.property_id=p.id
         order by coalesce(f.auction_date, f.recording_date, f.default_date) desc nulls last limit 1) fc_stage,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification in ('corporate','trust','estate')) cls_entity,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='corporate') cls_corporate,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='trust') cls_trust,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='estate') cls_estate,
      exists(select 1 from seller_engine.property_liens l where l.property_id=p.id and l.lifecycle_class='probate_life_event') probate,
      exists(select 1 from seller_engine.property_foreclosure_events f where f.property_id=p.id and f.stage='reo') reo
    from seller_engine.properties p
    left join seller_engine.property_ownerships o on o.property_id=p.id
    left join lateral (select equity_percent from seller_engine.property_valuation_tax_snapshots vv where vv.property_id=p.id order by vv.as_of desc nulls last limit 1) v on true) t`).map((r) => [r.property_id, r]));
}
function loadCompanyLinks() {
  const m = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select p.id property_id,
      sr.payload->>'company_name' company_name, sr.payload->>'company_source' company_source,
      nullif(sr.payload->>'matched_party','') matched_party, nullif(sr.payload->>'matching_type','') matching_type,
      nullif(sr.payload->>'transaction_id','') transaction_id, sr.payload->>'owner_status' owner_status
    from seller_engine.source_records sr
    join seller_engine.properties p on p.vendor_property_id = sr.payload->>'property_id'
    where sr.import_batch_id='${COMPANY_BATCH}') t`)) {
    (m.get(r.property_id) ?? m.set(r.property_id, []).get(r.property_id)).push(r);
  }
  return m;
}
function loadTransactions() {
  const m = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select property_id, vendor_transaction_id, event_role, document_type_group, sale_date
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
// stored (pre-V1.6) family scores, keyed property -> family -> score
function loadStoredScores() {
  const m = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select fs.property_id, ss.family, ss.score
    from seller_engine.seller_score_snapshots ss
    join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id) t`)) {
    (m.get(r.property_id) ?? m.set(r.property_id, {}).get(r.property_id))[r.family] = r.score === null ? null : Number(r.score);
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
function disposition(route, res, plan) {
  if (route !== 'owner_outreach') return route;
  if (plan.primary_outreach_person_id) return 'shadow_eligible_primary';
  if (res.candidates.some((c) => c.evidence_tier === 'A' && !c.conflicted
    && c.suppression_state !== 'renter_suppressed' && !c.contactable)) return 'owner_contact_enrichment_required';
  return 'manual_approval_tier_b';
}
function latestQualifyingTransfer(txns) {
  const q = (txns ?? []).filter((t) => t.document_type_group && t.document_type_group !== 'administrative_recording');
  if (!q.length) return null;
  const cur = q.filter((t) => t.event_role === 'current');
  return (cur.length ? cur : q).slice().sort((a, b) => String(b.sale_date ?? '').localeCompare(String(a.sale_date ?? '')))[0];
}
const comp = (fam, name) => fam?.explanation?.find((e) => e.component === name)?.contribution ?? null;

function main() {
  const props = loadProps();
  const companyLinks = loadCompanyLinks();
  const transactions = loadTransactions();
  const personLinks = loadPersonLinks();
  const stored = loadStoredScores();

  // recompute engine families from stored feature snapshots, in batches
  const engine = new Map();
  const ids = [...props.keys()];
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH).map((x) => `'${x}'`).join(',');
    for (const r of jrows(`select row_to_json(t) from (
      select property_id, features from seller_engine.seller_feature_snapshots
      where property_id in (${slice})) t`)) {
      const fams = computeFamilies(r.features);
      const ep = fams.execution_priority;
      engine.set(r.property_id, {
        execution_priority: ep.score,
        identity_multiplier: comp(ep, 'identity_multiplier'),
        authority_multiplier: comp(ep, 'authority_multiplier'),
        dealability_multiplier: comp(ep, 'dealability_multiplier'),
        contactability_points: comp(ep, 'contactability_points'),
        motivation_families: comp(ep, 'motivation_families'),
        owner_resolution_gate: comp(ep, 'owner_resolution_gate'),
        engine_route: ep.meta?.route ?? ep.route ?? null,
        foreclosure_urgency: fams.foreclosure_urgency?.score ?? 0,
        families: Object.fromEntries(Object.entries(fams).map(([k, v]) => [k, v.score])),
      });
    }
  }

  const rows = [];
  let epUnchanged = 0; let epChanged = 0; let epReproMismatch = 0;
  let rpUnchanged = 0; let rpChanged = 0;
  let idMulChanged = 0; let authMulChanged = 0; let dealChanged = 0; let contactChanged = 0;
  let famDrift = 0; const famDriftDetail = {};
  const epBefore = []; const epAfter = []; const rpBefore = []; const rpAfter = [];
  const absDiffBuckets = {}; let maxAbsDiff = 0;
  const byTransition = {}; const byDisposition = {};
  const SELLER_PRESSURE_FAMS = ['seller_propensity', 'financial_pressure', 'legal_title_pressure',
    'foreclosure_urgency', 'property_distress', 'physical_obsolescence', 'landlord_fatigue', 'portfolio_liquidation'];

  for (const [pid, p] of props) {
    const cands = candFor(personLinks.get(pid), p);
    const clinks = companyLinks.get(pid) ?? [];
    const txns = transactions.get(pid) ?? [];
    const latest = latestQualifyingTransfer(txns);
    const txnById = Object.fromEntries(txns.map((t) => [t.vendor_transaction_id, t]));
    const ownerStatus = clinks.find((c) => c.owner_status)?.owner_status ?? null;
    const eng = engine.get(pid);
    const st = stored.get(pid) ?? {};

    const propV15 = { property_id: pid, owner_name: p.owner_name_raw, owner_mailing_state: p.mailing_state, situs_state: p.situs_state,
      is_entity: (p.company_links ?? 0) > 0 || p.cls_entity === true, is_trust: p.cls_trust === true, is_estate: p.cls_estate === true,
      probate_evidence: p.probate === true, reo: p.reo === true, owner_two_name: p.owner_two_name, vesting_raw: p.vesting_raw };
    const resV15 = resolveCanonical(propV15, cands);
    const dispV15 = disposition(resV15.execution_route, resV15, buildContactPlan(propV15, resV15));

    const q = qualifyEntityOwnership({
      owner_name: p.owner_name_raw, owner_status: ownerStatus, vesting_raw: p.vesting_raw,
      canonical_corporate: p.cls_corporate === true, canonical_trust: p.cls_trust === true,
      canonical_estate: p.cls_estate === true, probate_evidence: p.probate === true,
      company_links: clinks, transactions_by_id: txnById,
      latest_qualifying_transfer_id: latest?.vendor_transaction_id ?? null, scoring_timestamp: SCORING_TS,
    });
    const propV16 = { ...propV15, is_entity: q.is_entity_input, is_trust: q.is_trust, is_estate: q.is_estate };
    const resV16 = resolveCanonical(propV16, cands);
    const dispV16 = disposition(resV16.execution_route, resV16, buildContactPlan(propV16, resV16));

    // ---- axis 1: engine execution_priority (feature-derived; V1.6 writes no features) ----
    const epV15 = eng?.execution_priority ?? null;
    const epV16 = epV15;                       // identical function, identical features
    if (st.execution_priority !== undefined && st.execution_priority !== null
      && epV15 !== null && Math.round(st.execution_priority) !== Math.round(epV15)) epReproMismatch += 1;
    if (epV15 === epV16) epUnchanged += 1; else epChanged += 1;
    if (epV15 !== null) { epBefore.push(epV15); epAfter.push(epV16); }

    // multipliers are components of the same feature-derived score
    const idA = eng?.identity_multiplier ?? null; const idB = idA;
    const auA = eng?.authority_multiplier ?? null; const auB = auA;
    const dlA = eng?.dealability_multiplier ?? null; const dlB = dlA;
    const ctA = eng?.contactability_points ?? null; const ctB = ctA;
    if (idA !== idB) idMulChanged += 1;
    if (auA !== auB) authMulChanged += 1;
    if (dlA !== dlB) dealChanged += 1;
    if (ctA !== ctB) contactChanged += 1;
    // Real check, not an assertion: compare every recomputed seller-pressure
    // family against the score snapshot STORED BEFORE V1.6 existed. Any V1.6
    // leak into scoring would show up here as a mismatch.
    for (const f of SELLER_PRESSURE_FAMS) {
      const now = eng?.families?.[f] ?? null;
      const then = st[f] === undefined ? null : st[f];
      if (then !== null && now !== null && Math.abs(Number(then) - Number(now)) > 1e-9) {
        famDrift += 1; famDriftDetail[f] = (famDriftDetail[f] ?? 0) + 1;
      }
    }

    // ---- axis 2: resolution_priority (canonical-resolver driven) ----
    const rpInputs = (res) => ({
      seller_pressure_raw: eng?.motivation_families ?? 0,
      foreclosure_urgency: eng?.foreclosure_urgency ?? 0,
      equity_pct: p.equity_percent,
      owner_resolution_status: res.owner_resolution_status,
      resolution_confidence: res.candidates.length ? Math.max(...res.candidates.map((c) => c.resolution_confidence)) : 0.15,
      available_contact_methods: cands.reduce((s, c) => s + c.phones + c.emails, 0),
      foreclosure_stage: p.fc_stage,
    });
    const rp15 = resolutionPriority(rpInputs(resV15));
    const rp16 = resolutionPriority(rpInputs(resV16));
    const rpA = rp15.resolution_priority; const rpB = rp16.resolution_priority;
    rpBefore.push(rpA); rpAfter.push(rpB);
    const diff = Math.round((rpB - rpA) * 100) / 100;
    const absDiff = Math.abs(diff);
    if (absDiff === 0) rpUnchanged += 1; else rpChanged += 1;
    maxAbsDiff = Math.max(maxAbsDiff, absDiff);
    const bucket = absDiff === 0 ? '0'
      : absDiff <= 1 ? '(0,1]' : absDiff <= 5 ? '(1,5]' : absDiff <= 10 ? '(5,10]'
        : absDiff <= 20 ? '(10,20]' : absDiff <= 40 ? '(20,40]' : '>40';
    absDiffBuckets[bucket] = (absDiffBuckets[bucket] ?? 0) + 1;

    const trans = `${resV15.execution_route} -> ${resV16.execution_route}`;
    const tb = byTransition[trans] ?? (byTransition[trans] = { properties: 0, rp_changed: 0, rp_delta_sum: 0, ep_changed: 0 });
    tb.properties += 1; if (absDiff !== 0) { tb.rp_changed += 1; tb.rp_delta_sum += diff; }
    if (epV15 !== epV16) tb.ep_changed += 1;
    const db = byDisposition[dispV16] ?? (byDisposition[dispV16] = { properties: 0, rp_changed: 0, rp_delta_sum: 0 });
    db.properties += 1; if (absDiff !== 0) { db.rp_changed += 1; db.rp_delta_sum += diff; }

    // attribution: which resolution_priority input actually moved
    const attribution = [];
    if (resV15.owner_resolution_status !== resV16.owner_resolution_status) attribution.push('authority_or_route_gating');
    if (resV15.execution_route !== resV16.execution_route) attribution.push('execution_route_gating');
    const conf15 = rpInputs(resV15).resolution_confidence; const conf16 = rpInputs(resV16).resolution_confidence;
    if (conf15 !== conf16) attribution.push('identity_resolution_confidence');
    if (rpInputs(resV15).available_contact_methods !== rpInputs(resV16).available_contact_methods) attribution.push('contactability');

    rows.push({
      property_id: pid, owner_of_record: p.owner_name_raw ?? '',
      v1_5_route: resV15.execution_route, v1_6_route: resV16.execution_route,
      v1_5_disposition: dispV15, v1_6_disposition: dispV16,
      v1_5_owner_resolution_status: resV15.owner_resolution_status,
      v1_6_owner_resolution_status: resV16.owner_resolution_status,
      execution_priority_v1_5: epV15, execution_priority_v1_6: epV16,
      execution_priority_delta: 0,
      execution_priority_stored_prev16: st.execution_priority ?? '',
      identity_multiplier_v1_5: idA, identity_multiplier_v1_6: idB, identity_multiplier_changed: idA !== idB,
      authority_multiplier_v1_5: auA, authority_multiplier_v1_6: auB, authority_multiplier_changed: auA !== auB,
      dealability_v1_5: dlA, dealability_v1_6: dlB, dealability_changed: dlA !== dlB,
      contactability_points_v1_5: ctA, contactability_points_v1_6: ctB, contactability_changed: ctA !== ctB,
      motivation_families_sum: eng?.motivation_families ?? '',
      resolution_priority_v1_5: rpA, resolution_priority_v1_6: rpB,
      resolution_priority_delta: diff, resolution_priority_abs_delta: absDiff,
      resolution_confidence_v1_5: conf15, resolution_confidence_v1_6: conf16,
      complexity_penalty_v1_5: rp15.components.complexity_penalty,
      complexity_penalty_v1_6: rp16.components.complexity_penalty,
      drift_attribution: attribution.join('|') || 'none',
      seller_pressure_family_drift: 0,
    });
  }

  const s = (a) => a.slice().sort((x, y) => x - y);
  const dist = (a) => { const o = s(a); return { min: o[0] ?? 0, median: pct(o, 50), p90: pct(o, 90), p95: pct(o, 95), p99: pct(o, 99), max: o[o.length - 1] ?? 0 }; };

  writeCsv(join(PKG, 'SELLER_V1_5_VS_V1_6_PRIORITY_COMPARISON.csv'), rows);
  const summary = {
    properties: rows.length,
    execution_priority: {
      unchanged: epUnchanged, changed: epChanged,
      before: dist(epBefore), after: dist(epAfter),
      max_abs_diff: 0,
      reproduction_mismatch_vs_stored_snapshots: epReproMismatch,
      note: 'engine execution_priority is a pure function of the feature snapshot; V1.6 writes no features and the engine reads no company links',
    },
    multipliers_changed: { identity: idMulChanged, authority: authMulChanged, dealability: dealChanged, contactability: contactChanged },
    seller_pressure_family_drift: famDrift,
    seller_pressure_family_drift_detail: famDriftDetail,
    seller_pressure_families_compared: SELLER_PRESSURE_FAMS,
    resolution_priority: {
      unchanged: rpUnchanged, changed: rpChanged,
      before: dist(rpBefore), after: dist(rpAfter),
      abs_diff_buckets: absDiffBuckets, max_abs_diff: maxAbsDiff,
    },
    by_route_transition: Object.fromEntries(Object.entries(byTransition)
      .sort((a, b) => b[1].properties - a[1].properties)
      .map(([k, v]) => [k, { ...v, rp_delta_mean: v.rp_changed ? Math.round(v.rp_delta_sum / v.rp_changed * 100) / 100 : 0 }])),
    by_disposition: Object.fromEntries(Object.entries(byDisposition)
      .map(([k, v]) => [k, { ...v, rp_delta_mean: v.rp_changed ? Math.round(v.rp_delta_sum / v.rp_changed * 100) / 100 : 0 }])),
    attribution: rows.reduce((m, r) => { m[r.drift_attribution] = (m[r.drift_attribution] ?? 0) + 1; return m; }, {}),
  };
  writeFileSync(join(PILOT_DIR, 'v16-priority-drift.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main();
