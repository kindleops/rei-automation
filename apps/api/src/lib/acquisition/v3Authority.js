/**
 * ACQUISITION ENGINE V3 — authority mode (shadow vs live) and per-market cutover.
 *
 * Before 2026-10-07 ACQUISITION_ENGINE_V3_ALLOW_PERSIST and _SHADOW_MODE were
 * read nowhere: turning ACQUISITION_ENGINE_V3_ENABLED on would have overwritten
 * live valuation_mid / offers in property_acquisition_scores and nulled the
 * offers of every non-executable state. This module is the ONE place that
 * decides where V3 output may go:
 *
 *   off     ENABLED is false. V3 is not computed. Production byte-identical.
 *   shadow  ENABLED is true but any cutover condition is missing. V2 runs on its
 *           own comps and owns every live column; V3 runs beside it and is
 *           written ONLY to evidence.v3_shadow (never evidence.v3, which live
 *           readers - negotiation-v3/authority, seller-flow, comp intelligence -
 *           already treat as authoritative).
 *   live    ENABLED and ALLOW_PERSIST are true, SHADOW_MODE is explicitly false,
 *           AND the subject's market and lane are in the owner cutover lists.
 *
 * Cutover config (env, default empty = nothing is live):
 *   ACQUISITION_ENGINE_V3_CUTOVER_MARKETS  'Dallas, TX;Houston, TX;Tampa, FL'  (';' or '|')
 *   ACQUISITION_ENGINE_V3_CUTOVER_LANES    'sfr' (default) | 'sfr;mf5'   (mf24 is never live: human review)
 * No master switch: each condition is separate and recorded.
 */

import { readFeatureFlag } from './modelConstants.js';

export const V3_AUTHORITY_MODES = Object.freeze({ OFF: 'off', SHADOW: 'shadow', LIVE: 'live' });
export const V3_CUTOVER_LANES = Object.freeze(['sfr', 'mf5']);

const split = (v) => String(v ?? '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function readV3CutoverConfig(env = process.env) {
  const lanesRaw = split(env?.ACQUISITION_ENGINE_V3_CUTOVER_LANES);
  return {
    markets: split(env?.ACQUISITION_ENGINE_V3_CUTOVER_MARKETS).map(norm),
    lanes: (lanesRaw.length ? lanesRaw : ['sfr']).map(norm).filter((l) => V3_CUTOVER_LANES.includes(l)),
  };
}

/** sfr | mf24 | mf5 | other — from the normalized engine subject (real units only). */
export function subjectOfferLane(subject = {}) {
  const family = String(subject.asset_family ?? '').toLowerCase();
  const units = Number(subject.units ?? subject.units_count);
  const realUnits = Number.isFinite(units) && units > 0 ? units : null;
  if (family === 'multifamily') {
    if (realUnits !== null && realUnits >= 5) return 'mf5';
    if (realUnits !== null && realUnits >= 2) return 'mf24';
    return 'other'; // MF label with no real count (or units <= 1): identity conflict, never live
  }
  if (family === 'residential' || family === 'single_family' || family === 'sfr') return 'sfr';
  return 'other';
}

/**
 * @returns {{ mode: 'off'|'shadow'|'live', reasons: string[], flags: object, market: string|null, lane: string, cutover: object }}
 */
export function resolveV3Authority({ v3Enabled, subject = {}, env = process.env } = {}) {
  const enabled = v3Enabled ?? readFeatureFlag('ACQUISITION_ENGINE_V3_ENABLED', env);
  const flags = {
    ACQUISITION_ENGINE_V3_ENABLED: Boolean(enabled),
    ACQUISITION_ENGINE_V3_SHADOW_MODE: readFeatureFlag('ACQUISITION_ENGINE_V3_SHADOW_MODE', env),
    ACQUISITION_ENGINE_V3_ALLOW_PERSIST: readFeatureFlag('ACQUISITION_ENGINE_V3_ALLOW_PERSIST', env),
  };
  const cutover = readV3CutoverConfig(env);
  const market = subject.market ?? subject.raw?.market ?? null;
  const lane = subjectOfferLane(subject);
  if (!flags.ACQUISITION_ENGINE_V3_ENABLED) {
    return { mode: V3_AUTHORITY_MODES.OFF, reasons: ['v3_disabled'], flags, market, lane, cutover };
  }
  const reasons = [];
  if (flags.ACQUISITION_ENGINE_V3_SHADOW_MODE) reasons.push('shadow_mode_flag_on');
  if (!flags.ACQUISITION_ENGINE_V3_ALLOW_PERSIST) reasons.push('persist_not_allowed');
  if (!market || !cutover.markets.includes(norm(market))) reasons.push('market_not_in_cutover');
  if (!cutover.lanes.includes(lane)) reasons.push(`lane_not_in_cutover:${lane}`);
  return {
    mode: reasons.length ? V3_AUTHORITY_MODES.SHADOW : V3_AUTHORITY_MODES.LIVE,
    reasons: reasons.length ? reasons : ['owner_cutover_market_and_lane'],
    flags,
    market,
    lane,
    cutover,
  };
}
