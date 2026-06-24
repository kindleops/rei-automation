/**
 * Unified template attribution contract — single source of truth for KPI rates.
 * Rules:
 * - Dependent reply metrics require an attributable reply denominator.
 * - Confirmed zero (0) and unavailable (null) are distinct.
 * - Impossible states (e.g. positive > replies) are reconciled, not displayed.
 */

import { buildRate } from './template-intelligence-contract.js'

export const MIN_INSIGHT_DELIVERED = 30
export const MIN_INSIGHT_REPLIES = 5

export function isUnavailable(value) {
  return value == null
}

export function isConfirmedZero(value) {
  return value === 0
}

/** Reconcile per-template attributable counts before rate calculation. */
export function reconcileAttributionCounts(raw = {}) {
  const sends = Number(raw.sends ?? 0) || 0
  const delivered = Number(raw.delivered ?? 0) || 0
  const attributionAvailable = Boolean(raw.attribution_available)
  const attributionPartial = Boolean(raw.attribution_partial)

  let replies = raw.replies
  if (replies != null) replies = Number(replies) || 0

  const replyTrackingUnavailable = sends > 0 && replies == null && (attributionPartial || !attributionAvailable)

  const dependent = (value) => {
    if (replyTrackingUnavailable || replies == null) return null
    if (replies === 0) return 0
    if (value == null) return null
    const n = Number(value) || 0
    return Math.min(n, replies)
  }

  const positive = dependent(raw.positive_replies)
  const negative = dependent(raw.negative_replies)
  const ownership = dependent(raw.ownership_confirmed)
  const stageAdvanced = dependent(raw.stage_advanced)
  const wrongNumbers = dependent(raw.wrong_numbers)
  const selling = dependent(raw.selling_interest)
  const notInterested = dependent(raw.not_interested)

  const optOuts = raw.opt_outs
  const optOutsNum = optOuts == null ? null : Number(optOuts) || 0

  return {
    sends,
    delivered,
    failed: Number(raw.failed ?? 0) || 0,
    replies,
    positive_replies: positive,
    negative_replies: negative,
    ownership_confirmed: ownership,
    stage_advanced: stageAdvanced,
    wrong_numbers: wrongNumbers,
    selling_interest: selling,
    not_interested: notInterested,
    opt_outs: delivered > 0 && optOuts == null && attributionPartial ? null : optOutsNum,
    attribution_available: attributionAvailable,
    attribution_partial: attributionPartial,
    attribution_source: raw.attribution_source ?? null,
    reply_tracking_unavailable: replyTrackingUnavailable,
  }
}

export function buildAttributionRates(counts = {}) {
  const c = reconcileAttributionCounts(counts)
  const { sends, delivered, replies } = c

  const rate = (numerator, denominator, unavailable = false) => ({
    numerator,
    denominator,
    value: denominator > 0 && numerator != null
      ? Math.round((Number(numerator) / denominator) * 10000) / 100
      : null,
    unit: 'percent',
    unavailable: unavailable || (numerator == null && denominator > 0),
    unattributed: numerator == null && denominator > 0,
  })

  return {
    delivery: rate(delivered, sends),
    reply: rate(c.replies, delivered, c.reply_tracking_unavailable),
    positive_reply: rate(c.positive_replies, c.replies, c.reply_tracking_unavailable),
    negative_reply: rate(c.negative_replies, c.replies, c.reply_tracking_unavailable),
    ownership_confirmation: rate(c.ownership_confirmed, c.replies, c.replies == null),
    stage_advancement: rate(c.stage_advanced, c.replies, c.replies == null),
    wrong_number: rate(c.wrong_numbers, c.replies, c.replies == null),
    opt_out: rate(c.opt_outs, delivered, c.opt_outs == null && c.attribution_partial),
  }
}

/** Portfolio-level aggregation across template rows. */
export function aggregatePortfolioAttribution(rows = []) {
  const countSum = (field) => {
    let sum = 0
    let hasValue = false
    let hasNullWithSends = false
    for (const row of rows) {
      const m = row.metrics?.current ?? row
      const sends = Number(m.sends ?? 0) || 0
      const val = m[field]
      if (val == null) {
        if (sends > 0) hasNullWithSends = true
        continue
      }
      sum += Number(val) || 0
      hasValue = true
    }
    if (!hasValue && hasNullWithSends) return { value: null, partial: true }
    return { value: sum, partial: hasNullWithSends }
  }

  const sends = rows.reduce((n, r) => n + (Number(r.metrics?.current?.sends ?? r.sends) || 0), 0)
  const delivered = rows.reduce((n, r) => n + (Number(r.metrics?.current?.delivered ?? r.delivered) || 0), 0)
  const failed = rows.reduce((n, r) => n + (Number(r.metrics?.current?.failed ?? r.failed) || 0), 0)

  const repliesAgg = countSum('replies')
  const positiveAgg = countSum('positive_replies')
  const negativeAgg = countSum('negative_replies')
  const ownershipAgg = countSum('ownership_confirmed')
  const stageAgg = countSum('stage_advanced')
  const optOutAgg = countSum('opt_outs')
  const wrongAgg = countSum('wrong_numbers')

  const responseTimes = rows
    .map((r) => r.metrics?.current?.average_response_time ?? r.metrics?.current?.median_response_time)
    .filter((v) => v != null && Number.isFinite(Number(v)))
  const avgReplyTime = responseTimes.length
    ? Math.round((responseTimes.reduce((a, b) => a + Number(b), 0) / responseTimes.length) * 10) / 10
    : null

  const reconciled = reconcileAttributionCounts({
    sends,
    delivered,
    failed,
    replies: repliesAgg.value,
    positive_replies: positiveAgg.value,
    negative_replies: negativeAgg.value,
    ownership_confirmed: ownershipAgg.value,
    stage_advanced: stageAgg.value,
    opt_outs: optOutAgg.value,
    wrong_numbers: wrongAgg.value,
    attribution_available: !repliesAgg.partial || repliesAgg.value != null,
    attribution_partial: repliesAgg.partial,
    attribution_source: 'portfolio_aggregate',
  })

  const rates = buildAttributionRates(reconciled)

  return {
    ...reconciled,
    rates,
    average_response_time: avgReplyTime,
    attribution_partial: repliesAgg.partial || positiveAgg.partial || ownershipAgg.partial,
  }
}

export function buildPortfolioInsightRail(rows = []) {
  const tracked = rows.filter((r) => (Number(r.metrics?.current?.sends) || 0) > 0)
  const used = new Set()
  const MIN_DEL = MIN_INSIGHT_DELIVERED
  const MIN_REP = MIN_INSIGHT_REPLIES

  const pick = (sorted, requireFn) => {
    for (const row of sorted) {
      const id = row.identity?.template_id
      if (!id || used.has(id)) continue
      if (requireFn && !requireFn(row)) continue
      used.add(id)
      return row
    }
    return null
  }

  const byReplyRate = [...tracked]
    .filter((r) => {
      const d = Number(r.metrics?.current?.delivered) || 0
      const rep = r.metrics?.current?.replies
      return d >= MIN_DEL && rep != null && Number(rep) >= MIN_REP
    })
    .sort((a, b) => (b.metrics?.rates?.reply?.value ?? -1) - (a.metrics?.rates?.reply?.value ?? -1))

  const byPositiveRate = [...tracked]
    .filter((r) => {
      const rep = Number(r.metrics?.current?.replies) || 0
      return rep >= MIN_REP && r.metrics?.current?.positive_replies != null
    })
    .sort((a, b) => (b.metrics?.rates?.positive_reply?.value ?? -1) - (a.metrics?.rates?.positive_reply?.value ?? -1))

  const byStage = [...tracked]
    .filter((r) => Number(r.metrics?.current?.stage_advanced) > 0)
    .sort((a, b) => (Number(b.metrics?.current?.stage_advanced) || 0) - (Number(a.metrics?.current?.stage_advanced) || 0))

  const byOptOut = [...tracked]
    .filter((r) => {
      const d = Number(r.metrics?.current?.delivered) || 0
      return d >= MIN_DEL && (r.metrics?.rates?.opt_out?.value ?? 0) > 0
    })
    .sort((a, b) => (b.metrics?.rates?.opt_out?.value ?? 0) - (a.metrics?.rates?.opt_out?.value ?? 0))

  const byDeliveryDrop = [...tracked]
    .filter((r) => Number(r.metrics?.current?.sends) >= MIN_DEL)
    .sort((a, b) => (a.metrics?.comparison?.rates?.delivery?.delta_absolute ?? 0) - (b.metrics?.comparison?.rates?.delivery?.delta_absolute ?? 0))

  const bySends = [...tracked].sort((a, b) => (Number(b.metrics?.current?.sends) || 0) - (Number(a.metrics?.current?.sends) || 0))

  const needsReview = tracked.filter((r) => {
    const dq = r.data_quality ?? {}
    return dq.attribution_status === 'unavailable'
      || dq.attribution_status === 'partial'
      || (dq.metadata_issues ?? []).length > 0
  }).length

  const insight = (row, metric, reason) => row ? {
    template_id: row.identity.template_id,
    display_name: row.identity.canonical_display_name,
    metric,
    reason,
  } : null

  const bestReply = pick(byReplyRate)
  const bestPositive = pick(byPositiveRate)
  const bestStage = pick(byStage)
  const highestOptOut = pick(byOptOut)
  const largestDecline = pick(byDeliveryDrop, (r) => (r.metrics?.comparison?.rates?.delivery?.delta_absolute ?? 0) < -1)
  const mostUsed = pick(bySends)

  return {
    tracked_templates: tracked.length,
    templates_with_activity: tracked.length,
    insights: [
      bestReply ? insight(bestReply, 'best_reply_rate', `Highest reply rate at ${bestReply.metrics?.rates?.reply?.value ?? '—'}% (${bestReply.metrics?.rates?.reply?.numerator}/${bestReply.metrics?.rates?.reply?.denominator} delivered)`) : { display_name: null, metric: 'best_reply_rate', reason: 'Not enough data — need 30+ delivered and 5+ attributable replies' },
      bestPositive ? insight(bestPositive, 'best_positive_rate', `Highest positive response rate at ${bestPositive.metrics?.rates?.positive_reply?.value ?? '—'}%`) : { display_name: null, metric: 'best_positive_rate', reason: 'Not enough attributable replies' },
      bestStage ? insight(bestStage, 'best_stage_advancement', `${bestStage.metrics?.current?.stage_advanced} stage advancements from attributable replies`) : { display_name: null, metric: 'best_stage_advancement', reason: 'No stage advancement in range' },
      highestOptOut ? insight(highestOptOut, 'highest_opt_out_risk', `Opt-out rate ${highestOptOut.metrics?.rates?.opt_out?.value ?? '—'}%`) : { display_name: null, metric: 'highest_opt_out_risk', reason: 'No elevated opt-out risk detected' },
      largestDecline ? insight(largestDecline, 'largest_delivery_decline', `Delivery rate dropped ${Math.abs(largestDecline.metrics?.comparison?.rates?.delivery?.delta_absolute ?? 0)} pp vs prior period`) : { display_name: null, metric: 'largest_delivery_decline', reason: 'No meaningful delivery decline' },
      mostUsed ? insight(mostUsed, 'most_used_template', `${mostUsed.metrics?.current?.sends} sends in selected period`) : { display_name: null, metric: 'most_used_template', reason: 'No sends in range' },
      { display_name: needsReview > 0 ? `${needsReview} templates` : null, metric: 'needs_data_review', reason: needsReview > 0 ? `${needsReview} templates need reply tracking or metadata review` : 'No data review flags' },
    ],
    lacking_attribution: tracked.filter((r) => r.data_quality?.attribution_status === 'unavailable' || r.data_quality?.attribution_status === 'partial').length,
  }
}

export function detectUndeclaredPlaceholders(body, declaredVars = []) {
  const text = String(body ?? '')
  if (!text) return []
  const declared = new Set(declaredVars.map((v) => String(v).toLowerCase()))
  const found = new Set()
  const patterns = [/\{\{([^}]+)\}\}/g, /\[\[([^\]]+)\]\]/g]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text)) !== null) {
      const key = String(m[1]).trim().toLowerCase()
      if (key && !declared.has(key)) found.add(key)
    }
  }
  return [...found]
}