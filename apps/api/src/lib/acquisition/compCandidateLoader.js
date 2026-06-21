/**
 * Acquisition Engine V3 — production comp candidate loader (mission Item 5A §1-§3).
 *
 * Deterministic, identity-aware, batch (no N+1):
 *   1) one RPC call for candidates
 *   2) one batch SELECT on buyer_comp_raw_v2 (by comp_id == raw.id) for identity
 *   3) one batch SELECT on buyer_entities_v2 (by normalized buyer name) for buy-box
 *   4) normalize each candidate into the shared contract
 *
 * Drops the V2 blind `buyer_comp_properties_v2` ZIP pull (the contamination /
 * cross-lane vector). All primitives are injectable for deterministic tests.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { num, clean } from './modelConstants.js';
import { normalizeEntityName } from './transactionClustering.js';
import { normalizeCandidate } from './compIdentityEnrichment.js';

const RAW_IDENTITY_SELECT = [
  'id', 'property_id', 'apn_parcel_id', 'owner_name', 'owner_1_name', 'is_corporate_owner',
  'out_of_state_owner', 'owner_address_full', 'document_type', 'last_sale_doc_type',
  'recording_date', 'sale_price', 'mls_sold_price', 'subdivision_name', 'school_district_name',
  'effective_year_built', 'total_loan_amt', 'total_loan_balance', 'total_loan_payment', 'lienholder_name',
].join(',');

const ENTITY_SELECT = [
  'buyer_key', 'normalized_buyer_name', 'markets_active', 'purchase_count',
  'avg_purchase_price', 'preferred_asset_classes',
].join(',');

function eligibilityWindow(subject) {
  const fam = subject?.asset_family;
  if (fam === 'land') return { radius: 20, months: 48 };
  if (fam === 'commercial') return { radius: 15, months: 48 };
  if (fam === 'multifamily') return { radius: 7, months: 36 };
  return { radius: 4, months: 30 };
}

/**
 * @returns {Promise<{ candidates: object[], diagnostics: object }>}
 */
export async function loadV3CompCandidates(rawSubject, deps = {}) {
  const db = deps.db ?? getDefaultSupabaseClient();
  const subject = rawSubject ?? {};
  const propertyId = clean(subject.property_id ?? subject.raw?.property_id);
  const win = eligibilityWindow(subject);
  const t0 = Date.now();

  // 1) candidates (RPC) — required source, fail loud.
  const runRpc =
    deps.runRpc ??
    (async () => {
      const { data, error } = await db.rpc('get_comp_candidates_for_subject', {
        p_subject_property_id: propertyId,
        p_radius_miles: win.radius,
        p_months_back: win.months,
        p_limit: deps.limit ?? 100,
      });
      if (error) throw error;
      return data ?? [];
    });
  const candidates = await runRpc(subject);

  if (!candidates.length) {
    return {
      candidates: [],
      diagnostics: {
        candidate_count: 0, identity_enriched: 0, unresolved: 0, buyer_resolved: 0,
        channel_resolved: 0, join_collisions: 0, unmatched: 0,
        source_latency_ms: Date.now() - t0, retrieval_tier: 'rpc_empty',
      },
    };
  }

  // 2) batch identity (one query, by comp_id == buyer_comp_raw_v2.id).
  const compIds = [...new Set(candidates.map((c) => clean(c.comp_id || c.id)).filter(Boolean))];
  const fetchRawIdentity =
    deps.fetchRawIdentity ??
    (async (ids) => {
      const { data, error } = await db.from('buyer_comp_raw_v2').select(RAW_IDENTITY_SELECT).in('id', ids);
      if (error) throw error;
      return data ?? [];
    });
  const rawRows = compIds.length ? await fetchRawIdentity(compIds) : [];
  const rawById = new Map();
  let collisions = 0;
  for (const r of rawRows) {
    const key = clean(r.id);
    if (rawById.has(key)) collisions += 1;
    rawById.set(key, r);
  }

  // 3) batch buyer entities (one query, by normalized name).
  const names = [...new Set(rawRows.map((r) => normalizeEntityName(r.owner_name || r.owner_1_name)).filter(Boolean))];
  const fetchEntities =
    deps.fetchEntities ??
    (async (ns) => {
      if (!ns.length) return [];
      const { data, error } = await db.from('buyer_entities_v2').select(ENTITY_SELECT).in('normalized_buyer_name', ns);
      if (error) return []; // optional enrichment
      return data ?? [];
    });
  const entityRows = names.length ? await fetchEntities(names) : [];
  const entityByName = new Map(entityRows.map((e) => [clean(e.normalized_buyer_name), e]));

  // 4) normalize.
  let identityEnriched = 0;
  let buyerResolved = 0;
  let channelResolved = 0;
  let unmatched = 0;
  const normalized = candidates.map((c) => {
    const raw = rawById.get(clean(c.comp_id || c.id)) ?? null;
    if (raw) identityEnriched += 1; else unmatched += 1;
    const nm = raw ? normalizeEntityName(raw.owner_name || raw.owner_1_name) : '';
    const entity = nm ? entityByName.get(nm) ?? null : null;
    const out = normalizeCandidate(c, raw, entity);
    if (out.buyer_name_clean) buyerResolved += 1;
    if (out.v3_channel) channelResolved += 1;
    return out;
  });

  return {
    candidates: normalized,
    diagnostics: {
      candidate_count: candidates.length,
      identity_enriched: identityEnriched,
      unresolved: normalized.filter((n) => n.identity_unresolved).length,
      buyer_resolved: buyerResolved,
      channel_resolved: channelResolved,
      entity_matched: normalized.filter((n) => n.matched_buyer_entity).length,
      join_collisions: collisions,
      unmatched,
      pricing_eligible: normalized.filter((n) => n.v3_pricing_eligible).length,
      source_latency_ms: Date.now() - t0,
      retrieval_tier: `rpc_radius_${win.radius}mi_${win.months}mo`,
      query_count: 3,
    },
  };
}
