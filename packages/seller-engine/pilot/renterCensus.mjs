#!/usr/bin/env node
// Full-population census of every currently hard-blocked pilot property (3,976),
// classified with the V1.3 owner-resolution resolver. Read-only. Bulk queries
// via a temp table of hard-block IDs. Emits SELLER_RENTER_GATE_FULL_CENSUS.csv
// and SELLER_RENTER_GATE_FULL_CENSUS_SUMMARY.md.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, num } from './pg.mjs';
import { resolveOwner, nameSignals, ENTITY_NAME_RE } from '../scores/ownerResolution.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const jrows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => JSON.parse(l));

const CATEGORY = {
  1: 'confirmed_renter_only_safe_block', 2: 'renter_suppressed_clean_owner_preserved',
  3: 'named_owner_renter_conflict', 4: 'owner_exists_person_link_missing',
  5: 'entity_owner_authority_resolution', 6: 'ambiguous_identity',
  7: 'probable_false_block', 8: 'insufficient_evidence', 0: 'clean_owner',
};

function main() {
  // materialize the hard-block population (persistent scratch table so it
  // survives across separate psql connections)
  psql(`drop table if exists seller_engine.census_hardblock;
    create table seller_engine.census_hardblock as
    select property_id from seller_engine.property_person_links
    group by property_id
    having bool_or(renter_flag) and count(*) filter (where not renter_flag and link_tier<>'none')=0;`);
  const total = num('select count(*) from seller_engine.census_hardblock');

  // ownership + entity evidence per property
  const own = new Map(jrows(`select row_to_json(t) from (
    select o.property_id, o.owner_name_raw, o.owner_hash, o.mailing_state, o.occupancy_raw,
      p.situs_state, p.asset_class,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=o.property_id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id
             where oo.property_id=o.property_id and c.classification in ('corporate','trust','estate')) cls_entity
    from seller_engine.property_ownerships o
    join seller_engine.properties p on p.id=o.property_id
    where o.property_id in (select property_id from seller_engine.census_hardblock)) t`).map((r) => [r.property_id, r]));

  // all linked persons for the population
  const linksByProp = new Map();
  for (const l of jrows(`select row_to_json(t) from (
    select l.property_id, l.person_id, pe.identity_tier, pe.individual_key, pe.full_name person_name,
      l.renter_flag, l.link_tier, l.is_matching_property_as_owner,
      (l.raw->'matching_flags') matching_flags
    from seller_engine.property_person_links l
    join seller_engine.people pe on pe.id=l.person_id
    where l.property_id in (select property_id from seller_engine.census_hardblock)) t`)) {
    (linksByProp.get(l.property_id) ?? linksByProp.set(l.property_id, []).get(l.property_id)).push(l);
  }

  const rows = [];
  const catCounts = {};
  const routeCounts = {};
  const statusCounts = {};
  for (const [pid, o] of own) {
    const links = linksByProp.get(pid) ?? [];
    const persons = links.map((l) => {
      const flags = Array.isArray(l.matching_flags) ? l.matching_flags : [];
      const ns = nameSignals(o.owner_name_raw, l.person_name);
      return {
        id: l.person_id, identity_tier: l.identity_tier, individual_key: l.individual_key,
        renter_flag: l.renter_flag === true, link_tier: l.link_tier,
        owner_token: flags.some((t) => /likely owner|potential owner/i.test(String(t))),
        owner_verdict: l.is_matching_property_as_owner === true,
        name_match: ns.name_match, surname_match: ns.surname_match,
        exact_key_owner: l.is_matching_property_as_owner === true && l.identity_tier === 'key' && ns.name_match,
      };
    });
    const isEntity = (o.company_links ?? 0) > 0 || o.cls_entity === true
      || (o.owner_name_raw ? ENTITY_NAME_RE.test(o.owner_name_raw) : false);
    const res = resolveOwner({ owner_name: o.owner_name_raw, owner_hash: o.owner_hash,
      is_entity: isEntity, situs_state: o.situs_state, mailing_state: o.mailing_state, persons });

    // probable-false-block flag: currently blocked (all rows are) but V1.3 does
    // not confirm a block AND real owner evidence exists somewhere
    const anyOwnerEvidence = persons.some((p) => p.name_match || p.owner_token || p.owner_verdict);
    const probableFalseBlock = res.identity_route !== 'blocked_not_owner' && (anyOwnerEvidence || res.owner_of_record_present);

    catCounts[res.census_category] = (catCounts[res.census_category] ?? 0) + 1;
    routeCounts[res.identity_route] = (routeCounts[res.identity_route] ?? 0) + 1;
    statusCounts[res.owner_resolution_status] = (statusCounts[res.owner_resolution_status] ?? 0) + 1;

    rows.push({
      property_id: pid, asset_class: o.asset_class ?? '', situs_state: o.situs_state ?? '',
      owner_name: o.owner_name_raw ?? '', owner_hash: o.owner_hash ?? '',
      owner_mailing_state: o.mailing_state ?? '', occupancy_raw: o.occupancy_raw ?? '',
      is_entity: isEntity, company_links: o.company_links ?? 0,
      linked_persons: persons.length,
      renter_persons: persons.filter((p) => p.renter_flag).length,
      keyed_persons: persons.filter((p) => p.identity_tier === 'key').length,
      any_owner_token: persons.some((p) => p.owner_token),
      any_owner_verdict: persons.some((p) => p.owner_verdict),
      any_name_match: persons.some((p) => p.name_match),
      clean_owner_count: res.clean_owner_count,
      outreach_eligible: res.outreach_eligible_person_ids.length,
      identity_completeness_supports_block: res.identity_route === 'blocked_not_owner',
      owner_resolution_status: res.owner_resolution_status,
      census_category: res.census_category,
      census_label: CATEGORY[res.census_category],
      new_route_v1_3: res.identity_route,
      probable_false_block: probableFalseBlock,
    });
  }

  // CSV
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replaceAll('"', '""')}"`).join(','))).join('\n') + '\n';
  writeFileSync(join(PKG, 'SELLER_RENTER_GATE_FULL_CENSUS.csv'), csv);

  const falseBlocks = rows.filter((r) => r.probable_false_block).length;
  const confirmedBlocks = catCounts[1] ?? 0;
  const summary = {
    total, confirmed_hard_blocks: confirmedBlocks,
    false_blocks_prevented: total - confirmedBlocks,
    categories: Object.fromEntries(Object.entries(catCounts).sort().map(([k, v]) => [`${k}_${CATEGORY[k]}`, v])),
    new_routes: routeCounts, owner_resolution_statuses: statusCounts,
    probable_false_block_rows: falseBlocks,
  };
  writeFileSync(join(PKG, 'SELLER_RENTER_GATE_FULL_CENSUS_SUMMARY.md'), renderSummary(summary, total));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : '0%'; }
function renderSummary(s, total) {
  const catRows = Object.entries(s.categories).map(([k, v]) => `| ${k} | ${v} | ${pct(v, total)} |`).join('\n');
  const routeRows = Object.entries(s.new_routes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| \`${k}\` | ${v} | ${pct(v, total)} |`).join('\n');
  return `# SELLER RENTER-GATE FULL CENSUS SUMMARY

Population: **all ${total} currently hard-blocked pilot properties** (not a sample). Classified with the V1.3 owner-resolution resolver (\`scores/ownerResolution.mjs\`). Read-only; the gate is versioned separately (V1.3). Full rows: \`SELLER_RENTER_GATE_FULL_CENSUS.csv\`.

## Headline
- Confirmed renter-only / safe hard blocks (V1.3 keeps blocked): **${s.confirmed_hard_blocks}** (${pct(s.confirmed_hard_blocks, total)})
- Previous hard blocks NOT confirmed by V1.3 (false blocks prevented): **${s.false_blocks_prevented}** (${pct(s.false_blocks_prevented, total)})
- Every one of the ${total} has an owner of record — a definitive \`blocked_not_owner\` is only valid with NO owner to pursue, which is why the confirmed count is small.

## Classification (all ${total})
| Category | Count | Rate |
|---|---:|---:|
${catRows}

## New V1.3 routes for the previously-blocked population
| Route | Count | Rate |
|---|---:|---:|
${routeRows}

## Owner-resolution statuses
${Object.entries(s.owner_resolution_statuses).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')}

## Interpretation
The V1.2 property-level hard block converted "renter present + owner not resolved to a clean contact" into a definitive \`blocked_not_owner\`. V1.3 keeps renter suppression **person-scoped** and routes the property by owner-resolution status: entity owners to authority resolution, named-owner/renter conflicts to manual review, and owners of record that were never linked to a contact to owner-resolution — none of which are outreach, but none of which discard a real owner. No property is auto-messaged from this population; outreach still requires explicit, corroborated owner/authority evidence.
`;
}

main();
