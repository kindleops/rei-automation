#!/usr/bin/env node
// V1.6 — audit EVERY property that moved INTO entity-authority resolution that
// was not in the original 3,775 company-link defect population.
//
// Each must have valid CURRENT-ownership evidence. Any case without it is a
// defect and is flagged. MEASUREMENT ONLY — changes no behaviour.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql, PILOT_DIR } from './pg.mjs';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { qualifyEntityOwnership } from '../scores/entityOwnershipEvidence.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANY_BATCH = 'batch_58091ee03d7c43cc467090b1';
const SCORING_TS = '2026-07-19T00:00:00Z';
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
const LEX_ENTITY_RE = /\b(LLC|INC|CORP|CORPORATION|LTD|LP|LLP|HOLDINGS|INVESTMENTS|PROPERTIES|GROUP|CAPITAL|VENTURES|REALTY|MANAGEMENT|PARTNERS|COMPANY|ENTERPRISES|ASSOCIATES|FUND|FOUNDATION|CHURCH|BANK|AUTHORITY|ASSN|ASSOCIATION)\b/i;
const LEX_TRUST_RE = /\b(trust|trustee|revocable|irrevocable)\b/i;
const LEX_ESTATE_RE = /\b(estate\s+of|estate|deceased|heirs?|decedent)\b/i;

function main() {
  const props = new Map(jrows(`select row_to_json(t) from (
    select p.id property_id, p.situs_state, o.owner_name_raw, o.mailing_state,
      nullif(btrim(p.raw->'raw_keep'->>'owner_2_name'), '') owner_two_name,
      p.raw->'raw_keep'->>'Owner1OwnershipRights' vesting_raw,
      (select count(*) from seller_engine.property_company_links cl where cl.property_id=p.id) company_links,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification in ('corporate','trust','estate')) cls_entity,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='corporate') cls_corporate,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='trust') cls_trust,
      exists(select 1 from seller_engine.ownership_classifications c join seller_engine.property_ownerships oo on oo.id=c.ownership_id where oo.property_id=p.id and c.classification='estate') cls_estate,
      exists(select 1 from seller_engine.property_liens l where l.property_id=p.id and l.lifecycle_class='probate_life_event') probate,
      exists(select 1 from seller_engine.property_foreclosure_events f where f.property_id=p.id and f.stage='reo') reo
    from seller_engine.properties p left join seller_engine.property_ownerships o on o.property_id=p.id) t`).map((r) => [r.property_id, r]));

  const companyLinks = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select p.id property_id, sr.payload->>'company_name' company_name, sr.payload->>'company_source' company_source,
      nullif(sr.payload->>'matched_party','') matched_party, nullif(sr.payload->>'matching_type','') matching_type,
      nullif(sr.payload->>'transaction_id','') transaction_id, sr.payload->>'owner_status' owner_status
    from seller_engine.source_records sr
    join seller_engine.properties p on p.vendor_property_id = sr.payload->>'property_id'
    where sr.import_batch_id='${COMPANY_BATCH}') t`)) {
    (companyLinks.get(r.property_id) ?? companyLinks.set(r.property_id, []).get(r.property_id)).push(r);
  }
  const transactions = new Map();
  for (const r of jrows(`select row_to_json(t) from (
    select property_id, vendor_transaction_id, event_role, document_type_group, sale_date
    from seller_engine.property_transactions) t`)) {
    (transactions.get(r.property_id) ?? transactions.set(r.property_id, []).get(r.property_id)).push(r);
  }
  const personLinks = new Map();
  for (const l of jrows(`select row_to_json(t) from (
    select l.property_id, l.person_id, pe.identity_tier, pe.full_name person_name, l.renter_flag, l.link_tier, l.is_matching_property_as_owner,
      (l.raw->'matching_flags') matching_flags, coalesce(ph.cnt,0) phones, coalesce(em.cnt,0) emails
    from seller_engine.property_person_links l join seller_engine.people pe on pe.id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_phones where phone_e164 is not null and coalesce(do_not_call,false)=false and coalesce(never_call,false)=false group by person_id) ph on ph.person_id=l.person_id
    left join (select person_id, count(*) cnt from seller_engine.contact_emails where coalesce(blocked,false)=false group by person_id) em on em.person_id=l.person_id) t`)) {
    (personLinks.get(l.property_id) ?? personLinks.set(l.property_id, []).get(l.property_id)).push(l);
  }

  const rows = []; let unsupported = 0; let uncorroborated = 0;
  for (const [pid, p] of props) {
    const cands = (personLinks.get(pid) ?? []).map((l) => {
      const tokens = Array.isArray(l.matching_flags) ? l.matching_flags : [];
      const ns = nameMatch(p.owner_name_raw, l.person_name);
      return { id: l.person_id, person_name: l.person_name, identity_tier: l.identity_tier, link_tier: l.link_tier ?? 'none',
        renter_flag: l.renter_flag === true, owner_token: tokens.some((t) => /likely owner|potential owner/i.test(String(t))),
        owner_verdict: l.is_matching_property_as_owner === true, name_match: ns.name_match, surname_match: ns.surname_match,
        exact_key_owner: l.is_matching_property_as_owner === true && l.identity_tier === 'key' && ns.name_match,
        mailing_match: p.mailing_state && p.situs_state ? p.mailing_state === p.situs_state : false,
        phones: Number(l.phones) || 0, emails: Number(l.emails) || 0 };
    });
    const clinks = companyLinks.get(pid) ?? [];
    const txns = transactions.get(pid) ?? [];
    const q0 = txns.filter((t) => t.document_type_group && t.document_type_group !== 'administrative_recording');
    const cur = q0.filter((t) => t.event_role === 'current');
    const latest = (cur.length ? cur : q0).slice().sort((a, b) => String(b.sale_date ?? '').localeCompare(String(a.sale_date ?? '')))[0] ?? null;

    const propV15 = { property_id: pid, owner_name: p.owner_name_raw, owner_mailing_state: p.mailing_state, situs_state: p.situs_state,
      is_entity: (p.company_links ?? 0) > 0 || p.cls_entity === true, is_trust: p.cls_trust === true, is_estate: p.cls_estate === true,
      probate_evidence: p.probate === true, reo: p.reo === true, owner_two_name: p.owner_two_name, vesting_raw: p.vesting_raw };
    const v15 = resolveCanonical(propV15, cands).execution_route;
    if (v15 === 'entity_authority_resolution') continue;   // only NEW authority routes

    const q = qualifyEntityOwnership({
      owner_name: p.owner_name_raw, owner_status: clinks.find((c) => c.owner_status)?.owner_status ?? null,
      vesting_raw: p.vesting_raw, canonical_corporate: p.cls_corporate === true,
      canonical_trust: p.cls_trust === true, canonical_estate: p.cls_estate === true,
      probate_evidence: p.probate === true, company_links: clinks,
      transactions_by_id: Object.fromEntries(txns.map((t) => [t.vendor_transaction_id, t])),
      latest_qualifying_transfer_id: latest?.vendor_transaction_id ?? null, scoring_timestamp: SCORING_TS,
    });
    const v16 = resolveCanonical({ ...propV15, is_entity: q.is_entity_input, is_trust: q.is_trust, is_estate: q.is_estate }, cands).execution_route;
    if (v16 !== 'entity_authority_resolution') continue;

    // is this route supported by CURRENT-ownership evidence?
    const supported = q.confirmed_entity_ownership === true
      && q.authority_evidence_grade !== 'lexical_authority_review'
      && q.authority_evidence_grade !== 'none';
    if (!supported) unsupported += 1;
    const name = p.owner_name_raw ?? '';
    // Corroboration is reported SEPARATELY from §5 sufficiency. A route can be
    // sanctioned by §5 rule 2 (vesting) while resting on a single vendor field
    // that no other source supports and that the owner-of-record name
    // contradicts. That combination is weak and must be visible, not hidden
    // behind a bare "supported = true".
    const canonicalCorroboration = p.cls_corporate === true || p.cls_trust === true
      || p.cls_estate === true || p.probate === true;
    const linkCorroboration = q.company_link_classification.some((c) => c.ownership_relevance === 'establishes_current_entity_ownership');
    const lexicalCorroboration = LEX_ENTITY_RE.test(name) || LEX_TRUST_RE.test(name) || LEX_ESTATE_RE.test(name);
    const corroborated = canonicalCorroboration || linkCorroboration || lexicalCorroboration;
    const ownerReadsIndividual = !lexicalCorroboration;
    if (!corroborated) uncorroborated += 1;

    rows.push({
      property_id: pid,
      owner_of_record: name,
      v1_5_route: v15,
      v1_6_route: v16,
      qualifying_ownership_evidence: q.qualifying_evidence.join('|'),
      authority_evidence_grade: q.authority_evidence_grade,
      vesting_value: p.vesting_raw ?? '',
      vesting_grants_company: q.vesting.company === true,
      vesting_grants_trust: q.vesting.trust === true,
      vesting_grants_estate: q.vesting.estate === true,
      canonical_corporate_classification: p.cls_corporate === true,
      canonical_trust_classification: p.cls_trust === true,
      canonical_estate_classification: p.cls_estate === true,
      probate_life_event_lien: p.probate === true,
      company_link_count: Number(p.company_links) || 0,
      company_relationship_classes: q.company_link_classes.join('|'),
      company_link_establishes_ownership: q.company_link_classification.some((c) => c.ownership_relevance === 'establishes_current_entity_ownership'),
      lexical_entity_marker: LEX_ENTITY_RE.test(name),
      lexical_trust_marker: LEX_TRUST_RE.test(name),
      lexical_estate_marker: LEX_ESTATE_RE.test(name),
      lexical_only: q.lexical_authority_review === true,
      confirmed_entity_ownership: q.confirmed_entity_ownership,
      route_supported_by_current_ownership_evidence: supported,
      corroborating_canonical_evidence: canonicalCorroboration,
      corroborating_company_link_evidence: linkCorroboration,
      corroborating_lexical_evidence: lexicalCorroboration,
      any_corroboration: corroborated,
      owner_name_reads_individual: ownerReadsIndividual,
      evidence_strength: !supported ? 'none'
        : corroborated ? 'corroborated_multi_source' : 'single_uncorroborated_vendor_field',
      flagged_for_review: supported && !corroborated,
      justification: !supported
        ? 'DEFECT: routed to entity authority without current-ownership evidence.'
        : corroborated
          ? `Justified: ${q.qualifying_evidence.join(' + ')} establishes CURRENT entity/trust/estate ownership, corroborated by an independent source (grade ${q.authority_evidence_grade}).`
          : `SANCTIONED BUT UNCORROBORATED: the only qualifying evidence is ${q.qualifying_evidence.join(' + ')} — a single vendor ownership-rights field with no canonical classification, no company link, and an owner-of-record name that reads as an individual. Permitted by V1.6 rule 2 (authoritative vesting) and fail-closed (blocks outreach, cannot send), but the weakest admissible basis. Recommend deed/vesting document pull to confirm or clear.`,
    });
  }

  writeCsv(join(PKG, 'SELLER_V1_6_NEW_AUTHORITY_ROUTES_AUDIT.csv'), rows);
  const summary = { new_authority_routes: rows.length, unsupported_defects: unsupported,
    uncorroborated_single_source: uncorroborated,
    corroborated: rows.length - uncorroborated,
    by_grade: rows.reduce((m, r) => { m[r.authority_evidence_grade] = (m[r.authority_evidence_grade] ?? 0) + 1; return m; }, {}),
    by_v1_5_route: rows.reduce((m, r) => { m[r.v1_5_route] = (m[r.v1_5_route] ?? 0) + 1; return m; }, {}),
    by_vesting: rows.reduce((m, r) => { m[r.vesting_value || '(blank)'] = (m[r.vesting_value || '(blank)'] ?? 0) + 1; return m; }, {}) };
  writeFileSync(join(PILOT_DIR, 'v16-new-authority-routes.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main();
