/**
 * DETAIL MERGE — how a campaign's detail payload is folded into its list row.
 *
 * This was `{ ...base, ...enriched }`, which let the detail payload overwrite
 * the list row wholesale. Measured on Miami - Test Campaign, one campaign
 * carries four different "sent" figures across the two endpoints:
 *
 *   list    /api/cockpit/campaigns           sent_count 354   failed 30
 *   detail  campaign.sent_count              sent_count 151
 *   detail  summary.recipient_metrics        sent_count 151
 *   detail  summary  (what the UI consumed)  sent_count   0   failed 16
 *   ground truth: send_queue rows with sent_at          367
 *
 * The detail hero opened reading "354 of 802 sent", then ~12s later — when the
 * detail request landed — flipped to "0 of 802 sent · No sends yet" while the
 * operator was looking at it. The index card for the same campaign still said
 * 354. Two screens, one campaign, two contradictory answers.
 *
 * TWO RULES, and nothing cleverer:
 *
 *   1. The list row is authoritative for DELIVERY OUTCOMES. It is what the
 *      index card shows, so detail and index can never disagree; and it is the
 *      figure nearest the queue's own truth (354 of 367, against 0).
 *
 *   2. `undefined` and `null` never erase a defined value. The detail payload
 *      omits `operator_state`, and spreading it over the list row silently
 *      dropped test mode from a campaign that is in test mode.
 *
 * Everything the detail payload adds that the list lacks — targeting counts,
 * execution proof, launch readiness, recipient metrics — still flows through.
 */
import type { CampaignSummary } from './campaigns.types'

/** Fields whose list-row value wins. These are what the index card renders. */
export const LIST_AUTHORITATIVE_FIELDS = [
  'sent_count',
  'delivered_count',
  'failed_count',
  'reply_count',
  'positive_reply_count',
  'negative_reply_count',
  'opt_out_count',
  'delivery_rate',
  'reply_rate',
  'positive_rate',
  'opt_out_rate',
  'failure_rate',
  'operator_state',
  'operator_state_label',
] as const satisfies ReadonlyArray<keyof CampaignSummary>

export function mergeCampaignDetail(
  base: CampaignSummary,
  enriched: Partial<CampaignSummary> | null | undefined,
): CampaignSummary {
  if (!enriched || enriched.id !== base.id) return base

  const merged: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) }
  for (const [key, value] of Object.entries(enriched)) {
    if (value === undefined || value === null) continue
    merged[key] = value
  }

  for (const key of LIST_AUTHORITATIVE_FIELDS) {
    const listValue = base[key]
    if (listValue !== undefined && listValue !== null) merged[key] = listValue
  }

  // Recency follows the same rule: the list's timestamp is not erased by a
  // detail payload that simply does not carry one.
  if (!merged.last_send_at && base.last_send_at) merged.last_send_at = base.last_send_at

  return merged as unknown as CampaignSummary
}
