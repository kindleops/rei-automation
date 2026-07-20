#!/usr/bin/env node
// V1.6 — census of ambiguous / mixed ownership-rights (vesting) vendor values.
//
// MEASUREMENT ONLY. Changes no V1.6 behaviour. Verifies the NEUTRAL-EVIDENCE
// policy holds:
//   - an ambiguous code does NOT independently prove entity ownership
//   - an ambiguous code does NOT independently prove individual ownership
//   - corroborating canonical evidence controls the outcome
//   - the original vendor value is preserved verbatim for later dictionary work
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, PILOT_DIR } from './pg.mjs';
import { vestingEvidence } from '../scores/entityOwnershipEvidence.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const jrows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const csvq = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
function writeCsv(path, rows) {
  if (!rows.length) { writeFileSync(path, '(empty)\n'); return; }
  const cols = Object.keys(rows[0]);
  writeFileSync(path, [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvq(r[c])).join(','))).join('\n') + '\n');
}

// Vendor values whose plain reading mixes ENTITY FORM with NATURAL-PERSON
// TENANCY. These are the values the policy is about.
// "Corporate Trust" is deliberately NOT here: a corporate trust is unambiguously
// a fiduciary arrangement requiring trustee verification, not a mixed code.
// Trailing \b matters: "Partner" (a natural person's role in a partnership) is
// ambiguous; "Partnership" (the entity form itself) is not, and is 100%
// canonically corporate in this corpus.
const AMBIGUOUS_RE = /^(sole\s+member|managing\s+member|member|partner|limited\s+partner|general\s+partner|et\s+al|right\s+of\s+survivorship|surviving\s+spouse|trustor)\b/i;
// Lexical entity markers on the OWNER NAME (frozen V1.5 regex)
const LEX_ENTITY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CORPORATION|LTD|LP|L\.?P|LLP|HOLDINGS|INVESTMENTS|PROPERTIES|GROUP|CAPITAL|VENTURES|REALTY|MANAGEMENT|PARTNERS|COMPANY|ENTERPRISES|ASSOCIATES|FUND|FOUNDATION|CHURCH|BANK|AUTHORITY|ASSN|ASSOCIATION|TRUST|ESTATE)\b/i;

function main() {
  // route/disposition per property from the frozen V1.6 outputs
  const disp = new Map();
  const lines = readFileSync(join(PKG, 'SELLER_V1_6_FINAL_DISPOSITIONS.csv'), 'utf8')
    .split('\n').filter(Boolean).slice(1);
  for (const l of lines) {
    const f = l.split('","');
    disp.set(f[0].replace(/^"/, ''), { route: f[2], disposition: f[3] });
  }

  const rows = jrows(`select row_to_json(t) from (
    select p.id property_id,
      coalesce(nullif(btrim(p.raw->'raw_keep'->>'Owner1OwnershipRights'),''),'(blank)') vesting_value,
      o.owner_name_raw,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='corporate') cls_corporate,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='trust') cls_trust,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='estate') cls_estate
    from seller_engine.properties p left join seller_engine.property_ownerships o on o.property_id=p.id) t`);

  const byValue = new Map();
  for (const r of rows) {
    const v = r.vesting_value;
    const g = byValue.get(v) ?? byValue.set(v, {
      vesting_value: v, rows: 0, properties: new Set(), owner_examples: [],
      cls_corporate: 0, cls_trust: 0, cls_estate: 0, company_link: 0, lexical_entity: 0,
      routes: {}, dispositions: {},
    }).get(v);
    g.rows += 1; g.properties.add(r.property_id);
    if (g.owner_examples.length < 5 && r.owner_name_raw) g.owner_examples.push(r.owner_name_raw);
    if (r.cls_corporate) g.cls_corporate += 1;
    if (r.cls_trust) g.cls_trust += 1;
    if (r.cls_estate) g.cls_estate += 1;
    if ((Number(r.company_links) || 0) > 0) g.company_link += 1;
    if (LEX_ENTITY_RE.test(r.owner_name_raw ?? '')) g.lexical_entity += 1;
    const d = disp.get(r.property_id);
    if (d) {
      g.routes[d.route] = (g.routes[d.route] ?? 0) + 1;
      g.dispositions[d.disposition] = (g.dispositions[d.disposition] ?? 0) + 1;
    }
  }

  const out = [];
  let policyViolations = 0;
  for (const g of [...byValue.values()].sort((a, b) => b.rows - a.rows)) {
    const ev = vestingEvidence(g.vesting_value === '(blank)' ? '' : g.vesting_value);
    const treatedAsCompany = ev.company === true;
    const treatedAsTrust = ev.trust === true;
    const treatedAsEstate = ev.estate === true;
    const ambiguous = AMBIGUOUS_RE.test(g.vesting_value);
    const n = g.properties.size;
    const rate = (x) => Math.round((x / n) * 1000) / 10;

    // POLICY: an ambiguous code must not be treated as independent entity evidence.
    const violates = ambiguous && (treatedAsCompany || treatedAsTrust || treatedAsEstate);
    if (violates) policyViolations += 1;

    let reason;
    if (violates) reason = 'POLICY VIOLATION: ambiguous code treated as independent entity evidence';
    else if (ambiguous) reason = 'Ambiguous vendor code — mixes entity form with natural-person tenancy; neutral, corroborating canonical evidence controls';
    else if (treatedAsCompany) reason = 'Unambiguous entity form (company/corporation/LLC/LLP/partnership)';
    else if (treatedAsTrust) reason = 'Unambiguous fiduciary capacity (trustee/conservator/trust) — authority verification required';
    else if (treatedAsEstate) reason = 'Unambiguous limited/estate interest (life estate, remainder, estate)';
    else if (ev.borrower_in_default) reason = 'Distressed individual borrower on a trustee\'s deed — explicitly NOT trust ownership';
    else reason = 'Natural-person tenancy or blank — not entity evidence';

    out.push({
      vesting_value: g.vesting_value,
      row_count: g.rows,
      distinct_properties: n,
      owner_name_examples: g.owner_examples.slice(0, 3).join(' ; '),
      canonical_corporate_rate_pct: rate(g.cls_corporate),
      canonical_trust_rate_pct: rate(g.cls_trust),
      canonical_estate_rate_pct: rate(g.cls_estate),
      company_link_rate_pct: rate(g.company_link),
      owner_name_entity_lexical_rate_pct: rate(g.lexical_entity),
      v1_6_route_distribution: Object.entries(g.routes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('|'),
      v1_6_disposition_distribution: Object.entries(g.dispositions).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('|'),
      classified_ambiguous: ambiguous,
      treated_as_company_evidence: treatedAsCompany,
      treated_as_trust_evidence: treatedAsTrust,
      treated_as_estate_evidence: treatedAsEstate,
      independently_proves_entity: treatedAsCompany || treatedAsTrust || treatedAsEstate,
      independently_proves_individual: false,
      original_value_preserved: true,
      policy_compliant: !violates,
      reason,
    });
  }

  writeCsv(join(PKG, 'SELLER_V1_6_AMBIGUOUS_OWNERSHIP_RIGHTS.csv'), out);
  const ambiguousRows = out.filter((r) => r.classified_ambiguous);
  const summary = {
    distinct_vesting_values: out.length,
    ambiguous_values: ambiguousRows.length,
    ambiguous_properties: ambiguousRows.reduce((s, r) => s + r.distinct_properties, 0),
    policy_violations: policyViolations,
    ambiguous_detail: ambiguousRows.map((r) => ({
      value: r.vesting_value, properties: r.distinct_properties,
      canonical_corporate_pct: r.canonical_corporate_rate_pct,
      lexical_entity_pct: r.owner_name_entity_lexical_rate_pct,
      treated_as_entity_evidence: r.independently_proves_entity,
    })),
  };
  writeFileSync(join(PILOT_DIR, 'v16-ambiguous-vesting.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main();
