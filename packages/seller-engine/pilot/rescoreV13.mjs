#!/usr/bin/env node
// Full-pilot V1.2 vs V1.3 rescore comparison. V1.2 baseline (route + raw
// priority + family scores) is read from the frozen 1.2.0 full shadow cohort;
// V1.3 is recomputed with the current engine (1.3.0) over the same canonical
// data, enriched with person names so the owner resolver can test name match.
// Emits SELLER_V1_2_VS_V1_3_ROUTE_COMPARISON.csv, SELLER_V1_3_ROUTE_DISTRIBUTIONS.csv.
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, PILOT_DIR } from './pg.mjs';
import { assembleBundles } from './bundles.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1 } from '../scores/deterministicV1.mjs';
import { buildCohortBuckets, formalizePriority } from '../scores/priorityContract.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
const MOT = ['seller_propensity', 'financial_pressure', 'legal_title_pressure', 'foreclosure_urgency',
  'property_distress', 'physical_obsolescence', 'landlord_fatigue', 'portfolio_liquidation'];

async function loadV12Baseline() {
  const dir = STATE.stages.full_shadow?.primary?.dir;
  const map = new Map();
  const rl = createInterface({ input: createReadStream(join(dir, 'records.ndjson')), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    const mot = {};
    for (const f of MOT) mot[f] = r.score_families?.[f]?.score ?? null;
    map.set(r.property_id, { route: r.execution_route, raw: r.execution_priority_raw ?? r.deterministic_v1_score, mot });
  }
  return map;
}

function personNames() {
  const m = new Map();
  const raw = psql("select id||'\t'||coalesce(replace(full_name,chr(9),' '),'') from seller_engine.people");
  for (const line of raw.split('\n')) {
    const t = line.indexOf('\t');
    if (t > 0) m.set(line.slice(0, t), line.slice(t + 1));
  }
  return m;
}

async function main() {
  const asOf = STATE.stages.score.as_of;
  const v12 = await loadV12Baseline();
  const names = personNames();
  const { bundles } = assembleBundles({ batches: STATE.batches, sidecarPath: STATE.batches.prospects?.sidecar ?? null, personNames: names });

  // pass 1: rescore V1.3, collect raw priorities for cohort buckets
  const seen = new Set();
  const recs = [];
  const bucketRows = [];
  let famDrift = 0;
  for (const b of bundles) {
    if (seen.has(b.property.id)) continue; seen.add(b.property.id);
    const feats = computeFeatures(b, asOf, { compSnapshot: b.compSnapshot ?? null });
    const s = scoreDeterministicV1(feats.features);
    const base = v12.get(b.property.id);
    const motV13 = {};
    let drift = false;
    for (const f of MOT) { motV13[f] = s.families[f].score ?? null; if (base && motV13[f] !== base.mot[f]) drift = true; }
    if (drift) famDrift += 1;
    recs.push({
      property_id: b.property.id, asset_class: b.property.asset_class, situs_state: b.property.situs_state,
      v12_route: base?.route ?? null, v13_route: s.route,
      v12_raw: base?.raw ?? null, v13_raw: s.execution_priority,
      family_drift: drift,
    });
    bucketRows.push({ asset_class: b.property.asset_class, situs_state: b.property.situs_state, raw: s.execution_priority });
  }
  const v13Buckets = buildCohortBuckets(bucketRows);
  const v12Buckets = buildCohortBuckets(recs.filter((r) => r.v12_raw !== null).map((r) => ({ asset_class: r.asset_class, situs_state: r.situs_state, raw: r.v12_raw })));

  // pass 2: attach display score + percentile for both versions
  for (const r of recs) {
    const subj = { asset_class: r.asset_class, situs_state: r.situs_state };
    const c13 = formalizePriority(r.v13_raw, subj, v13Buckets);
    r.v13_score_0_100 = c13.execution_priority_score_0_100;
    r.v13_percentile = c13.execution_priority_percentile;
    if (r.v12_raw !== null) {
      const c12 = formalizePriority(r.v12_raw, subj, v12Buckets);
      r.v12_score_0_100 = c12.execution_priority_score_0_100;
      r.v12_percentile = c12.execution_priority_percentile;
    } else { r.v12_score_0_100 = null; r.v12_percentile = null; }
    r.route_changed = r.v12_route !== r.v13_route;
    r.raw_delta = r.v12_raw !== null ? r.v13_raw - r.v12_raw : null;
  }

  // transition matrix + summary counts
  const transitions = {};
  const v13dist = {};
  const v12dist = {};
  for (const r of recs) {
    const key = `${r.v12_route} -> ${r.v13_route}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    v13dist[r.v13_route] = (v13dist[r.v13_route] ?? 0) + 1;
    v12dist[r.v12_route] = (v12dist[r.v12_route] ?? 0) + 1;
  }
  const leavingBlocked = recs.filter((r) => r.v12_route === 'blocked_not_owner' && r.v13_route !== 'blocked_not_owner').length;
  const enter = (route) => recs.filter((r) => r.v13_route === route && r.v12_route !== route).length;
  const restoredOutreach = recs.filter((r) => r.v12_route === 'blocked_not_owner' && r.v13_route === 'owner_outreach').length;
  const rawChanged = recs.filter((r) => r.raw_delta !== null && r.raw_delta !== 0).length;

  // CSV: full comparison
  const cols = ['property_id', 'asset_class', 'situs_state', 'v12_route', 'v13_route', 'route_changed',
    'v12_raw', 'v13_raw', 'raw_delta', 'v12_score_0_100', 'v13_score_0_100', 'v12_percentile', 'v13_percentile', 'family_drift'];
  writeFileSync(join(PKG, 'SELLER_V1_2_VS_V1_3_ROUTE_COMPARISON.csv'),
    [cols.join(',')].concat(recs.map((r) => cols.map((c) => `"${r[c] ?? ''}"`).join(','))).join('\n') + '\n');

  // CSV: route distributions
  const routes = [...new Set([...Object.keys(v12dist), ...Object.keys(v13dist)])].sort();
  writeFileSync(join(PKG, 'SELLER_V1_3_ROUTE_DISTRIBUTIONS.csv'),
    ['route,v1_2_count,v1_3_count,delta'].concat(routes.map((rt) => `${rt},${v12dist[rt] ?? 0},${v13dist[rt] ?? 0},${(v13dist[rt] ?? 0) - (v12dist[rt] ?? 0)}`)).join('\n') + '\n');

  const summary = {
    scored: recs.length, family_score_drift_properties: famDrift,
    v12_route_distribution: v12dist, v13_route_distribution: v13dist,
    leaving_blocked_not_owner: leavingBlocked,
    entering_owner_resolution_required: enter('owner_resolution_required'),
    entering_manual_review_renter_owner_conflict: enter('manual_review_renter_owner_conflict'),
    entering_entity_authority_resolution: enter('entity_authority_resolution'),
    restored_to_owner_outreach: restoredOutreach,
    raw_priority_changed_properties: rawChanged,
    transitions: Object.fromEntries(Object.entries(transitions).sort((a, b) => b[1] - a[1])),
  };
  STATE.stages.rescore_v13 = { at: new Date().toISOString(), ...summary };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await main();
