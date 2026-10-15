// MEASURED COMPLEXITY: Sonnet only when the turn justifies it (8.5.16). Pure.
export const SONNET_COMPLEXITY_THRESHOLD = 0.6

export function measureComplexity({ inboundText = '', ledger = null, threadLength = 0 } = {}) {
  const t = String(inboundText || '')
  const signals = {
    new_facts: Object.values(ledger?.facts || {}).filter((f) => (f.source_message_ids || []).includes(ledger?.last_message?.id)).length,
    questions_from_seller: (t.match(/\?/g) || []).length,
    objections: (ledger?.objections || []).length,
    requests: (ledger?.requests || []).length,
    long_message: t.length > 220 ? 1 : 0,
    price_history: (ledger?.facts?.asking_price?.history || []).length > 1 ? 1 : 0,
    long_thread: threadLength > 12 ? 1 : 0,
  }
  const score = Math.min(1,
    0.12 * Math.max(0, signals.new_facts - 1) + 0.15 * Math.max(0, signals.questions_from_seller - 1) + 0.25 * signals.objections +
    0.1 * signals.requests + 0.2 * signals.long_message + 0.25 * signals.price_history + 0.1 * signals.long_thread)
  return { score: Math.round(score * 100) / 100, signals, route: score >= SONNET_COMPLEXITY_THRESHOLD ? 'escalation' : 'default' }
}

/**
 * Spend caps: per message and per day. `spent` is what was already spent today (USD).
 * Fail closed when the estimate or the cap is unknown.
 */
export function checkSpend({ estimateUsd, spentTodayUsd, perMessageMaxUsd, dailyMaxUsd }) {
  const n = (x) => (x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null)
  const est = n(estimateUsd); const spent = n(spentTodayUsd); const per = n(perMessageMaxUsd); const day = n(dailyMaxUsd)
  if (est == null || spent == null || per == null || day == null) return { allowed: false, reason: 'spend_cap_unknown' }
  if (est > per) return { allowed: false, reason: 'spend_cap_per_message' }
  if (spent + est > day) return { allowed: false, reason: 'spend_cap_daily' }
  return { allowed: true, reason: 'within_spend_caps' }
}
