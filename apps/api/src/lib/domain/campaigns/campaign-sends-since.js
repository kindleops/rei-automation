/**
 * Campaign messages sent since a moment — "sent today" when the caller passes
 * its own local midnight.
 *
 * The Campaign Command index labelled a number "Sent today" that was every
 * active campaign's lifetime sent_count added up: it read 363 on a day nothing
 * had sent (Miami, paused since Sep 23, contributed its 354). This counts
 * send_queue rows that actually went out after `since`. Read-only.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const PAGE = 1000
const MAX_PAGES = 20
const MAX_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000

export function parseSince(value, now = Date.now()) {
  const ms = Date.parse(String(value ?? ''))
  if (!Number.isFinite(ms)) return null
  // A day boundary, not an arbitrary range: refuse the future and anything
  // older than a week, so this can't become an unbounded scan.
  if (ms > now || now - ms > MAX_LOOKBACK_MS) return null
  return new Date(ms).toISOString()
}

export async function fetchCampaignSendsSince(since, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const from = parseSince(since, deps.now ?? Date.now())
  if (!from) return { ok: false, error: 'invalid_since' }

  const byCampaign = {}
  let seen = 0
  let total = null
  let truncated = false
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE
    const { data, error, count } = await supabase
      .from('send_queue')
      .select('id,campaign_id', page === 0 ? { count: 'exact' } : undefined)
      .in('queue_status', ['sent', 'delivered'])
      .gte('sent_at', from)
      .not('campaign_id', 'is', null)
      .order('id', { ascending: true })
      .range(start, start + PAGE - 1)
    if (error) throw error
    const rows = data || []
    if (page === 0 && Number.isFinite(count)) total = count
    for (const row of rows) {
      byCampaign[row.campaign_id] = (byCampaign[row.campaign_id] || 0) + 1
    }
    seen += rows.length
    if (rows.length === 0) break
    if (total !== null ? seen >= total : rows.length < PAGE) break
    if (page === MAX_PAGES - 1) truncated = true
  }

  return { ok: true, since: from, total: total ?? seen, by_campaign: byCampaign, truncated }
}
