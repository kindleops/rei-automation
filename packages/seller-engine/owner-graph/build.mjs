// Deterministic cross-batch owner graph (Phase 4 §6). Operates over the
// canonical staged partitions of APPROVED corpus batches (here: the pilot
// batch — Corpus V1 is not yet frozen, so scope is explicitly single-batch and
// labeled in_corpus_scope). Identity is NEVER established by name alone:
//   - person nodes merge only on vendor individual_key (identity_tier='key')
//   - owner_hash groups vendor-computed owner fingerprints across properties
//   - name-only agreement produces CANDIDATE merges in a conflict report,
//     never accepted edges
// Every node/edge carries explicit confidence and evidence.
import { readPartition, writeReport, writePartition } from '../lib/store.mjs';
import { deterministicId } from '../lib/hash.mjs';
import { toMs } from '../lib/timeSafety.mjs';

const DAY = 86_400_000;

const idxBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) if (r[key] != null) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(r);
  return m;
};

// Owner-node key precedence (never name-only):
//   1. individual_key (vendor person identity) — highest confidence
//   2. owner_hash (vendor owner fingerprint) — property-side owner identity
//   3. company id (entity owner) — for company-owned properties
// A property with only a name and no key/hash yields an UNRESOLVED owner node.
export function buildOwnerGraph({ batches, asOf }) {
  const props = batches.flatMap((b) => readPartition('properties', b));
  const owns = batches.flatMap((b) => readPartition('property_ownerships', b));
  const vals = idxBy(batches.flatMap((b) => readPartition('property_valuation_tax_snapshots', b)), 'property_id');
  const loans = idxBy(batches.flatMap((b) => readPartition('property_loans', b)), 'property_id');
  const txns = idxBy(batches.flatMap((b) => readPartition('property_transactions', b)), 'property_id');
  const fcs = idxBy(batches.flatMap((b) => readPartition('property_foreclosure_events', b)), 'property_id');
  const liens = idxBy(batches.flatMap((b) => readPartition('property_liens', b)), 'property_id');
  const coLinks = idxBy(batches.flatMap((b) => readPartition('property_company_links', b)), 'property_id');
  const asOfMs = toMs(asOf) ?? Date.now();

  const ownByProp = idxBy(owns, 'property_id');
  const ownerNodes = new Map();  // owner_key -> node
  const conflicts = [];

  const getNode = (key, kind, seedName) => {
    let n = ownerNodes.get(key);
    if (!n) {
      n = { owner_key: key, owner_kind: kind, names: new Set(), properties: [],
        confidence: kind === 'individual_key' ? 'high' : kind === 'owner_hash' ? 'medium' : kind === 'company' ? 'medium' : 'low',
        evidence: kind };
      ownerNodes.set(key, n);
    }
    if (seedName) n.names.add(seedName);
    return n;
  };

  for (const p of props) {
    const own = (ownByProp.get(p.id) ?? [])[0] ?? {};
    const oh = own.owner_hash ?? p.raw_keep?.owner_hash ?? null;
    const name = own.owner_name_raw ?? p.raw_keep?.owner_name ?? null;
    const companyLinked = (coLinks.get(p.id) ?? []);
    // choose the owner-identity key by precedence
    let key; let kind;
    if (oh) { key = `oh:${oh}`; kind = 'owner_hash'; }
    else if (companyLinked.length) { key = `co:${companyLinked[0].company_id}`; kind = 'company'; }
    else if (name) { key = `unresolved:${deterministicId('own_unres', name, p.situs_state ?? '')}`; kind = 'unresolved_name_only'; }
    else { key = `unresolved:${p.id}`; kind = 'unresolved_none'; }

    const node = getNode(key, kind, name);
    const cur = (txns.get(p.id) ?? []).find((t) => t.event_role === 'current' && t.sale_date);
    const val = (vals.get(p.id) ?? [])[0] ?? {};
    const distress = distressState(p, val, fcs.get(p.id) ?? [], liens.get(p.id) ?? [], asOfMs);
    node.properties.push({
      property_id: p.id, situs_state: p.situs_state ?? null,
      current_sale_ms: cur ? toMs(cur.sale_date) : null,
      estimated_value: num(val.estimated_value), estimated_equity: num(val.estimated_equity),
      loan_balance: (loans.get(p.id) ?? []).filter((l) => l.slot_class === 'current_recorded')
        .reduce((s, l) => s + (num(l.estimated_balance) ?? 0), 0),
      ownership_state: 'current',   // single-batch: all rows are current-observation
      distressed: distress.distressed, distress_reasons: distress.reasons,
    });
  }

  // post-pass: a name appearing across MORE THAN ONE owner key is a possible
  // merge — surfaced as a candidate for review, NEVER auto-merged (no name-only
  // identity). This catches hash-vs-hash and hash-vs-unresolved collisions.
  const keysByName = new Map();
  for (const n of ownerNodes.values()) {
    for (const nm of n.names) {
      const norm = nm.trim().toUpperCase();
      (keysByName.get(norm) ?? keysByName.set(norm, new Set()).get(norm)).add(n.owner_key);
    }
  }
  for (const [name, keys] of keysByName) {
    if (keys.size > 1) {
      conflicts.push({ kind: 'name_shared_across_owner_keys', name, keys: [...keys], resolution: 'candidate_only_not_merged' });
    }
  }

  // roll each node up into portfolio + liquidation signals
  const graphNodes = [];
  for (const n of ownerNodes.values()) {
    const holdings = n.properties.length;
    const equity = n.properties.reduce((s, p) => s + (p.estimated_equity ?? 0), 0);
    const debt = n.properties.reduce((s, p) => s + (p.loan_balance ?? 0), 0);
    const value = n.properties.reduce((s, p) => s + (p.estimated_value ?? 0), 0);
    const distressed = n.properties.filter((p) => p.distressed);
    const recentDisps = n.properties.filter((p) => p.current_sale_ms && asOfMs - p.current_sale_ms < 730 * DAY);
    graphNodes.push({
      owner_key: n.owner_key, owner_kind: n.owner_kind, confidence: n.confidence,
      distinct_names: n.names.size, name_sample: [...n.names].slice(0, 3),
      portfolio_holdings: holdings,
      portfolio_equity: Math.round(equity), portfolio_debt: Math.round(debt),
      portfolio_value: Math.round(value),
      portfolio_leverage: value > 0 ? Math.round((debt / value) * 1000) / 1000 : null,
      simultaneous_distressed_holdings: distressed.length,
      systemic_distress: distressed.length >= 2,   // IX-13 owner-level event marker
      disposition_velocity_2y: recentDisps.length,
      liquidation_indicator: holdings >= 2 && recentDisps.length >= 1,
      states: [...new Set(n.properties.map((p) => p.situs_state).filter(Boolean))],
      property_ids: n.properties.map((p) => p.property_id),
    });
  }

  const resolved = graphNodes.filter((n) => !n.owner_kind.startsWith('unresolved'));
  const report = {
    as_of: asOf, scope: 'in_corpus_single_batch (Corpus V1 not frozen)',
    batches, owner_nodes: graphNodes.length,
    by_kind: countBy(graphNodes, 'owner_kind'),
    by_confidence: countBy(graphNodes, 'confidence'),
    resolved_owner_nodes: resolved.length,
    multi_property_owners: graphNodes.filter((n) => n.portfolio_holdings >= 2).length,
    owners_with_systemic_distress: graphNodes.filter((n) => n.systemic_distress).length,
    owners_with_liquidation_signal: graphNodes.filter((n) => n.liquidation_indicator).length,
    name_merge_candidates_not_merged: conflicts.length,
    note: 'no owner merged on name alone; owner_hash/individual_key/company are the only identity keys; cross-batch expansion requires frozen Corpus V1',
  };
  writeReport('owner_graph', report);
  writeReport('owner_graph_conflicts', { as_of: asOf, candidate_merges: conflicts.slice(0, 500), total: conflicts.length });
  writePartition('owner_graph_nodes', batches[0] ?? 'graph', graphNodes);
  return { report, nodes: graphNodes, conflicts };
}

function distressState(p, val, fcs, liens, asOfMs) {
  const reasons = [];
  if (val.tax_delinquent === true) reasons.push('tax_delinquent');
  if (fcs.some((f) => f.stage && f.stage !== 'none' && f.stage !== 'reo')) reasons.push('foreclosure');
  const openLiens = liens.filter((l) => ['creation', 'judgment', 'litigation'].includes(l.lifecycle_class)
    && toMs(l.filing_date ?? l.recording_date) !== null).length;
  if (openLiens > 0) reasons.push('open_liens');
  return { distressed: reasons.length > 0, reasons };
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const countBy = (arr, k) => arr.reduce((m, r) => { m[r[k]] = (m[r[k]] ?? 0) + 1; return m; }, {});

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const state = JSON.parse(fs.readFileSync(new URL('../var/pilot/state.json', import.meta.url), 'utf8'));
  const asOf = state.stages.score?.as_of ?? new Date().toISOString();
  const { report } = buildOwnerGraph({ batches: [state.batches.properties.id], asOf });
  console.log(JSON.stringify(report, null, 2));
}
