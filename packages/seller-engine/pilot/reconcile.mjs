#!/usr/bin/env node
// Source-to-canonical reconciliation for the pilot batch. Every number is
// queried from the pilot DB or the import reports — nothing hand-entered.
// Emits SELLER_PILOT_RECONCILIATION.csv + SELLER_PILOT_IDENTITY_CONFLICTS.csv.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { num, psql, PILOT_DIR } from './pg.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));

const CANONICAL = ['import_batches', 'source_records', 'properties', 'property_valuation_tax_snapshots',
  'property_ownerships', 'ownership_classifications', 'people', 'property_person_links',
  'contact_phones', 'contact_emails', 'companies', 'property_company_links',
  'property_loans', 'loan_checksums', 'property_transactions', 'property_liens',
  'lien_parties', 'property_foreclosure_events', 'unmapped_domain_values',
  'seller_feature_snapshots', 'seller_score_snapshots', 'seller_score_explanations'];

const FK_CHECKS = [
  ['property_valuation_tax_snapshots', 'property_id', 'properties'],
  ['property_ownerships', 'property_id', 'properties'],
  ['ownership_classifications', 'ownership_id', 'property_ownerships'],
  ['property_person_links', 'property_id', 'properties'],
  ['property_person_links', 'person_id', 'people'],
  ['contact_phones', 'person_id', 'people'],
  ['contact_emails', 'person_id', 'people'],
  ['property_company_links', 'property_id', 'properties'],
  ['property_company_links', 'company_id', 'companies'],
  ['property_loans', 'property_id', 'properties'],
  ['property_transactions', 'property_id', 'properties'],
  ['property_liens', 'property_id', 'properties'],
  ['lien_parties', 'lien_id', 'property_liens'],
  ['property_foreclosure_events', 'property_id', 'properties'],
  ['seller_feature_snapshots', 'property_id', 'properties'],
  ['seller_score_snapshots', 'feature_snapshot_id', 'seller_feature_snapshots'],
  ['seller_score_explanations', 'score_snapshot_id', 'seller_score_snapshots'],
];

export function reconcile() {
  const rows = [['metric', 'scope', 'value', 'source']];
  const add = (metric, scope, value, source) => rows.push([metric, scope, value, source]);

  // source -> staged -> canonical per file set
  for (const [fileSet, b] of Object.entries(STATE.batches)) {
    add('source_rows', fileSet, b.rows, 'import_batches.row_count');
    add('import_conflicts', fileSet, typeof b.conflicts === 'object' ? JSON.stringify(b.conflicts).replaceAll(',', ';') : b.conflicts, 'importer conflict log');
    const stage = STATE.stages[`import_${fileSet}`]?.load ?? {};
    for (const [table, s] of Object.entries(stage)) {
      add('stage_rows', `${fileSet}.${table}`, s.stage_rows, 'stage count');
      add('duplicate_rows_in_stage', `${fileSet}.${table}`, s.duplicates_in_stage, 'stage distinct-id delta');
      if (s.orphans_blocked) add('orphaned_relationship_rows', `${fileSet}.${table}`, s.orphans_blocked, 'fk-guard reject count');
      add('rows_upserted', `${fileSet}.${table}`, s.inserted + s.upserted_existing, 'merge stats');
    }
  }

  for (const t of CANONICAL) add('canonical_rows', t, num(`select count(*) from seller_engine.${t}`), 'pilot db');

  // rejected casts
  const rejects = psql(`select target_table||'.'||column_name||'='||reject_count from seller_engine.pilot_load_rejects order by reject_count desc`);
  add('rejected_value_casts_total', 'all', num('select coalesce(sum(reject_count),0) from seller_engine.pilot_load_rejects'), 'pilot_load_rejects');
  for (const line of rejects.split('\n').filter(Boolean).slice(0, 40)) {
    const [k, v] = line.split('=');
    add('rejected_value_casts', k, v, 'pilot_load_rejects');
  }

  // FK orphans in final state (guarded loads should leave zero)
  let orphanTotal = 0;
  for (const [child, col, parent] of FK_CHECKS) {
    const n = num(`select count(*) from seller_engine.${child} c left join seller_engine.${parent} p on p.id = c.${col} where c.${col} is not null and p.id is null`);
    orphanTotal += n;
    if (n > 0) add('fk_orphans', `${child}.${col}`, n, 'left-join audit');
  }
  add('fk_orphans_total', 'all', orphanTotal, 'left-join audit');

  // duplicates & dedup laws
  add('duplicate_vendor_property_ids_in_canonical', 'properties',
    num('select count(*) - count(distinct vendor_property_id) from seller_engine.properties'), 'pilot db');
  add('unresolved_domain_values', 'all', num('select count(*) from seller_engine.unmapped_domain_values'), 'pilot db');

  // lineage law: every score has a feature snapshot; every explanation a score
  add('scores_without_feature_lineage', 'seller_score_snapshots',
    num('select count(*) from seller_engine.seller_score_snapshots s left join seller_engine.seller_feature_snapshots f on f.id=s.feature_snapshot_id where f.id is null'), 'lineage audit');
  add('properties_scored', 'seller_feature_snapshots',
    num('select count(distinct property_id) from seller_engine.seller_feature_snapshots'), 'pilot db');
  add('score_families_per_property', 'seller_score_snapshots',
    psql(`select string_agg(distinct cnt::text, ';') from (select feature_snapshot_id, count(*) cnt from seller_engine.seller_score_snapshots group by 1) q`), 'pilot db');

  const csv = rows.map((r) => r.join(',')).join('\n') + '\n';
  writeFileSync(join(PKG, 'SELLER_PILOT_RECONCILIATION.csv'), csv);

  // ---- identity conflicts
  const ic = [['conflict_kind', 'count', 'detail']];
  ic.push(['renter_owner_collision', STATE.batches.prospects?.conflicts?.renter_owner_collision ?? 0, 'same person carries owner tokens AND renter flag (person-scoped gate applies)']);
  const propReport = latestReport('import_properties_');
  const corpConf = propReport?.summary?.conflicts ?? 0;
  ic.push(['import_conflicts_properties', corpConf, 'corp-class + loan-count aggregate conflicts (see report json)']);
  ic.push(['duplicate_individual_key_people', num(`select count(*) from (select individual_key from seller_engine.people where individual_key is not null group by individual_key having count(*)>1) q`), 'same vendor key, multiple person rows (deterministic-id dedup => 0 expected)']);
  const keyTier = num(`select count(*) from seller_engine.people where identity_tier='key'`);
  const fallbackTier = num(`select count(*) from seller_engine.people where identity_tier<>'key'`);
  ic.push(['vendor_keyed_people', keyTier, 'numeric vendor individual_key (strong identity)']);
  ic.push(['fallback_identity_people', fallbackTier, 'non-numeric/unmatched key => name_address fallback tier (this batch: better keyed than the 61% QA corpus)']);
  ic.push(['people_total', num('select count(*) from seller_engine.people'), '']);
  ic.push(['renter_flagged_links', num('select count(*) from seller_engine.property_person_links where renter_flag'), 'person-level gate']);
  ic.push(['renter_blocked_properties', num(`select count(*) from (select property_id from seller_engine.property_person_links group by property_id having bool_or(renter_flag) and not bool_or(link_tier <> 'none' and not renter_flag)) q`), 'no clean owner link remains (F-112 semantics)']);
  ic.push(['owner_hash_multi_property_groups', num(`select count(*) from (select p.raw->'raw_keep'->>'owner_hash' oh from seller_engine.properties p where p.raw->'raw_keep'->>'owner_hash' is not null group by 1 having count(*)>1) q`), 'in-corpus sibling holdings']);
  ic.push(['corp_multi_evidence_properties', num(`select count(*) from (select o.property_id from seller_engine.ownership_classifications c join seller_engine.property_ownerships o on o.id=c.ownership_id where c.classification='corporate' group by o.property_id having count(distinct c.evidence_source) > 1) q`), 'multi-source corporate evidence retained (OD-2)']);
  writeFileSync(join(PKG, 'SELLER_PILOT_IDENTITY_CONFLICTS.csv'), ic.map((r) => r.join(',')).join('\n') + '\n');

  console.log(`reconciliation written: ${rows.length - 1} metrics; identity conflicts: ${ic.length - 1} rows; fk_orphans_total=${orphanTotal}`);
  return { metrics: rows.length - 1, fkOrphans: orphanTotal };
}

function latestReport(prefix) {
  const dir = join(PKG, 'var', 'reports');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => x.startsWith(prefix)).sort().pop();
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) reconcile();
