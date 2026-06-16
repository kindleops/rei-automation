/**
 * Derives a map marker display state from a property row.
 * Drives pin color, urgency indicators, and cluster ring color.
 *
 * Priority order: suppressed → replies → positive → negotiating →
 *   hot-score → queue states → blocked → sold comp → base
 */

/**
 * @param {object} p - row from public.properties
 * @param {object} [opts]
 * @param {boolean} [opts.isSoldComp]   - force sold_comp classification
 * @param {boolean} [opts.isBuyerComp]  - force buyer_comp classification
 * @returns {string} MapMarkerState
 */
export function deriveMapMarkerState(p, opts = {}) {
  if (opts.isBuyerComp) return 'buyer_comp'
  if (opts.isSoldComp) return 'sold_comp'

  const cs = (p.contact_status ?? '').toString().toLowerCase()
  const as_ = (p.activity_status ?? '').toString().toLowerCase()
  const combined = `${cs} ${as_}`

  // ── Suppressed / DNC ─────────────────────────────────────────────────────
  if (/suppressed|dnc|opt[\s_-]?out|wrong[\s_-]?number|blacklist|do[\s_-]?not[\s_-]?contact/.test(combined)) {
    return 'suppressed'
  }

  // ── New reply / unread ────────────────────────────────────────────────────
  if (/new[\s_-]?reply|unread|replied|inbound|responded|new[\s_-]?message|response/.test(combined)) {
    return 'new_reply'
  }

  // ── Positive / interested ─────────────────────────────────────────────────
  if (/positive|interested|motivated|callback|hot[\s_-]?lead|warm[\s_-]?lead/.test(combined)) {
    return 'positive'
  }

  // ── Negotiating / offer ───────────────────────────────────────────────────
  if (/negotiat|offer[\s_-]?made|under[\s_-]?contract|closing|contract[\s_-]?signed/.test(combined)) {
    return 'negotiating'
  }

  // ── Hot by score ──────────────────────────────────────────────────────────
  const finalScore = Number(p.final_acquisition_score) || 0
  const motivationScore = Number(p.structured_motivation_score) || 0
  const dealScore = Number(p.deal_strength_score) || 0
  if (finalScore >= 85 || motivationScore >= 80 || dealScore >= 85) return 'hot'

  // ── Queue / execution states ──────────────────────────────────────────────
  if (cs.includes('queued') || as_.includes('queued')) return 'queued'
  if (cs.includes('scheduled') || as_.includes('scheduled')) return 'scheduled'
  if (cs.includes('active_send') || cs.includes('sending') || as_.includes('active')) return 'active_sending'

  // ── Delivered / sent ─────────────────────────────────────────────────────
  if (cs.includes('delivered') || as_.includes('delivered')) return 'delivered'
  if (cs.includes('sent') || as_.includes('sent')) return 'sent'

  // ── Blocked / needs review ────────────────────────────────────────────────
  if (/blocked|invalid|failed|error|needs[\s_-]?review|review[\s_-]?needed/.test(combined)) {
    return 'needs_review'
  }

  // ── Sold comp ─────────────────────────────────────────────────────────────
  if (p.mls_sold_price || p.mls_sold_date) return 'sold_comp'

  // ── Not yet contacted ─────────────────────────────────────────────────────
  if (!cs || ['new', 'not_contacted', 'pending', 'fresh', 'uncontacted'].includes(cs)) {
    return 'not_contacted'
  }

  return 'base_property'
}
