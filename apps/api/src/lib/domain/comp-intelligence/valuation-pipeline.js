import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase/client.js';

const MODEL_VERSION = 'comp_intelligence_valuation_v1';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values = []) {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0
    ? Math.round((valid[mid - 1] + valid[mid]) / 2)
    : valid[mid];
}

export function deriveValuationState({ subject, discovery, valuation }) {
  if (!subject) return { state: 'blocked_missing_subject', label: 'Blocked: missing subject' };
  if (!subject.is_subject_resolved && discovery?.is_market_fallback) {
    if (!discovery?.counts?.total) {
      return {
        state: 'blocked_insufficient_evidence',
        label: 'Blocked: insufficient evidence',
        detail: subject.coordinate_failure_reason,
      };
    }
    return {
      state: 'ready_with_limitations',
      label: 'Ready with limitations',
      detail: 'Market-level search — exact-distance ranking unavailable',
    };
  }
  if (!discovery?.counts?.included) {
    if (!discovery?.counts?.total) {
      return { state: 'blocked_insufficient_evidence', label: 'Blocked: insufficient evidence' };
    }
    return { state: 'scoring_comps', label: 'Scoring comps' };
  }
  if (!valuation?.arv) return { state: 'valuing', label: 'Valuing' };
  if (valuation?.data_gaps?.length) {
    return { state: 'ready_with_limitations', label: 'Ready with limitations' };
  }
  return { state: 'ready', label: 'Ready' };
}

export function computeValuationOutputs(subjectContract, discovery) {
  const subject = {
    asset_type: subjectContract?.asset_type?.value,
    units: subjectContract?.units?.value,
    square_feet: subjectContract?.square_feet?.value,
    condition: subjectContract?.condition?.value,
    estimated_value: subjectContract?.estimated_value?.value,
    repair_estimate: subjectContract?.repair_estimate?.value,
  };

  const included = (discovery?.included ?? []).filter((c) => c.sale_list_price);
  const dataGaps = [];
  if (!subject.square_feet && subject.asset_type !== 'multifamily') {
    dataGaps.push('subject_square_feet_missing');
  }
  if (subject.asset_type === 'multifamily' && !subject.units) {
    dataGaps.push('subject_units_missing');
  }
  if (!included.length) dataGaps.push('no_included_comps');
  if (discovery?.is_market_fallback) dataGaps.push('market_fallback_search');

  if (!included.length) {
    return {
      model_version: MODEL_VERSION,
      arv: null,
      as_is_value: null,
      repair_estimate: subject.repair_estimate,
      confidence: 0,
      data_gaps: dataGaps,
      warnings: ['Insufficient included comps for ARV'],
      outputs: {},
    };
  }

  const totalScore = included.reduce((sum, c) => sum + (c.similarity_score ?? 0), 0);
  let weightedPpsf = 0;
  let weightedPpu = 0;
  included.forEach((c) => {
    const weight = totalScore > 0 ? (c.similarity_score ?? 0) / totalScore : 0;
    weightedPpsf += (c.ppsf ?? 0) * weight;
    weightedPpu += (c.ppu ?? 0) * weight;
  });

  const prices = included.map((c) => c.sale_list_price).filter(Boolean).sort((a, b) => a - b);
  let arv = null;
  if (subject.asset_type === 'multifamily' && subject.units && weightedPpu > 0) {
    arv = Math.round((weightedPpu * subject.units) / 1000) * 1000;
  } else if (subject.square_feet && weightedPpsf > 0) {
    arv = Math.round((weightedPpsf * subject.square_feet) / 1000) * 1000;
  } else if (prices.length) {
    arv = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length / 1000) * 1000;
  }

  const confidenceBase = totalScore / (included.length * 100);
  const countBoost = Math.min(0.1, included.length * 0.015);
  const penalty =
    (discovery?.expanded_criteria?.confidence_penalty ?? 0) / 100 +
    (dataGaps.includes('subject_square_feet_missing') ? 0.15 : 0) +
    (dataGaps.includes('market_fallback_search') ? 0.2 : 0);
  const confidence = Math.round(Math.max(0, Math.min(98, (confidenceBase + countBoost - penalty) * 100)));

  const repairEstimate =
    subject.repair_estimate ??
    (subject.square_feet
      ? subject.square_feet *
        (subject.condition === 'Poor' ? 45 : subject.condition === 'Fair' ? 25 : 15)
      : null);

  const retailCeiling = prices.length ? prices[prices.length - 1] : null;
  const investorReality = arv ? Math.round(arv * 0.85) : null;
  const targetOffer = arv && repairEstimate ? Math.round(arv * 0.7 - repairEstimate) : null;
  const maxAllowableOffer = arv && repairEstimate ? Math.round(arv * 0.75 - repairEstimate) : null;

  return {
    model_version: MODEL_VERSION,
    arv,
    as_is_value: arv && repairEstimate ? Math.max(0, arv - repairEstimate) : null,
    repair_estimate: repairEstimate,
    confidence,
    data_gaps: dataGaps,
    warnings: dataGaps.map((gap) => `Data gap: ${gap}`),
    outputs: {
      retail_ceiling: {
        value: retailCeiling,
        formula: 'max included comp sale price',
        confidence,
      },
      investor_reality: {
        value: investorReality,
        formula: 'ARV * 0.85',
        confidence,
      },
      weighted_ppsf: {
        value: Math.round(weightedPpsf),
        formula: 'score-weighted mean PPSF of included comps',
        confidence,
      },
      weighted_ppu: {
        value: Math.round(weightedPpu),
        formula: 'score-weighted mean PPU of included comps',
        confidence,
      },
      median_evidence: {
        value: median(prices),
        formula: 'median included comp sale price',
        confidence,
      },
      target_offer: {
        value: targetOffer,
        formula: 'ARV * 0.70 - repair_estimate',
        confidence,
      },
      max_allowable_offer: {
        value: maxAllowableOffer,
        formula: 'ARV * 0.75 - repair_estimate',
        confidence,
      },
      valuation_range: {
        value: prices.length ? { low: prices[0], high: prices[prices.length - 1] } : null,
        formula: 'min/max included comp prices',
        confidence,
      },
    },
    supporting_comp_ids: included.map((c) => c.comp_property_id),
  };
}

export function buildSnapshotPayload({
  subjectContract,
  discovery,
  valuation,
  masterOwnerId = null,
  valuationType = 'residential_arv',
}) {
  const included = discovery?.included ?? [];
  const excluded = discovery?.excluded ?? [];
  const prices = included.map((c) => c.sale_list_price).filter(Boolean);
  const ppsfValues = included.map((c) => c.ppsf).filter(Boolean);
  const ppuValues = included.map((c) => c.ppu).filter(Boolean);

  return {
    property_id: subjectContract.property_id,
    master_owner_id: masterOwnerId,
    valuation_type: valuationType,
    estimated_arv: valuation.arv,
    estimated_value: valuation.arv,
    arv_confidence_score: valuation.confidence,
    comp_confidence_score: valuation.confidence,
    median_sale_price: median(prices),
    median_ppsf: median(ppsfValues),
    median_ppu: median(ppuValues),
    low_value: prices.length ? prices[0] : null,
    high_value: prices.length ? prices[prices.length - 1] : null,
    repair_estimate: valuation.repair_estimate,
    conservative_offer: valuation.outputs?.target_offer?.value,
    target_offer: valuation.outputs?.target_offer?.value,
    max_allowable_offer: valuation.outputs?.max_allowable_offer?.value,
    expected_assignment_low: null,
    expected_assignment_high: null,
    buyer_exit_price: valuation.outputs?.investor_reality?.value,
    buyer_demand_score: null,
    included_comp_count: included.length,
    excluded_comp_count: excluded.length,
    radius_miles: discovery?.expanded_criteria?.radius_miles ?? discovery?.expanded_criteria?.radius ?? null,
    lookback_months: discovery?.expanded_criteria?.months_back ?? null,
    asset_class: subjectContract?.asset_type?.value ?? null,
    valuation_notes: valuation.warnings?.join('; ') || null,
    comp_methodology: {
      model_version: valuation.model_version,
      search_mode: discovery?.search_mode,
      relaxations: discovery?.relaxations,
      data_gaps: valuation.data_gaps,
      coordinate_source: subjectContract?.coordinate_source,
    },
    included_comps: included.map((c) => ({
      id: c.comp_property_id,
      score: c.similarity_score,
      weight: c.similarity_score,
      source: c.source,
    })),
    excluded_comps: excluded.map((c) => ({
      id: c.comp_property_id,
      reasons: c.exclusion_reasons,
    })),
  };
}

export function buildValuationInputHash(subjectContract, discovery, valuation) {
  const payload = {
    property_id: subjectContract?.property_id,
    coordinate_source: subjectContract?.coordinate_source,
    model_version: valuation?.model_version,
    included_ids: (discovery?.included ?? []).map((c) => c.comp_property_id).sort(),
    arv: valuation?.arv,
    confidence: valuation?.confidence,
    search_mode: discovery?.search_mode,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export async function persistValuationSnapshotIfChanged(snapshot, inputHash, deps = {}) {
  const db = deps.db ?? supabase;
  const propertyId = snapshot.property_id;
  if (!propertyId || !snapshot.estimated_arv) {
    return { persisted: false, reason: 'insufficient_valuation' };
  }

  const { data: latest } = await db
    .from('property_valuation_snapshots')
    .select('id, comp_methodology')
    .eq('property_id', propertyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousHash = latest?.comp_methodology?.input_hash ?? null;
  if (previousHash && previousHash === inputHash) {
    return { persisted: false, reason: 'idempotent_skip', snapshot_id: latest.id, input_hash: inputHash };
  }

  const insertPayload = {
    ...snapshot,
    comp_methodology: {
      ...(snapshot.comp_methodology ?? {}),
      input_hash: inputHash,
    },
  };

  const { data, error } = await db
    .from('property_valuation_snapshots')
    .insert(insertPayload)
    .select('id')
    .single();
  if (error) throw error;

  return { persisted: true, snapshot_id: data.id, input_hash: inputHash };
}

export default {
  computeValuationOutputs,
  deriveValuationState,
  buildSnapshotPayload,
  buildValuationInputHash,
  persistValuationSnapshotIfChanged,
};