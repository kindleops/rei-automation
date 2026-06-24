/** Rate + comparison helpers for the Template Intelligence contract. */

export function buildRate(numerator, denominator) {
  const num = Number(numerator) || 0
  const den = Number(denominator) || 0
  return {
    numerator: num,
    denominator: den,
    value: den > 0 ? Math.round((num / den) * 10000) / 100 : null,
    unit: 'percent',
  }
}

export function buildCountMetric(current, prior, baseline) {
  const cur = Number(current) || 0
  const prev = Number(prior) || 0
  const base = Number(baseline) || 0
  return {
    current: cur,
    prior: prev,
    baseline: base,
    delta_absolute: cur - prev,
    delta_percent: prev > 0 ? Math.round(((cur - prev) / prev) * 10000) / 100 : (cur > 0 ? 100 : 0),
    baseline_delta_absolute: cur - base,
    baseline_delta_percent: base > 0 ? Math.round(((cur - base) / base) * 10000) / 100 : (cur > 0 ? 100 : 0),
  }
}

export function buildRateMetric(currentRate, priorRate, baselineRate) {
  const cur = currentRate?.value ?? null
  const prev = priorRate?.value ?? null
  const base = baselineRate?.value ?? null
  return {
    current: currentRate,
    prior: priorRate,
    baseline: baselineRate,
    delta_absolute: cur != null && prev != null ? Math.round((cur - prev) * 100) / 100 : null,
    delta_percent: prev != null && prev > 0 && cur != null
      ? Math.round(((cur - prev) / prev) * 10000) / 100
      : null,
    baseline_delta_absolute: cur != null && base != null ? Math.round((cur - base) * 100) / 100 : null,
    baseline_delta_percent: base != null && base > 0 && cur != null
      ? Math.round(((cur - base) / base) * 10000) / 100
      : null,
    unit: 'percentage_points',
  }
}

export function confidenceFromSample(sampleSize, range = 'current') {
  const n = Number(sampleSize) || 0
  let bucket = 'insufficient_data'
  if (n >= 100) bucket = 'high_confidence'
  else if (n >= 30) bucket = 'medium_confidence'
  else if (n >= 10) bucket = 'low_confidence'
  return {
    bucket,
    sample_size: n,
    range,
  }
}

export function kpiRowToMetrics(row = {}) {
  const sends = Number(row.sends ?? row.sample_size ?? 0)
  const delivered = Number(row.delivered ?? 0)
  const failed = Number(row.failed ?? 0)
  const replies = Number(row.inbound_replies ?? row.inbound_classified_count ?? 0)
  const positive = Number(row.positive_inbound_count ?? row.positive_replies ?? 0)
  const negative = Number(row.negative_inbound_count ?? 0)
  const ownership = Number(row.ownership_confirmed_replies ?? 0)
  const selling = Number(row.selling_interest_replies ?? 0)
  const price = Number(row.asking_price_replies ?? 0)
  const stageAdvanced = Number(row.stage_advanced_count ?? row.stage_advanced ?? 0)
  const optOuts = Number(row.opt_out_count ?? row.opt_outs ?? 0)
  const wrong = Number(row.wrong_numbers ?? 0)
  const hostile = Number(row.hostile_or_legal ?? 0)
  const unclear = Number(row.unclear_inbound_count ?? 0)
  const notInterested = Number(row.not_interested ?? 0)

  return {
    sends,
    delivered,
    failed,
    replies,
    unique_replies: replies,
    positive_replies: positive,
    negative_replies: negative,
    ownership_confirmed: ownership,
    selling_interest: selling,
    stage_advanced: stageAdvanced,
    price_captured: price,
    condition_completed: 0,
    offer_requested: 0,
    offer_delivered: 0,
    contracts_generated: 0,
    contracts_signed: 0,
    opt_outs: optOuts,
    wrong_numbers: wrong,
    hostile_legal: hostile,
    unclear,
    not_interested: notInterested,
    retries: 0,
    rotations: 0,
    cost: 0,
    segments: 0,
    median_response_time: row.median_response_hours ?? null,
    average_response_time: row.avg_response_hours ?? null,
    rates: {
      delivery: buildRate(delivered, sends),
      failure: buildRate(failed, sends),
      reply: buildRate(replies, delivered),
      positive_reply: buildRate(positive, replies),
      negative_reply: buildRate(negative, replies),
      ownership_confirmation: buildRate(ownership, replies),
      selling_interest: buildRate(selling, replies),
      price_capture: buildRate(price, replies),
      stage_advancement: buildRate(stageAdvanced, replies),
      offer_progression: buildRate(0, replies),
      contract_progression: buildRate(0, replies),
      opt_out: buildRate(optOuts, delivered),
      wrong_number: buildRate(wrong, replies),
      hostile_legal: buildRate(hostile, replies),
      retry_recovery: buildRate(0, failed),
    },
    confidence: confidenceFromSample(sends),
    performance_label: row.performance_label ?? 'insufficient_data',
  }
}

export function emptyMetrics() {
  return kpiRowToMetrics({})
}

export const AUTOPILOT_MODES = ['off', 'shadow', 'recommend', 'controlled', 'autonomous']
export const DEFAULT_AUTOPILOT_MODE = 'shadow'

export const ROTATION_STATES = [
  'cold_start',
  'testing',
  'rising',
  'winner',
  'champion',
  'watch',
  'cooldown',
  'paused',
  'retired',
]