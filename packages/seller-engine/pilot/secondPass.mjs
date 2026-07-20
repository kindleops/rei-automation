#!/usr/bin/env node
// Empirical second-pass idempotency verification. A representative partition R
// (chosen to exercise every canonical table + relationship family) is:
//   Phase A — re-merged from the existing staging partitions (filtered to R)
//             through the real merge path (casts, FK guards, dedup, DO-NOTHING
//             on immutable lineage), and
//   Phase B — re-scored (computeFeatures + scoreDeterministicV1), with the
//             re-computed feature/family/priority/explanation content hashed and
//             compared row-by-row against the DB-stored snapshots.
// Before/after hashes are compared for: row counts, PK sets, canonical row
// content, relationships, feature/family/priority/explanation snapshots,
// unresolved-domain counts, identity-conflict counts. Every difference is
// classified. Immutable raw payloads (source_records) are NOT rewritten.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { sha256 } from '../lib/hash.mjs';
import { psql, num, PILOT_DIR } from './pg.mjs';
import { readPartition } from '../lib/store.mjs';
import { TABLES, mergeSQL } from './tables.mjs';
import { copyIn, csvCell, pgArray } from './pg.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1 } from '../scores/deterministicV1.mjs';
import { assembleBundles } from './bundles.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
const jrows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// stable, key-sorted JSON hash so DB jsonb (alpha-sorted keys) and re-computed
// JS objects (insertion order) compare on logical content, not serialization
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') {
    return Object.keys(x).sort().reduce((o, k) => { o[k] = canonical(x[k]); return o; }, {});
  }
  return x;
}
const chash = (x) => sha256(JSON.stringify(canonical(x)));

// ---- representative partition: exercise every table + relationship family
function partition() {
  const ids = new Set();
  const add = (sql) => { for (const r of jrows(sql)) ids.add(r.property_id); };
  add(`select json_build_object('property_id',property_id) from seller_engine.property_foreclosure_events`); // all foreclosures
  add(`select json_build_object('property_id',property_id) from (select property_id from seller_engine.property_liens group by property_id order by md5(property_id) limit 600) q`);
  add(`select json_build_object('property_id',property_id) from (select property_id from seller_engine.property_company_links group by property_id order by md5(property_id) limit 400) q`);
  add(`select json_build_object('property_id',property_id) from (select property_id from seller_engine.property_person_links where renter_flag group by property_id order by md5(property_id) limit 400) q`);
  add(`select json_build_object('property_id',property_id) from (select property_id from seller_engine.property_loans group by property_id order by md5(property_id) limit 400) q`);
  add(`select json_build_object('property_id',property_id) from (select id property_id from seller_engine.properties group by id order by md5(id) limit 800) q`); // random fill
  return [...ids];
}

// ---- DB-side hashes restricted to R (before/after) --------------------------
function inClause(ids) { return ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(','); }

const PROP_FK = {
  properties: 'id', property_valuation_tax_snapshots: 'property_id', property_ownerships: 'property_id',
  property_loans: 'property_id', loan_checksums: 'property_id', property_transactions: 'property_id',
  property_foreclosure_events: 'property_id', property_person_links: 'property_id',
  property_company_links: 'property_id', property_liens: 'property_id',
};

function tableHashes(ids) {
  const inl = inClause(ids);
  const out = {};
  for (const [t, col] of Object.entries(PROP_FK)) {
    const pk = TABLES[t].pk;
    const cnt = num(`select count(*) from seller_engine.${t} where ${col} in (${inl})`);
    const pkHash = psql(`select coalesce(md5(string_agg(md5(${pk}::text), '' order by ${pk})), 'empty') from seller_engine.${t} where ${col} in (${inl})`);
    const contentHash = psql(`select coalesce(md5(string_agg(rowhash, '' order by pkv)), 'empty') from (select ${pk} pkv, md5(t::text) rowhash from seller_engine.${t} t where ${col} in (${inl})) s`);
    out[t] = { count: cnt, pk_hash: pkHash, content_hash: contentHash };
  }
  // child tables keyed off R's parents
  out.ownership_classifications = childHash('ownership_classifications', 'ownership_id',
    `select id from seller_engine.property_ownerships where property_id in (${inl})`);
  out.lien_parties = childHash('lien_parties', 'lien_id',
    `select id from seller_engine.property_liens where property_id in (${inl})`);
  out.people = childHash('people', 'id',
    `select distinct person_id from seller_engine.property_person_links where property_id in (${inl})`);
  out.contact_phones = childHash('contact_phones', 'person_id',
    `select distinct person_id from seller_engine.property_person_links where property_id in (${inl})`);
  out.contact_emails = childHash('contact_emails', 'person_id',
    `select distinct person_id from seller_engine.property_person_links where property_id in (${inl})`);
  out.companies = childHash('companies', 'id',
    `select distinct company_id from seller_engine.property_company_links where property_id in (${inl})`);
  return out;
}
function childHash(table, col, subSelect) {
  const cnt = num(`select count(*) from seller_engine.${table} where ${col} in (${subSelect})`);
  const pk = num(`select count(distinct ${table === 'loan_checksums' ? 'property_id' : 'id'}) from seller_engine.${table} where ${col} in (${subSelect})`);
  const contentHash = psql(`select coalesce(md5(string_agg(rowhash,'' order by rowhash)),'empty') from (select md5(t::text) rowhash from seller_engine.${table} t where ${col} in (${subSelect})) s`);
  return { count: cnt, distinct_pk: pk, content_hash: contentHash };
}

// relationship-integrity hashes (join edges, order-stable)
function relationshipHashes(ids) {
  const inl = inClause(ids);
  return {
    link_edges: psql(`select coalesce(md5(string_agg(e,'' order by e)),'empty') from (select property_id||'>'||person_id e from seller_engine.property_person_links where property_id in (${inl})) s`),
    lien_party_edges: psql(`select coalesce(md5(string_agg(e,'' order by e)),'empty') from (select lp.lien_id||'>'||lp.id e from seller_engine.lien_parties lp join seller_engine.property_liens l on l.id=lp.lien_id where l.property_id in (${inl})) s`),
    company_edges: psql(`select coalesce(md5(string_agg(e,'' order by e)),'empty') from (select property_id||'>'||company_id e from seller_engine.property_company_links where property_id in (${inl})) s`),
    classification_edges: psql(`select coalesce(md5(string_agg(e,'' order by e)),'empty') from (select oc.ownership_id||'>'||oc.id e from seller_engine.ownership_classifications oc join seller_engine.property_ownerships o on o.id=oc.ownership_id where o.property_id in (${inl})) s`),
  };
}

function snapshotHashes(ids) {
  const inl = inClause(ids);
  return {
    feature_snapshots: psql(`select coalesce(md5(string_agg(rowhash,'' order by id)),'empty') from (select id, md5(features::text) rowhash from seller_engine.seller_feature_snapshots where property_id in (${inl})) s`),
    family_scores: psql(`select coalesce(md5(string_agg(rowhash,'' order by rowhash)),'empty') from (select md5(ss.family||coalesce(ss.score::text,'n')||ss.score_state) rowhash from seller_engine.seller_score_snapshots ss join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id where fs.property_id in (${inl})) s`),
    priority: psql(`select coalesce(md5(string_agg(rowhash,'' order by rowhash)),'empty') from (select md5(fs.property_id||coalesce(ss.score::text,'n')) rowhash from seller_engine.seller_score_snapshots ss join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id where ss.family='execution_priority' and fs.property_id in (${inl})) s`),
    explanations: psql(`select coalesce(md5(string_agg(rowhash,'' order by rowhash)),'empty') from (select md5(se.component||coalesce(se.contribution::text,'n')||se.direction) rowhash from seller_engine.seller_score_explanations se join seller_engine.seller_score_snapshots ss on ss.id=se.score_snapshot_id join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id where fs.property_id in (${inl})) s`),
  };
}

function domainAndConflictCounts(ids) {
  const inl = inClause(ids);
  return {
    unresolved_domain_values: num('select count(*) from seller_engine.unmapped_domain_values'),
    renter_conflicts_R: num(`select count(*) from seller_engine.property_person_links where renter_flag and raw->'matching_flags' @> '["Likely Owner"]' and property_id in (${inl})`),
    corp_conflicts_R: num(`select count(distinct o.property_id) from seller_engine.ownership_classifications c join seller_engine.property_ownerships o on o.id=c.ownership_id where o.property_id in (${inl}) and c.classification='corporate' group by () having true limit 1`) || 0,
  };
}

// ---- Phase A: re-merge R's rows from staging through the real merge path
function stageEncode(table, row) {
  const spec = TABLES[table];
  const derived = spec.derive ? spec.derive(row) : {};
  return Object.entries(spec.cols).map(([c, t]) => {
    let v = derived[c] !== undefined ? derived[c] : row[c];
    if (c === 'raw' && spec.raw) v = row;
    if (t === 'arr') v = pgArray(Array.isArray(v) ? v : []);
    return csvCell(v);
  }).join(',');
}

async function reMergePartition(ids) {
  const idset = new Set(ids);
  const batchTables = {
    properties: ['properties', 'property_valuation_tax_snapshots', 'property_ownerships',
      'ownership_classifications', 'property_loans', 'loan_checksums', 'property_transactions',
      'property_foreclosure_events'],
    liens: ['property_liens', 'lien_parties'],
    companies: ['companies', 'property_company_links'],
    contact_info: ['contact_phones', 'contact_emails', 'people'],
    prospects: ['property_person_links'],
  };
  // parent-id sets for child-table filtering
  const ownIds = new Set(jrows(`select json_build_object('id',id) from seller_engine.property_ownerships where property_id in (${inClause(ids)})`).map((r) => r.id));
  const lienIds = new Set(jrows(`select json_build_object('id',id) from seller_engine.property_liens where property_id in (${inClause(ids)})`).map((r) => r.id));
  const personIds = new Set(jrows(`select json_build_object('id',person_id) from seller_engine.property_person_links where property_id in (${inClause(ids)})`).map((r) => r.id ?? r.person_id));
  const companyIds = new Set(jrows(`select json_build_object('id',company_id) from seller_engine.property_company_links where property_id in (${inClause(ids)})`).map((r) => r.id ?? r.company_id));

  const belongs = (table, row) => {
    if (table === 'ownership_classifications') return ownIds.has(row.ownership_id);
    if (table === 'lien_parties') return lienIds.has(row.lien_id);
    if (table === 'people') return personIds.has(row.id);
    if (table === 'contact_phones' || table === 'contact_emails') return personIds.has(row.person_id);
    if (table === 'companies') return companyIds.has(row.id);
    if (table === 'loan_checksums') return idset.has(row.property_id);
    return idset.has(row.property_id);
  };

  let staged = 0;
  for (const [fileSet, tbls] of Object.entries(batchTables)) {
    const batch = STATE.batches[fileSet];
    if (!batch) continue;
    for (const t of tbls) {
      psql(`set search_path to seller_engine; truncate table stage_${t} restart identity;`);
      const rows = readPartition(t, batch.id).filter((r) => belongs(t, r));
      if (!rows.length) continue;
      await copyIn(`seller_engine.stage_${t}`, Object.keys(TABLES[t].cols), rows.map((r) => stageEncode(t, r)));
      psql(`set search_path to seller_engine; ${mergeSQL(t)}`);
      staged += rows.length;
    }
  }
  return staged;
}

// ---- Phase B: re-score R and compare re-computed vs stored snapshot hashes
function reScoreCompare(ids) {
  const idset = new Set(ids);
  const { bundles } = assembleBundles({ batches: STATE.batches, sidecarPath: STATE.batches.prospects?.sidecar ?? null });
  const subset = bundles.filter((b) => idset.has(b.property.id));
  const seen = new Set();
  let featMatch = 0; let featMismatch = 0; let priMatch = 0; let priMismatch = 0;
  let famMatch = 0; let famMismatch = 0; let explMatch = 0; let explMismatch = 0;
  const mismatches = [];
  // stored feature JSON per property (parse -> canonical hash)
  for (const b of subset) {
    if (seen.has(b.property.id)) continue; seen.add(b.property.id);
    const feats = computeFeatures(b, STATE.stages.score.as_of, { compSnapshot: b.compSnapshot ?? null });
    const v1 = scoreDeterministicV1(feats.features);
    const stored = jrows(`select json_build_object('features', features) from seller_engine.seller_feature_snapshots where property_id='${b.property.id.replace(/'/g, "''")}'`)[0];
    if (!stored) { featMismatch += 1; mismatches.push({ property_id: b.property.id, kind: 'missing_stored' }); continue; }
    if (chash(feats.features) === chash(stored.features)) featMatch += 1;
    else { featMismatch += 1; mismatches.push({ property_id: b.property.id, kind: 'feature_hash' }); }
    // priority (raw) from DB
    const storedPri = psql(`select coalesce(ss.score::text,'n') from seller_engine.seller_score_snapshots ss join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id where ss.family='execution_priority' and fs.property_id='${b.property.id.replace(/'/g, "''")}'`);
    if (String(v1.execution_priority) === storedPri) priMatch += 1; else { priMismatch += 1; mismatches.push({ property_id: b.property.id, kind: 'priority', recomputed: v1.execution_priority, stored: storedPri }); }
    // family scores set
    const recFam = chash(Object.fromEntries(Object.entries(v1.families).map(([k, f]) => [k, [f.score ?? null, f.score_state]])));
    const storedFamRows = jrows(`select json_build_object('family',ss.family,'score',ss.score,'state',ss.score_state) from seller_engine.seller_score_snapshots ss join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id where fs.property_id='${b.property.id.replace(/'/g, "''")}' and ss.family <> 'v12_baseline_priority'`);
    const storedFam = chash(Object.fromEntries(storedFamRows.map((r) => [r.family, [r.score ?? null, r.state]])));
    if (recFam === storedFam) famMatch += 1; else { famMismatch += 1; mismatches.push({ property_id: b.property.id, kind: 'family' }); }
    // explanation set (component+contribution+direction, order-insensitive)
    const recExpl = chash([...v1.explanations.map((e) => [e.component, e.contribution ?? null, e.direction])].sort());
    const storedExplRows = jrows(`select json_build_object('c',se.component,'v',se.contribution,'d',se.direction) from seller_engine.seller_score_explanations se join seller_engine.seller_score_snapshots ss on ss.id=se.score_snapshot_id join seller_engine.seller_feature_snapshots fs on fs.id=ss.feature_snapshot_id where fs.property_id='${b.property.id.replace(/'/g, "''")}'`);
    const storedExpl = chash([...storedExplRows.map((r) => [r.c, r.v ?? null, r.d])].sort());
    if (recExpl === storedExpl) explMatch += 1; else { explMismatch += 1; mismatches.push({ property_id: b.property.id, kind: 'explanation' }); }
  }
  return { scored: seen.size, featMatch, featMismatch, priMatch, priMismatch, famMatch, famMismatch, explMatch, explMismatch, mismatches: mismatches.slice(0, 50) };
}

async function main() {
  const ids = partition();
  console.log(`partition R: ${ids.length} properties`);
  const before = { tables: tableHashes(ids), relationships: relationshipHashes(ids), snapshots: snapshotHashes(ids), counts: domainAndConflictCounts(ids) };

  const stagedA = await reMergePartition(ids);
  const scoreCmp = reScoreCompare(ids);

  const after = { tables: tableHashes(ids), relationships: relationshipHashes(ids), snapshots: snapshotHashes(ids), counts: domainAndConflictCounts(ids) };

  // diff classification
  const diffs = [];
  const cmp = (path, b, a) => { if (JSON.stringify(b) !== JSON.stringify(a)) diffs.push({ path, before: b, after: a }); };
  for (const t of Object.keys(before.tables)) cmp(`table.${t}`, before.tables[t], after.tables[t]);
  for (const r of Object.keys(before.relationships)) cmp(`rel.${r}`, before.relationships[r], after.relationships[r]);
  for (const s of Object.keys(before.snapshots)) cmp(`snap.${s}`, before.snapshots[s], after.snapshots[s]);
  for (const c of Object.keys(before.counts)) cmp(`count.${c}`, before.counts[c], after.counts[c]);

  const classified = diffs.map((d) => ({ ...d, classification: 'defect' })); // any DB diff after idempotent re-merge is a defect
  const scoringDefects = scoreCmp.featMismatch + scoreCmp.priMismatch + scoreCmp.famMismatch + scoreCmp.explMismatch;

  const verdict = diffs.length === 0 && scoringDefects === 0 ? 'PASS_ZERO_UNEXPLAINED_DIFFERENCES' : 'DIFFERENCES_FOUND';

  // CSV
  const cols = ['category', 'key', 'before', 'after', 'match'];
  const rows = [];
  const push = (cat, k, b, a, matchOverride) => rows.push([cat, k, JSON.stringify(b).replaceAll(',', ';'), JSON.stringify(a).replaceAll(',', ';'),
    (matchOverride ?? (JSON.stringify(b) === JSON.stringify(a))) ? 'MATCH' : 'DIFF']);
  for (const t of Object.keys(before.tables)) push('table', t, before.tables[t], after.tables[t]);
  for (const r of Object.keys(before.relationships)) push('relationship', r, before.relationships[r], after.relationships[r]);
  for (const s of Object.keys(before.snapshots)) push('snapshot', s, before.snapshots[s], after.snapshots[s]);
  for (const c of Object.keys(before.counts)) push('count', c, before.counts[c], after.counts[c]);
  // scoring rows: recomputed-vs-stored, match iff mismatch count is 0
  push('scoring', 'feature_hash', `${scoreCmp.featMatch}/${scoreCmp.scored} match`, `${scoreCmp.featMismatch} mismatch`, scoreCmp.featMismatch === 0);
  push('scoring', 'priority_hash', `${scoreCmp.priMatch}/${scoreCmp.scored} match`, `${scoreCmp.priMismatch} mismatch`, scoreCmp.priMismatch === 0);
  push('scoring', 'family_hash', `${scoreCmp.famMatch}/${scoreCmp.scored} match`, `${scoreCmp.famMismatch} mismatch`, scoreCmp.famMismatch === 0);
  push('scoring', 'explanation_hash', `${scoreCmp.explMatch}/${scoreCmp.scored} match`, `${scoreCmp.explMismatch} mismatch`, scoreCmp.explMismatch === 0);
  const csv = [cols.join(',')].concat(rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(','))).join('\n') + '\n';
  writeFileSync(join(PKG, 'SELLER_SECOND_PASS_HASH_COMPARISON.csv'), csv);

  const result = {
    partition_size: ids.length, phase_a_staged_rows: stagedA,
    scoring: { scored: scoreCmp.scored, feature_match: scoreCmp.featMatch, feature_mismatch: scoreCmp.featMismatch,
      priority_match: scoreCmp.priMatch, priority_mismatch: scoreCmp.priMismatch,
      family_match: scoreCmp.famMatch, family_mismatch: scoreCmp.famMismatch,
      explanation_match: scoreCmp.explMatch, explanation_mismatch: scoreCmp.explMismatch },
    db_diffs: diffs.length, scoring_defects: scoringDefects, verdict,
    diff_detail: classified.slice(0, 20), scoring_mismatch_detail: scoreCmp.mismatches,
  };
  STATE.stages.second_pass = { at: new Date().toISOString(), ...result };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

await main();
