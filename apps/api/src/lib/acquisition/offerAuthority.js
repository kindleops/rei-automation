/**
 * ONE offer-authority interface (Acquisition OS §42, §51–54, §75–76).
 *
 *   getAuthoritativeOffer(propertyId | ctx, deps?) ->
 *     { value, ceiling, offer, per_unit, engine, engine_version, execution_state,
 *       authorized, fresh, evidence_ids, reasons, computed_at, property_id,
 *       negotiation_authority, shadow_candidate }
 *
 * SOURCE TODAY: the production Decision Engine row (property_acquisition_scores,
 * engine 2.0.0), judged by the SAME two predicates Negotiation v3's
 * authorityFromScoreRow, Autopilot and the Composer use (evaluateOfferReadiness
 * + resolveValuationSpendability), so they can never disagree.
 *
 * MERGED V3 (behind ACQUISITION_ENGINE_V3_ENABLED + _ALLOW_PERSIST +
 * _SHADOW_MODE=false + the owner cutover market/lane, v3Authority.js): only a
 * row whose evidence.v3 was written in authority mode 'live' is read as the
 * merged engine. Shadow output (evidence.v3_shadow) is returned as
 * shadow_candidate for comparison and is NEVER money.
 *
 * Contract: tmp/acq-os/CONTRACT_offer_authority.md. Pure except the optional
 * score read (injectable deps.loadScore). Never writes.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { resolveValuationSpendability } from '@/lib/domain/seller-flow/valuation-offer-authority.js';
import { evaluateOfferReadiness, OFFER_POLICY_EPOCH, OFFER_READY_MAX_AGE_DAYS } from './offerReadiness.js';
import { resolveV3Authority } from './v3Authority.js';

export const OFFER_AUTHORITY_VERSION = 'offer-authority-1';
// Same source labels as negotiation-v3/authority.js AUTHORITY_SOURCES.
export const AUTHORITY_SOURCES = Object.freeze({
  PRODUCTION_ENGINE: 'acquisition_decision_engine',
  MERGED_ENGINE: 'offer_engine_v3_merged',
});
const EXECUTABLE = new Set(['SHADOW_MODE_READY', 'AUTO_RANGE_READY', 'AUTO_OFFER_READY', 'AUTO_CREATIVE_READY']);
export const SCORE_AUTHORITY_SELECT =
  'id,property_id,computed_at,decision_tier,recommended_cash_offer,minimum_acceptable_offer,valuation_mid,estimated_repairs,comp_count,confidence,valuation_confidence,evidence';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pos = (v) => (num(v) !== null && num(v) > 0 ? num(v) : null);
const clean = (v) => String(v ?? '').trim();
const round100 = (v) => (v === null ? null : Math.round(v / 100) * 100);

/** §54: per-unit math only with a positive price AND a valid integer unit count >= 2. */
export function perUnitOf({ value, ceiling, offer, units, identityConflict }) {
  const u = num(units);
  if (identityConflict || u === null || !Number.isInteger(u) || u < 2) return null;
  if (!pos(value) && !pos(ceiling) && !pos(offer)) return null;
  return {
    units: u,
    value: pos(value) ? round100(value / u) : null,
    ceiling: pos(ceiling) ? round100(ceiling / u) : null,
    offer: pos(offer) ? round100(offer / u) : null,
  };
}

function freshness(computedAt, nowMs) {
  const t = Date.parse(computedAt ?? '');
  if (!Number.isFinite(t)) return { fresh: false, reason: 'not_scored' };
  if (t < Date.parse(OFFER_POLICY_EPOCH)) return { fresh: false, reason: 'score_predates_current_policy' };
  if (nowMs - t > OFFER_READY_MAX_AGE_DAYS * 86_400_000) return { fresh: false, reason: 'score_stale' };
  return { fresh: true, reason: null };
}

/**
 * negotiation_bounds{market, lane, margin, max_opening_discount, n, evidence}
 * Config: ACQUISITION_ENGINE_V3_NEGOTIATION_BOUNDS = JSON array of cells (the
 * backtest writes tmp/acq-os/D/negotiation_bounds_*.json in this exact shape;
 * owner approves before it is set). Lookup: market x lane, then 'ALL' x lane,
 * then the defaults (13% margin / 25% max opening discount, n = 0).
 */
export const DEFAULT_NEGOTIATION_BOUNDS = Object.freeze({ margin: 0.13, max_opening_discount: 0.25 });
export function negotiationBoundsFor({ market = null, lane = null, env = process.env } = {}) {
  let cells = [];
  try { cells = JSON.parse(env?.ACQUISITION_ENGINE_V3_NEGOTIATION_BOUNDS ?? '[]'); } catch { cells = []; }
  const norm = (m) => clean(m).toLowerCase().replace(/\s+/g, ' ');
  const hit = (Array.isArray(cells) ? cells : []).find((c) => c.lane === lane && norm(c.market) === norm(market) && c.n >= 8)
    ?? (Array.isArray(cells) ? cells : []).find((c) => c.lane === lane && c.market === 'ALL' && c.n >= 8);
  if (hit) return { market, lane, margin: num(hit.margin), max_opening_discount: num(hit.max_opening_discount), n: hit.n, evidence: { ...(hit.evidence ?? {}), cell: `${hit.market}|${hit.lane}` } };
  return { market, lane, ...DEFAULT_NEGOTIATION_BOUNDS, n: 0, evidence: { basis: 'policy_default_no_approved_cell' } };
}

/** The merged-V3 view of a v3 block (live or shadow). Pure. */
export function mergedViewFromV3Block(v3, { score = {}, nowMs = Date.now(), live = false } = {}) {
  if (!v3 || typeof v3 !== 'object') return null;
  const oa = v3.offer_authorization ?? {};
  const merged = v3.merged ?? {};
  const units = num(merged.per_unit?.units) ?? num(merged.per_door_value?.units);
  const identityConflict = merged.asset_identity_conflict === true;
  const executable = EXECUTABLE.has(v3.execution_state);
  const offer = pos(oa.authorized_recommended_offer);
  const ceiling = pos(oa.authorized_buyer_ceiling);
  const value = pos(merged.investor_value) ?? pos(v3.reconciliation?.base_investor_exit);
  const f = freshness(score.computed_at, nowMs);
  const reasons = [];
  if (!live) reasons.push('shadow_only_not_money');
  if (!merged.offer_model) reasons.push('not_merged_engine_block');
  if (!executable) reasons.push(`execution_state:${v3.execution_state ?? 'unknown'}`);
  if (!offer || !ceiling) reasons.push('no_authorized_offer');
  if (identityConflict) reasons.push('asset_identity_conflict');
  if (!f.fresh) reasons.push(f.reason);
  for (const g of merged.gates ?? []) if (g.applied) reasons.push(`gate:${g.code}`);
  const authorized = live && Boolean(merged.offer_model) && executable && Boolean(offer && ceiling) && !identityConflict && f.fresh;
  const anyCeiling = ceiling ?? pos(oa.scenario_buyer_ceiling) ?? pos(v3.cash_offer?.buyer_ceiling);
  const anyOffer = offer ?? pos(oa.scenario_recommended_offer) ?? pos(v3.cash_offer?.recommended_cash_offer);
  const pu = perUnitOf({ value, ceiling: anyCeiling, offer: anyOffer, units, identityConflict });
  const band = merged.per_door_value && pu ? { low: pos(merged.per_door_value.low), high: pos(merged.per_door_value.high), label: merged.per_door_value.label ?? null } : null;
  return {
    value,
    investor_price: pos(merged.investor_value) ?? value,
    ceiling: anyCeiling,
    offer: anyOffer,
    offer_is_scenario: !offer,
    minimum: pos(v3.cash_offer?.minimum_acceptable_offer),
    lane: merged.lane ?? merged.offer_lane ?? null,
    confidence_grade: merged.confidence_grade ?? null,
    fallback_rung: merged.rung ?? null,
    fallback_rung_name: merged.rung_name ?? null,
    ring: merged.ring ?? null,
    radius_miles: merged.radius_miles ?? null,
    margin: merged.margin_pct != null ? { pct: merged.margin_pct, source: merged.margin_source ?? null, key: merged.margin_key ?? null } : null,
    per_unit: pu ? { ...pu, units_source: merged.identity?.units_source ?? null, band } : null,
    engine: AUTHORITY_SOURCES.MERGED_ENGINE,
    engine_version: `${clean(v3.engine_version)}/${clean(v3.formula_version)}`,
    execution_state: v3.execution_state ?? null,
    authorized,
    fresh: f.fresh,
    identity_conflict: identityConflict,
    lane: merged.offer_lane ?? null,
    evidence_ids: (merged.evidence_ids?.length ? merged.evidence_ids : (v3.universes?.LOCAL_INVESTOR_VALUE?.comps ?? []).map((c) => clean(c.comp_id))).filter(Boolean).slice(0, 12),
    comps: (v3.universes?.LOCAL_INVESTOR_VALUE?.comps ?? []).slice(0, 12).map((c) => ({
      id: clean(c.comp_id) || null, sale_price: num(c.price), distance_miles: num(c.distance_miles), sale_date: c.sold_on ?? null, source: clean(c.source).toLowerCase(), units: num(c.units),
    })),
    reasons,
  };
}

/** Negotiation v3 authority shape (CONTRACT_negotiation.md §3) from a merged view. */
function negotiationAuthorityFromMerged(view, score) {
  return {
    source: AUTHORITY_SOURCES.MERGED_ENGINE,
    engine_version: view.engine_version,
    score_version: `ade_${view.engine_version}`,
    snapshot_id: clean(score?.evidence?.immutable_snapshot_id ?? score?.id) || null,
    property_id: clean(score?.property_id) || null,
    computed_at: score?.computed_at ?? null,
    ok: view.authorized,
    fresh: view.fresh,
    reasons: view.reasons,
    ceiling: view.ceiling,
    recommended: view.offer,
    // The merged value is ALREADY as-is: repairs are embedded and must never be
    // subtracted again (no fair-floor = value - repairs).
    value_as_is: view.value,
    valuation_mid: view.value,
    estimated_repairs: num(score?.estimated_repairs),
    repairs_embedded_in_value: true,
    units: view.per_unit?.units ?? null,
    asset_family: clean(score?.evidence?.subject?.asset_family).toLowerCase() || null,
    asset_identity_conflict: view.identity_conflict,
    comps: view.comps,
  };
}

/** Production v2 verdict: offer-ready AND spendable (the §76 OFFER READY predicate). */
function productionVerdict(score, { now, spendability }) {
  const readiness = evaluateOfferReadiness(score, { now });
  const reasons = [];
  let spend = null;
  if (readiness.ready) {
    const v3q = score?.evidence?.v3?.qualification
      ?? (score?.v3_has_anchor != null ? { anchors: { has_anchor: score.v3_has_anchor === true || score.v3_has_anchor === 'true' } } : null);
    spend = spendability || resolveValuationSpendability({ valuation: score, v3_qualification: v3q });
    if (spend?.spendable !== true) reasons.push('not_spendable', `not_spendable:${clean(spend?.reason) || 'unknown'}`);
  } else {
    reasons.push('not_offer_ready', readiness.reason);
    if (readiness.sanity?.reasons) reasons.push(...readiness.sanity.reasons.map((r) => `sanity:${r}`));
  }
  const fresh = !['score_predates_current_policy', 'score_stale', 'not_scored'].includes(readiness.reason);
  return { ok: readiness.ready && spend?.spendable === true, fresh, reasons, readiness, spendability: spend };
}

/** Pure: the authoritative offer from a score row. */
export function authoritativeOfferFromScore(score = null, { now = Date.now(), spendability = null, env = process.env } = {}) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const ev = score?.evidence ?? {};
  // Merged V3 is authoritative ONLY if the row was written live AND the flags +
  // cutover still say live for this subject today (a revoked cutover reverts to v2).
  const liveBlock = ev.v3 && ev.v3.authority_mode === 'live' && ev.v3.merged ? ev.v3 : null;
  const stillLive = liveBlock
    ? resolveV3Authority({ subject: { market: ev.subject?.market, asset_family: ev.subject?.asset_family, units: ev.subject?.normalized_features?.units }, env }).mode === 'live'
    : false;
  const shadowView = ev.v3_shadow ? mergedViewFromV3Block(ev.v3_shadow, { score, nowMs, live: false }) : null;

  if (liveBlock && stillLive) {
    const view = mergedViewFromV3Block(liveBlock, { score, nowMs, live: true });
    return {
      authority_version: OFFER_AUTHORITY_VERSION,
      property_id: clean(score?.property_id) || null,
      computed_at: score?.computed_at ?? null,
      // NEVER BLANK (owner 2026-10-07): numbers always present; money only when authorized.
      value: view.value,
      investor_price: view.investor_price,
      ceiling: view.ceiling,
      offer: view.offer,
      per_unit: view.per_unit,
      lane: view.lane,
      confidence_grade: view.confidence_grade,
      fallback_rung: view.fallback_rung,
      ring: view.ring,
      radius_miles: view.radius_miles,
      margin: view.margin,
      money_allowed: view.authorized,
      engine: view.engine,
      engine_version: view.engine_version,
      execution_state: view.execution_state,
      authorized: view.authorized,
      fresh: view.fresh,
      evidence_ids: view.evidence_ids,
      reasons: view.reasons,
      negotiation_authority: negotiationAuthorityFromMerged(view, score),
      negotiation_bounds: negotiationBoundsFor({ market: ev.subject?.market ?? null, lane: view.lane, env }),
      shadow_candidate: null,
    };
  }

  // Production v2 (today).
  const verdict = productionVerdict(score, { now: nowMs, spendability });
  const units = num(ev.subject?.normalized_features?.units);
  const identityConflict = ev.subject?.asset_identity_conflict === true || score?.asset_identity_conflict === true;
  const ceiling = pos(score?.mao ?? ev.offer_calculation?.effective_authorized_ceiling);
  const offer = pos(score?.recommended_cash_offer);
  const value = pos(score?.valuation_mid);
  const consistent = ceiling !== null && offer !== null && value !== null && offer <= ceiling && ceiling <= value;
  const ok = verdict.ok && consistent && !identityConflict;
  const reasons = [...verdict.reasons];
  if (!score) reasons.unshift('no_authority');
  if (verdict.ok && !consistent) reasons.push('authority_inconsistent_fields');
  if (identityConflict) reasons.push('asset_identity_conflict');
  const neg = {
    source: AUTHORITY_SOURCES.PRODUCTION_ENGINE,
    engine_version: clean(ev.engine?.version) || null,
    score_version: score ? `ade_${clean(ev.engine?.version) || 'unknown'}` : null,
    snapshot_id: clean(ev.immutable_snapshot_id ?? score?.id) || null,
    property_id: clean(score?.property_id) || null,
    computed_at: score?.computed_at ?? null,
    ok,
    fresh: verdict.fresh,
    reasons,
    ceiling,
    recommended: offer,
    value_as_is: null,
    valuation_mid: value,
    estimated_repairs: num(score?.estimated_repairs),
    repairs_embedded_in_value: false,
    units,
    asset_family: clean(ev.subject?.asset_family).toLowerCase() || null,
    asset_identity_conflict: identityConflict,
    comps: (ev.selected_comps ?? []).slice(0, 12).map((c) => ({ id: clean(c?.comp_id ?? c?.id) || null, sale_price: num(c?.sale_price), distance_miles: num(c?.distance_miles), sale_date: c?.sale_date ?? c?.sold_date ?? null, source: clean(c?.source).toLowerCase(), units: num(c?.units ?? c?.units_count) })),
  };
  return {
    authority_version: OFFER_AUTHORITY_VERSION,
    property_id: clean(score?.property_id) || null,
    computed_at: score?.computed_at ?? null,
    // NEVER BLANK: the v2 numbers are always returned; money only when authorized.
    value,
    investor_price: null, // v2 has no separate investor-price universe
    ceiling,
    offer,
    per_unit: perUnitOf({ value, ceiling, offer, units: ev.subject?.asset_family === 'multifamily' ? units : null, identityConflict }),
    lane: ev.subject?.asset_family === 'multifamily' ? (units >= 5 ? 'mf5' : units >= 2 ? 'mf24' : 'other') : ev.subject?.asset_family ? 'sfr' : null,
    confidence_grade: null,
    fallback_rung: 'prod_v2',
    margin: null,
    money_allowed: neg.ok === true,
    engine: AUTHORITY_SOURCES.PRODUCTION_ENGINE,
    engine_version: clean(ev.engine?.version) || null,
    execution_state: clean(score?.decision_tier).toUpperCase() || null,
    authorized: neg.ok === true,
    fresh: neg.fresh === true,
    evidence_ids: (ev.selected_comps ?? []).map((c) => clean(c?.comp_id ?? c?.id)).filter(Boolean).slice(0, 12),
    reasons: neg.reasons ?? [],
    negotiation_authority: neg,
    negotiation_bounds: negotiationBoundsFor({ market: ev.subject?.market ?? null, lane: ev.subject?.asset_family === 'multifamily' ? (units >= 5 ? 'mf5' : units >= 2 ? 'mf24' : 'other') : ev.subject?.asset_family ? 'sfr' : null, env }),
    shadow_candidate: shadowView,
  };
}

/**
 * getAuthoritativeOffer(propertyId | { propertyId, score }, deps?)
 * deps.loadScore(propertyId) -> score row (injectable); deps.supabase / deps.db.
 */
export async function getAuthoritativeOffer(input, deps = {}) {
  const ctx = typeof input === 'object' && input !== null ? input : { propertyId: input };
  const propertyId = clean(ctx.propertyId ?? ctx.property_id ?? ctx.score?.property_id);
  let score = ctx.score ?? null;
  if (!score && propertyId) {
    const load = deps.loadScore ?? (async (id) => {
      const db = deps.supabase ?? deps.db ?? getDefaultSupabaseClient();
      const { data, error } = await db.from('property_acquisition_scores').select(SCORE_AUTHORITY_SELECT).eq('property_id', id).maybeSingle();
      if (error) throw error;
      return data ?? null;
    });
    score = await load(propertyId);
  }
  const out = authoritativeOfferFromScore(score, { now: deps.now ?? Date.now(), spendability: ctx.spendability ?? null, env: deps.env ?? process.env });
  if (!score) out.property_id = propertyId || null;
  return out;
}

export default getAuthoritativeOffer;
