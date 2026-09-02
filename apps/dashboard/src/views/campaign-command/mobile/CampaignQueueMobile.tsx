import { useEffect, useMemo, useState } from 'react'
import { fetchCampaignQueue } from '../campaigns.adapter'
import type { CampaignQueueRow, CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — Queue, mobile.
 *
 * Presentation only. Same fetch, same date grouping, same counts, same absence
 * of row actions as before — this replaces `.ccc-mobile-queue-card`, which gave
 * every queued send its own filled rounded card and turned a dense operational
 * list into a stack of tiles.
 *
 * A queue row now answers, in order: who, when, what state, from where, and —
 * only if there is one — why it failed.
 */

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return 'Unscheduled'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Execution status wins over queue status: it is the later, truer fact. */
function stateOf(item: CampaignQueueRow): { label: string; tone: 'live' | 'hold' | 'bad' | '' } {
  const delivery = String(item.delivery_status ?? '').toLowerCase()
  if (item.failure_category || item.failed_reason) return { label: 'FAILED', tone: 'bad' }
  if (delivery === 'delivered') return { label: 'DELIVERED', tone: 'live' }
  if (delivery === 'sent') return { label: 'SENT', tone: 'live' }
  if (delivery === 'undelivered' || delivery === 'failed') return { label: 'UNDELIVERED', tone: 'bad' }

  switch (item.queue_status) {
    case 'sending': return { label: 'SENDING', tone: 'live' }
    case 'queued': return { label: 'QUEUED', tone: '' }
    case 'held': return { label: 'HELD', tone: 'hold' }
    case 'paused': return { label: 'PAUSED', tone: 'hold' }
    default: return { label: 'SCHEDULED', tone: '' }
  }
}

/** Sender/market context, only when it actually carries information. */
function routeOf(item: CampaignQueueRow): string | null {
  const parts = [item.market, item.from_phone_number].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

export function CampaignQueueMobile({ campaign }: { campaign: CampaignSummary }) {
  const [items, setItems] = useState<CampaignQueueRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignQueue(campaign.id)
      .then((data) => { if (active) setItems(data) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [campaign.id])

  const groups = useMemo(() => {
    const map = new Map<string, CampaignQueueRow[]>()
    for (const item of items) {
      const key = fmtDate(item.scheduled_for)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(item)
    }
    return map
  }, [items])

  return (
    <div className="cdb">
      <section className="cdb__band">
        <div className="cdb__key">QUEUE<em>this campaign</em></div>
        <div className="cdb__rows">
          {[
            { label: 'Ready', value: campaign.ready_targets },
            { label: 'Queued', value: campaign.queued_targets },
            { label: 'Scheduled', value: campaign.scheduled_targets },
          ].map((s) => (
            <div key={s.label} className={`cdb__row${s.value === 0 ? ' is-nil' : ''}`}>
              <span className="cdb__row-label">{s.label}</span>
              <span className="cdb__row-value">{Number(s.value ?? 0).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </section>

      {loading ? (
        <div className="cdb__empty">Loading queue…</div>
      ) : items.length === 0 ? (
        <div className="cdb__empty">Queue is empty — nothing ready or queued.</div>
      ) : (
        Array.from(groups.entries()).map(([date, rows], i, arr) => (
          <section key={date} className={`cdb__band${i === arr.length - 1 ? ' is-last' : ''}`}>
            <div className="cdb__key">
              {date}
              <span className="cdb__count">{rows.length} sends</span>
            </div>
            <div className="cdb__rows">
              {rows.map((item) => {
                const state = stateOf(item)
                const route = routeOf(item)
                const reason = item.failed_reason || item.failure_category
                const identity =
                  item.seller_full_name
                  || item.property_address_full
                  || item.market
                  || 'Scheduled send'
                // Don't repeat the identity on the metadata line.
                const sub = [
                  item.seller_full_name ? item.property_address_full : null,
                  identity === item.market ? item.from_phone_number : route,
                ].filter(Boolean).join(' · ') || null
                return (
                  <div key={item.id} className="cdb__row is-tappable">
                    <span className="cdb__row-main">
                      {/* Lead with whatever identity this source actually carries.
                          fetchCampaignQueue maps campaign_send_windows, which has
                          no seller or address — printing "Unnamed recipient / No
                          address" invented an absence rather than reporting one. */}
                      <span className="cdb__row-id">{identity}</span>
                      <span className="cdb__row-value is-text">{fmtTime(item.scheduled_for)}</span>
                      <span className={`cdb__row-state${state.tone ? ` is-${state.tone}` : ''}`}>{state.label}</span>
                    </span>
                    {sub && <span className="cdb__row-sub">{sub}</span>}
                    {reason && <span className="cdb__row-flag is-bad">{reason}</span>}
                  </div>
                )
              })}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
