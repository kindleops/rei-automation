/**
 * Acquisition Engine V3 — transaction qualification (mission §4).
 *
 * Scores each candidate transaction 0–100 and assigns ACCEPT / REVIEW /
 * QUARANTINE / EXCLUDE against INDEPENDENT anchors (subject AVM/assessment,
 * lane PPSF/PPU bounds, lane price ceiling) and the cluster-level package /
 * duplicate signals. An extreme transaction can NEVER establish the range that
 * validates itself — anchors are derived from the subject + lane only.
 *
 * This is the layer that neutralizes the $332.5M Austin duplex comp and the
 * $30.19M Caldwell package cluster. Pure & deterministic.
 */

import {
  QUALIFICATION_STATUS as ST,
  STATUS_SEVERITY,
  FAMILY_PPSF_BOUNDS,
  FAMILY_PPU_BOUNDS,
  LANE_PRICE_CEILING_USD,
  LANE_FAMILY,
  COMP_ANCHOR_MAX_MULTIPLE,
  COMP_ANCHOR_MIN_MULTIPLE,
  NOMINAL_PRICE_MAX_USD,
  num,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';
import { classifyAssetLane, laneCompatible, resolveUnitCount } from './assetClassification.js';
import {
  buildTransactions,
  clusterTransactions,
  effectiveSampleSize,
  normalizeMoney,
} from './transactionClustering.js';

/** Derive comp-independent plausibility anchors for the subject (mission §4). */
export function deriveAnchors(subject = {}) {
  const cls = subject.canonical_asset_lane
    ? { lane: subject.canonical_asset_lane, family: LANE_FAMILY[subject.canonical_asset_lane] }
    : classifyAssetLane(subject);
  const lane = cls.lane;
  const family = LANE_FAMILY[lane] ?? 'UNKNOWN';

  const estimated = num(subject.estimated_value);
  const listing = num(subject.mls_current_listing_price) ?? num(subject.listing_price);
  const assessed = num(subject.assessed_total_value) ?? num(subject.assessed_total);
  const candidates = [estimated, listing, assessed].filter((v) => v !== null && v > 0);
  const anchorMid = estimated ?? listing ?? assessed ?? null;
  const anchorLow = candidates.length ? Math.min(...candidates) : anchorMid;
  const anchorHigh = candidates.length ? Math.max(...candidates) : anchorMid;

  return {
    lane,
    family,
    anchor_mid: anchorMid,
    anchor_low: anchorLow,
    anchor_high: anchorHigh,
    has_anchor: anchorMid !== null && anchorMid > 0,
    anchor_sources: [
      estimated !== null ? 'estimated_value' : null,
      listing !== null ? 'listing_price' : null,
      assessed !== null ? 'assessed_total_value' : null,
    ].filter(Boolean),
    ppsf_bounds: FAMILY_PPSF_BOUNDS[family] ?? null,
    ppu_bounds: FAMILY_PPU_BOUNDS[family] ?? null,
    lane_ceiling: LANE_PRICE_CEILING_USD[lane] ?? LANE_PRICE_CEILING_USD.UNKNOWN,
  };
}

const STATUS_SCORE_CAP = { ACCEPT: 100, REVIEW: 70, QUARANTINE: 25, EXCLUDE: 0 };
const REASON_PENALTY = { REVIEW: 15, QUARANTINE: 50, EXCLUDE: 100 };

function escalate(current, next) {
  return STATUS_SEVERITY[next] > STATUS_SEVERITY[current] ? next : current;
}

/**
 * Qualify a single annotated transaction against the subject anchors.
 * @param {object} subject
 * @param {object} tx  annotated transaction (from clusterTransactions)
 * @param {object} anchors  output of deriveAnchors
 */
export function qualifyTransaction(subject, tx, anchors) {
  const reasons = [];
  let status = ST.ACCEPT;
  const add = (sev, code, detail) => {
    reasons.push({ code, severity: sev, ...(detail ? { detail } : {}) });
    status = escalate(status, sev);
  };

  const consideration = normalizeMoney(tx.consideration);
  const compCls = classifyAssetLane(tx.raw ?? tx);
  const compLane = compCls.lane;
  const sqft = num(tx.raw?.building_square_feet) ?? num(tx.raw?.sqft) ?? null;
  const units = resolveUnitCount(tx.raw ?? {});

  // --- pricing eligibility (V3 loader): non-sale / foreclosure / nominal /
  // IDENTITY_UNRESOLVED transactions are excluded from PRICING (they may still
  // feed demand signals), without weakening any other gate. Undefined => no-op.
  if (tx.raw?.v3_pricing_eligible === false) {
    add(ST.EXCLUDE, 'not_pricing_eligible', tx.raw?.channel_reasons ?? null);
  }

  // --- price presence / nominal -----------------------------------------
  if (consideration === null) {
    add(ST.EXCLUDE, 'missing_or_invalid_consideration');
  } else if (consideration <= NOMINAL_PRICE_MAX_USD) {
    add(ST.QUARANTINE, 'nominal_consideration', consideration);
  }

  // --- duplicate parcel row (one cluster ≠ many comps) ------------------
  if (tx.is_duplicate) add(ST.EXCLUDE, 'duplicate_parcel_row');

  // --- package consideration broadcast across parcels -------------------
  if (tx.is_package) {
    add(ST.QUARANTINE, 'package_consideration_unresolved', {
      distinct_parcels: tx.cluster_distinct_parcels,
      distinct_zips: tx.cluster_distinct_zips,
      package_probability: tx.package_sale_probability,
    });
  }

  // --- asset-lane compatibility -----------------------------------------
  const compat = laneCompatible(anchors.lane, compLane, { allowFallback: true });
  if (!compat.compatible) add(ST.QUARANTINE, 'asset_lane_mismatch', { subject: anchors.lane, comp: compLane });
  else if (compat.fallback) add(ST.REVIEW, 'fallback_lane', { subject: anchors.lane, comp: compLane });

  // --- absolute lane price ceiling --------------------------------------
  if (consideration !== null && consideration > anchors.lane_ceiling) {
    add(ST.QUARANTINE, 'price_exceeds_lane_ceiling', {
      consideration,
      ceiling: anchors.lane_ceiling,
    });
  }

  // --- price per sqft plausibility --------------------------------------
  let ppsf = null;
  if (consideration !== null && sqft && sqft > 0 && anchors.ppsf_bounds) {
    ppsf = consideration / sqft;
    if (ppsf > anchors.ppsf_bounds.max) {
      add(ST.QUARANTINE, 'implausible_ppsf_high', { ppsf: round(ppsf, 1), max: anchors.ppsf_bounds.max });
    } else if (ppsf < anchors.ppsf_bounds.min) {
      add(ST.REVIEW, 'low_ppsf', { ppsf: round(ppsf, 1), min: anchors.ppsf_bounds.min });
    }
  }

  // --- price per unit plausibility (small-multi / MF) -------------------
  let ppu = null;
  if (consideration !== null && units && units > 0 && anchors.ppu_bounds) {
    ppu = consideration / units;
    if (ppu > anchors.ppu_bounds.max) {
      add(ST.QUARANTINE, 'implausible_ppu_high', { ppu: roundMoney(ppu), max: anchors.ppu_bounds.max });
    } else if (ppu < anchors.ppu_bounds.min) {
      add(ST.REVIEW, 'low_ppu', { ppu: roundMoney(ppu), min: anchors.ppu_bounds.min });
    }
  }

  // --- ratio to subject anchor ------------------------------------------
  let anchorRatio = null;
  if (consideration !== null && anchors.has_anchor) {
    anchorRatio = consideration / anchors.anchor_mid;
    if (anchorRatio > COMP_ANCHOR_MAX_MULTIPLE) {
      add(ST.QUARANTINE, 'price_vs_anchor_high', { ratio: round(anchorRatio, 2), max: COMP_ANCHOR_MAX_MULTIPLE });
    } else if (anchorRatio < COMP_ANCHOR_MIN_MULTIPLE) {
      add(ST.REVIEW, 'price_vs_anchor_low', { ratio: round(anchorRatio, 2), min: COMP_ANCHOR_MIN_MULTIPLE });
    }
  }

  // --- score ------------------------------------------------------------
  let score = 100;
  for (const r of reasons) score -= REASON_PENALTY[r.severity] ?? 0;
  score = clamp(score, 0, 100);
  score = Math.min(score, STATUS_SCORE_CAP[status]);

  return {
    status,
    score: round(score, 1),
    reasons,
    comp_lane: compLane,
    lane_match: compat,
    consideration,
    ppsf: ppsf === null ? null : round(ppsf, 2),
    ppu: ppu === null ? null : roundMoney(ppu),
    anchor_ratio: anchorRatio === null ? null : round(anchorRatio, 3),
    cluster_id: tx.cluster_id ?? null,
  };
}

/**
 * Full comp qualification pipeline: cluster → qualify → dedupe to one
 * representative per cluster → compute correlation-aware sample size.
 *
 * @returns audit-grade qualification result (mission §4, §25).
 */
export function qualifyComps(subject = {}, rawComps = []) {
  const anchors = deriveAnchors(subject);
  const txs = buildTransactions(rawComps);
  const { clusters } = clusterTransactions(txs);

  const evaluated = txs.map((tx) => ({ tx, q: qualifyTransaction(subject, tx, anchors) }));

  // Collapse accepted rows to one representative per cluster (highest score).
  const bestByCluster = new Map();
  const collapsed = [];
  const accepted = [];
  const rejected = [];

  for (const item of evaluated) {
    if (item.q.status !== ST.ACCEPT) {
      rejected.push(item);
      continue;
    }
    const cid = item.q.cluster_id ?? `solo:${item.tx._idx}`;
    const incumbent = bestByCluster.get(cid);
    if (!incumbent || item.q.score > incumbent.q.score) {
      if (incumbent) collapsed.push(incumbent);
      bestByCluster.set(cid, item);
    } else {
      collapsed.push(item);
    }
  }
  for (const item of bestByCluster.values()) accepted.push(item);
  for (const item of collapsed) {
    rejected.push({ ...item, redundant: true, q: { ...item.q, reasons: [{ code: 'collapsed_into_cluster_representative', severity: 'REVIEW' }] } });
  }

  const ess = effectiveSampleSize(clusters);
  const acceptedClusters = new Set(accepted.map((a) => a.q.cluster_id)).size;
  const quarantined = evaluated.filter((e) => e.q.status === ST.QUARANTINE);
  const excluded = evaluated.filter((e) => e.q.status === ST.EXCLUDE);

  const anomalyFlags = [];
  if (clusters.some((c) => c.is_package)) anomalyFlags.push('PACKAGE_CONSIDERATION_DETECTED');
  if (ess.duplicate_row_count > 0) anomalyFlags.push('DUPLICATE_PARCEL_ROWS');
  if (quarantined.some((q) => q.q.reasons.some((r) => /implausible_pp|price_exceeds|price_vs_anchor_high/.test(r.code)))) {
    anomalyFlags.push('IMPLAUSIBLE_COMP_PRICE');
  }
  if (quarantined.some((q) => q.q.reasons.some((r) => r.code === 'asset_lane_mismatch'))) {
    anomalyFlags.push('ASSET_LANE_MISMATCH');
  }
  if (acceptedClusters === 0) anomalyFlags.push('NO_INDEPENDENT_COMPS');

  return {
    subject_lane: anchors.lane,
    anchors,
    accepted: accepted.map((a) => ({
      cluster_id: a.q.cluster_id,
      address: a.tx.address,
      zip: a.tx.zip,
      consideration: a.q.consideration,
      comp_lane: a.q.comp_lane,
      score: a.q.score,
      ppsf: a.q.ppsf,
      ppu: a.q.ppu,
      anchor_ratio: a.q.anchor_ratio,
      raw: a.tx.raw, // original comp row, for the engine to re-score qualified comps
    })),
    rejected: rejected.map((r) => ({
      address: r.tx.address,
      zip: r.tx.zip,
      consideration: r.q.consideration,
      comp_lane: r.q.comp_lane,
      status: r.q.status,
      reasons: r.q.reasons.map((x) => x.code),
      // Additive (Item 5B): lets the income models draw confidence-reduced,
      // adjustment-supported cross-unit / adjacent-band fallback evidence from
      // REVIEW-classed permitted-fallback comps. Never used for autonomy.
      score: r.q.score,
      ppsf: r.q.ppsf,
      ppu: r.q.ppu,
      raw: r.tx.raw,
    })),
    clusters_summary: clusters,
    sample: {
      raw_rows: ess.raw_rows,
      distinct_clusters: ess.distinct_clusters,
      independent_clusters: ess.independent_clusters,
      accepted_clusters: acceptedClusters,
      effective_sample_size: Math.min(ess.effective_sample_size, acceptedClusters || ess.effective_sample_size),
      package_cluster_count: ess.package_cluster_count,
      parcels_in_package_clusters: ess.parcels_in_package_clusters,
      duplicate_row_count: ess.duplicate_row_count,
      quarantined_count: quarantined.length,
      excluded_count: excluded.length,
      accepted_count: accepted.length,
    },
    anomaly_flags: anomalyFlags,
  };
}
