import type { CampaignResponsesResponse } from '../../lib/api/backendClient'

/**
 * Seller responses, in operator language.
 *
 * `detected_intent` is the inbound classifier's reading of a reply. The words
 * here describe what the seller said; they never upgrade it ("ownership
 * confirmed" is not "interested"). Codes this file doesn't know are shown as
 * their words rather than dropped, so a new intent is never silently lost.
 */

export type IntentTone = 'good' | 'neutral' | 'bad'

const INTENTS: Record<string, { label: string; tone: IntentTone }> = {
  asks_offer: { label: 'Asked for an offer', tone: 'good' },
  latent_interest: { label: 'Might be interested', tone: 'good' },
  interested: { label: 'Interested', tone: 'good' },
  ownership_confirmed: { label: 'Confirmed they own it', tone: 'good' },
  callback_request: { label: 'Wants a call', tone: 'good' },
  price_request: { label: 'Asked about price', tone: 'good' },
  executor_heir_respondent: { label: 'Heir or executor', tone: 'neutral' },
  former_owner_respondent: { label: 'Former owner', tone: 'neutral' },
  tenant_respondent: { label: 'Tenant', tone: 'neutral' },
  non_owner_referral: { label: 'Not the owner', tone: 'neutral' },
  who_is_this: { label: 'Asked who’s texting', tone: 'neutral' },
  unclear: { label: 'Unclear', tone: 'neutral' },
  unclassified: { label: 'Not read yet', tone: 'neutral' },
  not_interested: { label: 'Not interested', tone: 'bad' },
  wrong_number: { label: 'Wrong number', tone: 'bad' },
  opt_out: { label: 'Asked to stop', tone: 'bad' },
  stop: { label: 'Asked to stop', tone: 'bad' },
  hostile_or_legal: { label: 'Hostile or legal', tone: 'bad' },
}

export function describeIntent(code: string | null | undefined): { label: string; tone: IntentTone } {
  const key = String(code ?? '').trim().toLowerCase()
  if (!key) return INTENTS.unclassified
  const known = INTENTS[key]
  if (known) return known
  const words = key.replace(/[_:.-]+/g, ' ').trim()
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: 'neutral' }
}

export type IntentRow = { key: string; label: string; tone: IntentTone; count: number }

/** Largest first; labels that mean the same thing are merged. */
export function intentRows(intents: Record<string, number> | null | undefined): IntentRow[] {
  const merged = new Map<string, IntentRow>()
  for (const [code, raw] of Object.entries(intents ?? {})) {
    const count = Number(raw) || 0
    if (count <= 0) continue
    const d = describeIntent(code)
    const prev = merged.get(d.label)
    if (prev) prev.count += count
    else merged.set(d.label, { key: code, label: d.label, tone: d.tone, count })
  }
  return [...merged.values()].sort((a, b) => b.count - a.count)
}

/** Share of messaged sellers who replied, as a whole-number percent, or null with no sample. */
export function replyRatePct(r: Pick<CampaignResponsesResponse, 'sellers_messaged' | 'sellers_replied'> | null): number | null {
  if (!r || r.sellers_messaged <= 0) return null
  return (r.sellers_replied / r.sellers_messaged) * 100
}

export function stopRatePct(r: Pick<CampaignResponsesResponse, 'sellers_messaged' | 'sellers_asked_to_stop'> | null): number | null {
  if (!r || r.sellers_messaged <= 0) return null
  return (r.sellers_asked_to_stop / r.sellers_messaged) * 100
}
