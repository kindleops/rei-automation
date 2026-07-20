// Pilot bundle assembly: joins the staged partitions of the pilot batches
// (plus the prospects sidecar written by the streaming loader) into the
// feature-engine bundle shape. Same join semantics as backtest/demo.mjs, but
// batch-scoped and including every extended-feature input (classifications,
// companies, lien parties, owner index, identity tiers).
import { readFileSync, existsSync } from 'node:fs';
import { readPartition } from '../lib/store.mjs';
import { toMs } from '../lib/timeSafety.mjs';

const idx = (rows, key = 'property_id') => {
  const m = new Map();
  for (const r of rows) if (r[key]) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(r);
  return m;
};

export function assembleBundles({ batches, sidecarPath, personNames = null }) {
  const part = (table, fileSet) => (batches[fileSet] ? readPartition(table, batches[fileSet].id) : []);
  const props = part('properties', 'properties');
  const vals = idx(part('property_valuation_tax_snapshots', 'properties'));
  const loans = idx(part('property_loans', 'properties'));
  const checks = idx(part('loan_checksums', 'properties'));
  const owns = part('property_ownerships', 'properties');
  const clsByOwn = idx(part('ownership_classifications', 'properties'), 'ownership_id');
  const txns = idx(part('property_transactions', 'properties'));
  const fcs = idx(part('property_foreclosure_events', 'properties'));
  const liens = idx(part('property_liens', 'liens'));
  const lienById = new Map(part('property_liens', 'liens').map((l) => [l.id, l]));
  const lienParties = part('lien_parties', 'liens');
  const partiesByProp = new Map();
  for (const lp of lienParties) {
    const pid = lienById.get(lp.lien_id)?.property_id;
    if (pid) (partiesByProp.get(pid) ?? partiesByProp.set(pid, []).get(pid)).push(lp);
  }
  const companies = new Map(part('companies', 'companies').map((c) => [c.id, c]));
  const coLinks = idx(part('property_company_links', 'companies'));
  const phones = idx(part('contact_phones', 'contact_info'));
  const emails = idx(part('contact_emails', 'contact_info'));
  // versioned listing snapshots (listing-v1), keyed to canonical property_id
  const listing = batches.properties ? idx(readPartition('listing_snapshots', batches.properties.id)) : new Map();

  // prospects links come from the streaming loader's sidecar
  let links = new Map();
  let liveRate = null;
  if (sidecarPath && existsSync(sidecarPath)) {
    const rows = readFileSync(sidecarPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // V1.3: attach the person's canonical name so the owner resolver can test
    // owner-of-record name match (the sidecar was written without names)
    if (personNames) for (const r of rows) r.person_name = personNames.get(r.person_id) ?? null;
    links = idx(rows);
    liveRate = rows.length ? rows.filter((l) => l.likely_owner_scalar === true).length / rows.length : null;
  }

  // ownership classifications joined per property via ownership rows
  const clsByProp = new Map();
  for (const o of owns) {
    const cls = clsByOwn.get(o.id) ?? [];
    if (cls.length) (clsByProp.get(o.property_id) ?? clsByProp.set(o.property_id, []).get(o.property_id)).push(...cls);
  }

  // in-corpus owner index for F-035 (owner_hash siblings + last sale)
  const ownerIndex = new Map();
  for (const p of props) {
    const oh = p.raw_keep?.owner_hash;
    if (!oh) continue;
    const cur = (txns.get(p.id) ?? []).find((t) => t.event_role === 'current' && t.sale_date);
    (ownerIndex.get(oh) ?? ownerIndex.set(oh, []).get(oh)).push({
      property_id: p.id, last_sale_ms: cur ? toMs(cur.sale_date) : null,
    });
  }

  const bundles = props.map((p) => ({
    property: p,
    valuation: (vals.get(p.id) ?? [])[0] ?? {},
    loans: loans.get(p.id) ?? [],
    checksums: (checks.get(p.id) ?? [])[0] ?? null,
    liens: liens.get(p.id) ?? [],
    foreclosure: fcs.get(p.id) ?? [],
    transactions: txns.get(p.id) ?? [],
    links: links.get(p.id) ?? [],
    phones: phones.get(p.id) ?? [],
    emails: emails.get(p.id) ?? [],
    listing: listing.get(p.id) ?? [],
    classifications: clsByProp.get(p.id) ?? [],
    companies: (coLinks.get(p.id) ?? []).map((l) => companies.get(l.company_id)).filter(Boolean),
    companyLinks: coLinks.get(p.id) ?? [],
    lienParties: partiesByProp.get(p.id) ?? [],
    batchScalarLiveness: liveRate,
    ownerIndex,
  }));
  return { bundles, liveRate };
}
