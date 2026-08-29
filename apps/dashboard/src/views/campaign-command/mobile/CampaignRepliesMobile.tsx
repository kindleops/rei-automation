import { useEffect, useState } from 'react'
import { fetchCampaignReplies } from '../campaigns.adapter'
import type { CampaignReply, CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — Replies, mobile.
 *
 * Presentation only: same fetch, same client-side reply_type filter, same
 * counts. Replaces `.ccc__reply-card` and its header/footer chrome with the
 * shared bands, so a reply reads as a row with the message as its body rather
 * than as a tile.
 */

const FILTERS = ['all', 'positive', 'negative', 'neutral', 'opt_out', 'question'] as const
type ReplyFilter = (typeof FILTERS)[number]

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function toneOf(type: string): 'live' | 'hold' | 'bad' | '' {
  if (type === 'positive') return 'live'
  if (type === 'opt_out' || type === 'negative') return 'bad'
  if (type === 'question') return 'hold'
  return ''
}

export function CampaignRepliesMobile({ campaign }: { campaign: CampaignSummary }) {
  const [filter, setFilter] = useState<ReplyFilter>('all')
  const [replies, setReplies] = useState<CampaignReply[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchCampaignReplies(campaign.id)
      .then((data) => { if (active) setReplies(data) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [campaign.id])

  const filtered = filter === 'all' ? replies : replies.filter((r) => r.reply_type === filter)

  return (
    <div className="cdb">
      <section className="cdb__band">
        <div className="cdb__key">REPLIES<em>this campaign</em></div>
        <div className="cdb__rows">
          {[
            { label: 'Total', value: campaign.reply_count },
            { label: 'Positive', value: campaign.positive_reply_count },
            { label: 'Opted out', value: campaign.opt_out_count },
          ].map((s) => (
            <div key={s.label} className={`cdb__row${s.value === 0 ? ' is-nil' : ''}`}>
              <span className="cdb__row-label">{s.label}</span>
              <span className="cdb__row-value">{Number(s.value ?? 0).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="cdb__controls">
        <div className="cdb__chips is-scroll" role="group" aria-label="Filter by reply type">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`cdb__chip${filter === f ? ' is-on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="cdb__empty">Loading replies…</div>
      ) : filtered.length === 0 ? (
        <div className="cdb__empty">No replies yet — they appear once sending begins.</div>
      ) : (
        <section className="cdb__band is-last">
          <div className="cdb__rows">
            {filtered.map((r) => (
              <div key={r.id} className="cdb__row is-tappable">
                <span className="cdb__row-main">
                  <span className="cdb__row-id">{r.seller_full_name || 'Unknown sender'}</span>
                  <span className="cdb__row-value is-text">{fmtDate(r.created_at)}</span>
                  <span className={`cdb__row-state${toneOf(r.reply_type) ? ` is-${toneOf(r.reply_type)}` : ''}`}>
                    {String(r.reply_type ?? '').replace(/_/g, ' ').toUpperCase()}
                  </span>
                </span>
                <span className="cdb__quote">{r.inbound_message}</span>
                <span className="cdb__row-sub">
                  {r.property_address_full || 'No address'}
                  {r.next_action && <em>· {r.next_action}</em>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
