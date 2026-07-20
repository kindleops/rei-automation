#!/usr/bin/env node
// Stratified audit of the renter / owner-link gate (F-110/F-112). Read-only
// over the pilot DB. Deterministic pseudo-random sampling via md5(property_id)
// so the audit is reproducible. Emits SELLER_RENTER_GATE_AUDIT_SAMPLE.csv and a
// false-block estimate with a Wilson 95% interval. Does NOT change the gate.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql } from './pg.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIER = { exact: 4, high: 3, medium: 2, low: 1, none: 0 };

const jrows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// property-id strata (deterministic sample by md5 order)
function stratumIds(having, limit) {
  return jrows(`select json_build_object('property_id', property_id) from (
    select l.property_id from seller_engine.property_person_links l
    group by l.property_id having ${having}
    order by md5(l.property_id) limit ${limit}) q`).map((r) => r.property_id);
}

function detail(propertyIds) {
  if (!propertyIds.length) return [];
  const inList = propertyIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
  // property + ownership + company evidence
  const props = new Map(jrows(`select row_to_json(t) from (
    select p.id property_id, p.asset_class, p.situs_state,
      o.owner_hash, o.owner_name_raw, o.mailing_state, o.occupancy_raw,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      (select string_agg(distinct c.company_name, ' | ') from seller_engine.property_company_links cl
         join seller_engine.companies c on c.id=cl.company_id where cl.property_id=p.id) company_names
    from seller_engine.properties p
    left join seller_engine.property_ownerships o on o.property_id=p.id
    where p.id in (${inList})) t`).map((r) => [r.property_id, r]));
  // links per property
  const linksByProp = new Map();
  for (const l of jrows(`select row_to_json(t) from (
    select l.property_id, pe.identity_tier, l.renter_flag, l.link_tier,
      l.is_matching_property_as_owner, l.likely_owner_scalar,
      (l.raw->'matching_flags') matching_flags,
      pe.full_name person_name
    from seller_engine.property_person_links l
    join seller_engine.people pe on pe.id=l.person_id
    where l.property_id in (${inList})) t`)) {
    (linksByProp.get(l.property_id) ?? linksByProp.set(l.property_id, []).get(l.property_id)).push(l);
  }
  return propertyIds.map((pid) => classify(props.get(pid), linksByProp.get(pid) ?? []));
}

// surname/given token overlap between an owner-of-record name ("SMITH, JOHN")
// and a person full_name ("JOHN SMITH" / "SMITH JOHN"): 2+ shared 3+char tokens
function nameMatches(ownerRaw, personName) {
  const toks = (s) => String(s ?? '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  const a = new Set(toks(ownerRaw)); const b = toks(personName);
  if (!a.size || !b.length) return false;
  return b.filter((t) => a.has(t)).length >= 2;
}

function classify(p, links) {
  const renterLinks = links.filter((l) => l.renter_flag);
  const cleanOwnerLinks = links.filter((l) => !l.renter_flag && (TIER[l.link_tier] ?? 0) > 0);
  const hasOwnerToken = (l) => Array.isArray(l.matching_flags)
    && l.matching_flags.some((t) => /likely owner|potential owner/i.test(String(t)));
  const renterWithOwnerToken = renterLinks.filter(hasOwnerToken);
  const renterAsOwnerVerdict = renterLinks.filter((l) => l.is_matching_property_as_owner === true);
  const bestClean = cleanOwnerLinks.sort((a, b) => (TIER[b.link_tier] ?? 0) - (TIER[a.link_tier] ?? 0))[0] ?? null;
  const hardBlock = renterLinks.length > 0 && cleanOwnerLinks.length === 0;
  const absentee = p?.mailing_state && p?.situs_state && p.mailing_state !== p.situs_state;
  const companyOwned = (p?.company_links ?? 0) > 0;
  // does a RENTER-flagged person carry the same name as the owner of record?
  const renterIsNamedOwner = p?.owner_name_raw && renterLinks.some((l) => nameMatches(p.owner_name_raw, l.person_name));
  // is the owner of record represented by ANY linked person name?
  const ownerNameLinked = p?.owner_name_raw && links.some((l) => nameMatches(p.owner_name_raw, l.person_name));

  let disposition; let reason;
  if (!hardBlock && cleanOwnerLinks.length > 0) {
    disposition = 'correct_person_suppression_owner_preserved';
    reason = `renter contact suppressed; clean owner link tier=${bestClean.link_tier} preserved`;
  } else if (hardBlock && renterIsNamedOwner && !companyOwned) {
    // strongest false-block evidence: the person we are blocking IS the named
    // owner of record (and it's not a company where a tenant differs from owner)
    disposition = 'probable_false_block';
    reason = 'renter-flagged person name matches the owner of record — the blocked person is the owner';
  } else if (hardBlock && companyOwned) {
    disposition = 'correct_hard_block';
    reason = 'company-owned; renter occupant correctly not treated as the signing owner (entity signs)';
  } else if (hardBlock && (renterWithOwnerToken.length > 0 || renterAsOwnerVerdict.length > 0)) {
    // conflicting vendor signals (renter flag + owner token/verdict) but no name
    // corroboration: genuinely ambiguous — the design chose renter-authoritative
    disposition = 'ambiguous_manual_review';
    reason = 'renter/owner collision (renter flag + owner token/verdict), no owner-name corroboration — design blocks renter-first, review recommended';
  } else if (hardBlock && p?.owner_hash && p?.owner_name_raw && !ownerNameLinked) {
    disposition = 'identity_defect';
    reason = 'ownership record names an owner but no linked person matches that name — link-coverage gap, not a true renter case';
  } else if (hardBlock) {
    disposition = 'correct_hard_block';
    reason = 'renter evidence, no owner token/verdict/name-match; renter is not the seller';
  } else {
    disposition = 'ambiguous_manual_review';
    reason = 'no renter-only hard block in this row (stratum overlap)';
  }

  return {
    property_id: p?.property_id, asset_class: p?.asset_class ?? '', situs_state: p?.situs_state ?? '',
    owner_hash: p?.owner_hash ?? '', owner_name: p?.owner_name_raw ?? '',
    occupancy_raw: p?.occupancy_raw ?? '',
    mailing_state: p?.mailing_state ?? '', mailing_vs_situs: absentee ? 'absentee' : 'local_or_unknown',
    company_owned: companyOwned, company_names: p?.company_names ?? '',
    total_links: links.length, renter_links: renterLinks.length,
    clean_owner_links: cleanOwnerLinks.length,
    best_clean_owner_tier: bestClean?.link_tier ?? 'none',
    renter_with_owner_token: renterWithOwnerToken.length,
    renter_is_matching_owner: renterAsOwnerVerdict.length,
    renter_name_matches_owner: renterIsNamedOwner ? 'yes' : 'no',
    owner_name_linked: ownerNameLinked ? 'yes' : 'no',
    ownership_tokens: JSON.stringify([...new Set(links.flatMap((l) => Array.isArray(l.matching_flags) ? l.matching_flags : []))].slice(0, 6)),
    identity_tiers: [...new Set(links.map((l) => l.identity_tier))].join('+'),
    clean_owner_preserved: cleanOwnerLinks.length > 0 ? 'yes' : 'no',
    final_route: hardBlock ? 'blocked_not_owner' : 'owner_outreach',
    disposition, reason,
  };
}

// Wilson 95% interval for a binomial proportion
function wilson(k, n) {
  if (n === 0) return { p: null, lo: null, hi: null };
  const z = 1.96; const phat = k / n;
  const denom = 1 + z * z / n;
  const centre = (phat + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))) / denom;
  return { p: round4(phat), lo: round4(Math.max(0, centre - half)), hi: round4(Math.min(1, centre + half)) };
}
const round4 = (x) => Math.round(x * 10000) / 10000;

function main() {
  const strata = {
    renter_only_hard_block: stratumIds("bool_or(renter_flag) and count(*) filter (where not renter_flag and link_tier<>'none')=0", 100),
    renter_owner_collision: jrows(`select json_build_object('property_id', property_id) from (
      select l.property_id from seller_engine.property_person_links l
      where l.renter_flag and l.raw->'matching_flags' @> '["Likely Owner"]'
      group by l.property_id order by md5(l.property_id) limit 100) q`).map((r) => r.property_id),
    clean_owner_preserved: stratumIds("bool_or(renter_flag) and count(*) filter (where not renter_flag and link_tier<>'none')>0", 100),
    company_owned_with_renter: jrows(`select json_build_object('property_id', property_id) from (
      select l.property_id from seller_engine.property_person_links l
      join seller_engine.property_company_links cl on cl.property_id=l.property_id
      where l.renter_flag group by l.property_id order by md5(l.property_id) limit 100) q`).map((r) => r.property_id),
    fallback_identity_renter_block: stratumIds("bool_or(renter_flag) and count(*) filter (where not renter_flag and link_tier<>'none')=0 and bool_or(false)", 100), // placeholder; refined below
    vendor_keyed_renter_block: [],
  };

  // fallback vs vendor-keyed renter blocks by the renter person's identity tier
  strata.fallback_identity_renter_block = jrows(`select json_build_object('property_id', property_id) from (
    select l.property_id from seller_engine.property_person_links l
    join seller_engine.people pe on pe.id=l.person_id
    where l.renter_flag and pe.identity_tier <> 'key'
      and l.property_id in (select property_id from seller_engine.property_person_links
        group by property_id having bool_or(renter_flag) and count(*) filter (where not renter_flag and link_tier<>'none')=0)
    group by l.property_id order by md5(l.property_id) limit 100) q`).map((r) => r.property_id);
  strata.vendor_keyed_renter_block = jrows(`select json_build_object('property_id', property_id) from (
    select l.property_id from seller_engine.property_person_links l
    join seller_engine.people pe on pe.id=l.person_id
    where l.renter_flag and pe.identity_tier = 'key'
      and l.property_id in (select property_id from seller_engine.property_person_links
        group by property_id having bool_or(renter_flag) and count(*) filter (where not renter_flag and link_tier<>'none')=0)
    group by l.property_id order by md5(l.property_id) limit 100) q`).map((r) => r.property_id);

  const rows = [];
  const byStratum = {};
  for (const [name, ids] of Object.entries(strata)) {
    const det = detail(ids).map((d) => ({ stratum: name, ...d }));
    byStratum[name] = det;
    rows.push(...det);
  }

  // false-block estimate over the RANDOM hard-block stratum
  const hb = byStratum.renter_only_hard_block;
  const dispCounts = (arr) => arr.reduce((m, r) => { m[r.disposition] = (m[r.disposition] ?? 0) + 1; return m; }, {});
  const hbCounts = dispCounts(hb);
  const falseBlocks = (hbCounts.probable_false_block ?? 0) + (hbCounts.identity_defect ?? 0);
  const fbCI = wilson(falseBlocks, hb.length);
  const ambiguous = hbCounts.ambiguous_manual_review ?? 0;
  const upperCI = wilson(falseBlocks + ambiguous, hb.length); // worst-case if all ambiguous are false

  // CSV
  const cols = ['stratum', 'property_id', 'asset_class', 'situs_state', 'owner_hash', 'owner_name',
    'occupancy_raw', 'mailing_state', 'mailing_vs_situs', 'company_owned', 'company_names',
    'total_links', 'renter_links', 'clean_owner_links', 'best_clean_owner_tier',
    'renter_with_owner_token', 'renter_is_matching_owner', 'renter_name_matches_owner', 'owner_name_linked', 'ownership_tokens', 'identity_tiers',
    'clean_owner_preserved', 'final_route', 'disposition', 'reason'];
  const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => {
    const v = r[c] ?? '';
    return `"${String(v).replaceAll('"', '""')}"`;
  }).join(','))).join('\n') + '\n';
  writeFileSync(join(PKG, 'SELLER_RENTER_GATE_AUDIT_SAMPLE.csv'), csv);

  const summary = {
    strata_sizes: Object.fromEntries(Object.entries(byStratum).map(([k, v]) => [k, v.length])),
    hard_block_dispositions: hbCounts,
    false_block_point: fbCI.p, false_block_ci95: [fbCI.lo, fbCI.hi],
    false_block_upper_if_all_ambiguous_false: upperCI.hi,
    dispositions_all: dispCounts(rows),
  };
  console.log(JSON.stringify(summary, null, 2));
  return { summary, byStratum, hb, fbCI, upperCI, hbCounts, ambiguous, falseBlocks };
}

export const result = main();
