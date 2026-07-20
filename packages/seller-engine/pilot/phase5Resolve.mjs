#!/usr/bin/env node
// Phase 5 full-pilot canonical resolution + reroute. Runs the canonical owner &
// authority resolver over all 19,909 properties, computes fail-closed outreach
// eligibility per contact and resolution_priority per property, and emits the
// three resolution queues + distributions. Read-only over the pilot DB; sends
// nothing. Seller-pressure scores are read, never altered.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, num, PILOT_DIR } from './pg.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { propertyOutreachSummary, outreachEligibility } from '../scores/outreachEligibility.mjs';
import { resolutionPriority } from '../scores/resolutionPriority.mjs';
import { readFileSync } from 'node:fs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
const jrows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const MOT = ['seller_propensity', 'financial_pressure', 'legal_title_pressure', 'foreclosure_urgency',
  'property_distress', 'physical_obsolescence', 'landlord_fatigue', 'portfolio_liquidation'];

function loadProperties() {
  // one row per property: owner-of-record + entity/probate/reo/listing evidence
  return new Map(jrows(`select row_to_json(t) from (
    select p.id property_id, p.asset_class, p.situs_state,
      o.owner_name_raw, o.owner_hash, o.mailing_state,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id
             where oo.property_id=p.id and c.classification in ('corporate','trust','estate')) cls_entity,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id
             where oo.property_id=p.id and c.classification='estate') cls_estate,
      exists(select 1 from seller_engine.property_liens l where l.property_id=p.id and l.lifecycle_class='probate_life_event') probate,
      exists(select 1 from seller_engine.property_foreclosure_events f where f.property_id=p.id and f.stage='reo') reo,
      (select f.stage from seller_engine.property_foreclosure_events f where f.property_id=p.id and f.stage is not null order by f.stage desc limit 1) fc_stage,
      v.equity_percent, v.estimated_equity
    from seller_engine.properties p
    left join seller_engine.property_ownerships o on o.property_id=p.id
    left join seller_engine.property_valuation_tax_snapshots v on v.property_id=p.id) t`).map((r) => [r.property_id, r]));
}

function loadLinks() {
  // per person link + contact-method counts
  const m = new Map();
  // pre-aggregate contact counts once (hash aggregate) then hash-join to links —
  // avoids per-row correlated subqueries (no index on person_id in the pilot DB)
  for (const l of jrows(`select row_to_json(t) from (
    select l.property_id, l.person_id, pe.identity_tier, pe.full_name person_name,
      l.renter_flag, l.link_tier, l.is_matching_property_as_owner,
      (l.raw->'matching_flags') matching_flags,
      coalesce(ph.cnt, 0) phones, coalesce(em.cnt, 0) emails
    from seller_engine.property_person_links l
    join seller_engine.people pe on pe.id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_phones
               where phone_e164 is not null and coalesce(do_not_call,false)=false and coalesce(never_call,false)=false
               group by person_id) ph on ph.person_id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_emails
               where coalesce(blocked,false)=false group by person_id) em on em.person_id=l.person_id) t`)) {
    (m.get(l.property_id) ?? m.set(l.property_id, []).get(l.property_id)).push(l);
  }
  return m;
}

function loadPressure() {
  // motivation sum + foreclosure urgency per property (V1.2==V1.4, drift 0)
  const m = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select fs.property_id,
      sum(case when ss.family = any(array['seller_propensity','financial_pressure','legal_title_pressure','foreclosure_urgency','property_distress','physical_obsolescence','landlord_fatigue','portfolio_liquidation']) then coalesce(ss.score,0) else 0 end) motivation,
      max(case when ss.family='foreclosure_urgency' then coalesce(ss.score,0) else 0 end) foreclosure_urgency
    from seller_engine.seller_score_snapshots ss
    join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id
    group by fs.property_id) t`)) m.set(r.property_id, r);
  return m;
}

function candidatesFor(links) {
  return (links ?? []).map((l) => {
    const tokens = Array.isArray(l.matching_flags) ? l.matching_flags : [];
    return {
      id: l.person_id, person_name: l.person_name, identity_tier: l.identity_tier,
      link_tier: l.link_tier ?? 'none', renter_flag: l.renter_flag === true,
      owner_token: tokens.some((t) => /likely owner|potential owner/i.test(String(t))),
      owner_verdict: l.is_matching_property_as_owner === true,
      exact_key_owner: l.is_matching_property_as_owner === true && l.identity_tier === 'key',
      phones: Number(l.phones) || 0, emails: Number(l.emails) || 0,
    };
  });
}

function main() {
  const props = loadProperties();
  const links = loadLinks();
  const pressure = loadPressure();

  const results = [];
  const ownerResQueue = [];
  const conflictQueue = [];
  const entityQueue = [];
  const dist = { owner_resolution_status: {}, execution_route: {}, best_tier: {} };
  let outreachEligiblePeople = 0; let suppressedPeople = 0; let manualApprovalPeople = 0;
  let noReachableOwner = 0; let confirmedOwners = 0; let probableOwners = 0;

  for (const [pid, p] of props) {
    const isEntity = (p.company_links ?? 0) > 0 || p.cls_entity === true;
    const cands = candidatesFor(links.get(pid));
    for (const c of cands) { c.exact_key_owner = c.exact_key_owner && (require_nameMatch(p.owner_name_raw, c.person_name)); }
    const property = {
      owner_name: p.owner_name_raw, owner_hash: p.owner_hash, owner_mailing_state: p.mailing_state,
      situs_state: p.situs_state, is_entity: isEntity, probate_evidence: p.probate === true || p.cls_estate === true,
      active_listing: false, reo: p.reo === true,
    };
    const res = resolveCanonical(property, cands);
    const outreach = propertyOutreachSummary(res);
    const prs = pressure.get(pid) ?? { motivation: 0, foreclosure_urgency: 0 };
    const rp = resolutionPriority({
      seller_pressure_raw: Number(prs.motivation) || 0, foreclosure_urgency: Number(prs.foreclosure_urgency) || 0,
      equity_pct: p.equity_percent, owner_resolution_status: res.owner_resolution_status,
      resolution_confidence: res.candidates.length ? Math.max(...res.candidates.map((c) => c.resolution_confidence)) : 0.15,
      available_contact_methods: cands.reduce((s, c) => s + c.phones + c.emails, 0),
      foreclosure_stage: p.fc_stage,
    });

    dist.owner_resolution_status[res.owner_resolution_status] = (dist.owner_resolution_status[res.owner_resolution_status] ?? 0) + 1;
    dist.execution_route[res.execution_route] = (dist.execution_route[res.execution_route] ?? 0) + 1;
    dist.best_tier[res.best_evidence_tier ?? 'none'] = (dist.best_tier[res.best_evidence_tier ?? 'none'] ?? 0) + 1;
    outreachEligiblePeople += outreach.outreach_eligible_ids.length;
    manualApprovalPeople += outreach.manual_approval_ids.length;
    suppressedPeople += res.suppressed_candidate_ids.length;
    if (res.owner_resolution_status === 'no_reachable_owner_contact') noReachableOwner += 1;
    confirmedOwners += res.candidates.filter((c) => c.person_status === 'owner_confirmed').length;
    probableOwners += res.candidates.filter((c) => c.person_status === 'owner_candidate').length;

    const row = {
      property_id: pid, asset_class: p.asset_class, situs_state: p.situs_state,
      owner_of_record: p.owner_name_raw ?? '', ownership_type: isEntity ? 'entity' : 'individual',
      owner_resolution_status: res.owner_resolution_status, execution_route: res.execution_route,
      best_candidate_id: res.best_candidate_id ?? '', best_evidence_tier: res.best_evidence_tier ?? '',
      candidates: res.candidates.length, outreach_eligible: outreach.outreach_eligible_ids.length,
      manual_approval: outreach.manual_approval_ids.length, suppressed: res.suppressed_candidate_ids.length,
      conflicts: res.conflict_candidate_ids.length,
      missing_evidence: res.missing_evidence.join('; '),
      available_contact_methods: cands.reduce((s, c) => s + c.phones + c.emails, 0),
      seller_priority_raw: Number(prs.motivation) || 0,
      foreclosure_urgency: Number(prs.foreclosure_urgency) || 0,
      resolution_priority: rp.resolution_priority, resolution_priority_0_100: rp.resolution_priority_0_100,
    };
    results.push(row);

    if (res.execution_route === 'owner_resolution_required') ownerResQueue.push(ownerResItem(row, res, p));
    if (res.execution_route === 'manual_review_renter_owner_conflict') conflictQueue.push(conflictItem(row, res, p));
    if (res.execution_route === 'entity_authority_resolution') entityQueue.push(entityItem(row, res, p));
  }

  writeQueues(ownerResQueue, conflictQueue, entityQueue);
  writeDistributions(dist);

  const summary = {
    scored: results.length,
    owner_resolution_distribution: dist.owner_resolution_status,
    execution_route_distribution: dist.execution_route,
    best_evidence_tier_distribution: dist.best_tier,
    confirmed_owner_contacts: confirmedOwners, probable_owner_contacts: probableOwners,
    outreach_eligible_people: outreachEligiblePeople, manual_approval_people: manualApprovalPeople,
    suppressed_people: suppressedPeople,
    properties_no_reachable_owner_contact: noReachableOwner,
    owner_resolution_queue: ownerResQueue.length, conflict_queue: conflictQueue.length, entity_queue: entityQueue.length,
    resolution_priority: { min: Math.min(...results.map((r) => r.resolution_priority)),
      median: median(results.map((r) => r.resolution_priority)), max: Math.max(...results.map((r) => r.resolution_priority)) },
    blocked_not_owner_emitted: dist.execution_route.blocked_not_owner ?? 0,
  };
  STATE.stages.phase5 = { at: new Date().toISOString(), ...summary };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function require_nameMatch(owner, name) {
  const toks = (s) => String(s ?? '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  const a = new Set(toks(owner)); return toks(name).filter((t) => a.has(t)).length >= 2;
}
function ownerResItem(row, res, p) {
  return { queue_version: 'owner-resolution-queue-v5', property_id: row.property_id, owner_of_record: row.owner_of_record,
    ownership_type: row.ownership_type, current_candidates: res.candidates.length,
    best_candidate: res.best_candidate_id ?? '', evidence_tier: res.best_evidence_tier ?? 'D',
    missing_evidence: row.missing_evidence, conflicting_evidence: res.conflict_candidate_ids.length,
    available_contact_methods: row.available_contact_methods,
    recommended_next_action: nextAction(res, p), seller_priority_raw: row.seller_priority_raw,
    foreclosure_urgency: row.foreclosure_urgency, resolution_priority: row.resolution_priority,
    resolution_urgency: p.fc_stage ? 'time_sensitive' : 'standard',
    created_at: nowIso(), last_evaluated_at: nowIso(), resolution_status: 'open', resolution_outcome: '' };
}
function conflictItem(row, res, p) {
  const conflicted = res.candidates.filter((c) => c.conflicted);
  return { queue_version: 'renter-owner-conflict-queue-v5', property_id: row.property_id, owner_of_record: row.owner_of_record,
    conflicted_contacts: conflicted.length, conflict_kind: conflictKind(conflicted),
    clean_separate_owner: res.candidates.some((c) => !c.conflicted && ['owner_confirmed', 'owner_candidate'].includes(c.person_status)),
    available_contact_methods: row.available_contact_methods, recommended_outcome: 'unresolved_manual_review',
    resolution_priority: row.resolution_priority, created_at: nowIso(), last_evaluated_at: nowIso(),
    resolution_status: 'open', resolution_outcome: '' };
}
function entityItem(row, res, p) {
  return { queue_version: 'entity-authority-queue-v5', property_id: row.property_id, legal_entity_name: row.owner_of_record,
    entity_type: entityType(row.owner_of_record), company_links: p.company_links ?? 0,
    authority_status: 'entity_contact_found_authority_unknown', // officers dormant => authority not resolvable from data
    officers_available: 0, registered_agent_available: 0, available_contact_methods: row.available_contact_methods,
    missing_evidence: 'verified_officer_or_authorized_signer; entity_status_confirmation',
    resolution_priority: row.resolution_priority, created_at: nowIso(), last_evaluated_at: nowIso(),
    resolution_status: 'open', resolution_outcome: '' };
}
function nextAction(res, p) {
  if (res.owner_resolution_status === 'no_reachable_owner_contact') return 'search_owner_graph_or_request_enrichment';
  if (res.owner_resolution_status === 'owner_candidate_found') return 'reconcile_owner_name_and_verify_mailing';
  if (res.owner_resolution_status === 'probate_authority_required') return 'locate_trustee_or_executor';
  if (res.owner_resolution_status === 'owner_unresolved') return 'identify_alternate_household_member';
  return 'manual_review';
}
function conflictKind(conflicted) {
  const c = conflicted[0]; if (!c) return 'unknown';
  if (c.evidence.includes('owner_name_match')) return 'owner_name_match_conflicts_with_renter_flag';
  if (c.evidence.includes('owner_match_verdict')) return 'owner_match_verdict_conflicts_with_renter_flag';
  if (c.evidence.includes('owner_token')) return 'owner_token_conflicts_with_renter_flag';
  return 'renter_owner_conflict';
}
function entityType(name) {
  const n = String(name ?? '').toUpperCase();
  if (/TRUST/.test(n)) return 'trust'; if (/ESTATE/.test(n)) return 'estate';
  if (/\bLLC\b|L\.L\.C/.test(n)) return 'llc'; if (/\bINC\b|CORP/.test(n)) return 'corporation';
  if (/\bLP\b|LLP/.test(n)) return 'partnership'; return 'entity';
}
const csvq = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
function writeCsv(path, rows) {
  if (!rows.length) { writeFileSync(path, '(empty)\n'); return; }
  const cols = Object.keys(rows[0]);
  writeFileSync(path, [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvq(r[c])).join(','))).join('\n') + '\n');
}
function writeQueues(o, c, e) {
  writeCsv(join(PKG, 'SELLER_OWNER_RESOLUTION_QUEUE.csv'), o);
  writeCsv(join(PKG, 'SELLER_RENTER_OWNER_CONFLICT_QUEUE.csv'), c);
  writeCsv(join(PKG, 'SELLER_ENTITY_AUTHORITY_QUEUE.csv'), e);
}
function writeDistributions(dist) {
  const lines = ['dimension,value,count'];
  for (const [dim, m] of Object.entries(dist)) for (const [k, v] of Object.entries(m)) lines.push(`${dim},${k},${v}`);
  writeFileSync(join(PKG, 'SELLER_PHASE_5_ROUTE_DISTRIBUTIONS.csv'), lines.join('\n') + '\n');
}
const nowIso = () => '2026-07-18T00:00:00Z';
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

main();
