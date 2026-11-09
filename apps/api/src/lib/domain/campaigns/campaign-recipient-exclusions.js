/**
 * Campaign-scoped recipient exclusions: ONE shared rule for target building,
 * queue planning and final dispatch.
 *
 * Source of truth: public.campaign_recipient_exclusions (active rows only),
 * keyed by (campaign_id, canonical US E.164). An exclusion applies only to its
 * own campaign and never suppresses the contact anywhere else.
 *
 * Fail-safe contract:
 *   - no rows                      -> { ok: true, phones: empty set }  (valid; blocks nobody)
 *   - lookup error / missing id    -> { ok: false, error }             (caller must stop or hold)
 *   - any malformed stored phone   -> { ok: false, error }             (never treated as "none")
 */

export const EXCLUSIONS_TABLE = 'campaign_recipient_exclusions'
export const EXCLUSION_LOOKUP_FAILED = 'campaign_recipient_exclusions_unreadable'
export const EXCLUSION_DATA_INVALID = 'campaign_recipient_exclusions_invalid'
export const EXCLUSION_CAMPAIGN_ID_MISSING = 'campaign_recipient_exclusions_campaign_id_missing'

const E164_US = /^\+1[2-9]\d{2}[2-9]\d{6}$/

/** Canonical US E.164 ('+1XXXXXXXXXX') or null. Mirrors public.normalize_us_phone_e164. */
export function normalizeExclusionPhone(value) {
  const d = String(value ?? '').replace(/\D/g, '')
  const e164 = d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : null
  return e164 && E164_US.test(e164) ? e164 : null
}

/**
 * Loads the ACTIVE exclusion set for one campaign.
 * @returns {Promise<{ ok: boolean, phones: Set<string>, error?: string }>}
 */
export async function loadCampaignRecipientExclusions(supabase, campaignId) {
  if (!campaignId) return { ok: false, phones: new Set(), error: EXCLUSION_CAMPAIGN_ID_MISSING }
  let result
  try {
    result = await supabase
      .from(EXCLUSIONS_TABLE)
      .select('phone_e164')
      .eq('campaign_id', campaignId)
      .eq('is_active', true)
  } catch (error) {
    return { ok: false, phones: new Set(), error: EXCLUSION_LOOKUP_FAILED, detail: error?.message || String(error) }
  }
  if (!result || result.error || !Array.isArray(result.data)) {
    return { ok: false, phones: new Set(), error: EXCLUSION_LOOKUP_FAILED, detail: result?.error?.message || null }
  }
  const phones = new Set()
  for (const row of result.data) {
    const phone = normalizeExclusionPhone(row?.phone_e164)
    if (!phone || phone !== row.phone_e164) {
      return { ok: false, phones: new Set(), error: EXCLUSION_DATA_INVALID }
    }
    phones.add(phone)
  }
  return { ok: true, phones }
}

/** Pure check. `recipient` may be a graph row, campaign target or queue row. */
export function isRecipientExcluded(phones, recipient = {}) {
  if (!phones || phones.size === 0) return false
  const phone = normalizeExclusionPhone(recipient.canonical_e164 ?? recipient.to_phone_number ?? recipient.phone)
  return phone ? phones.has(phone) : false
}
