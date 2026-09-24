import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import {
  getCampaignMessagesBackend,
  type CampaignMessageBucket,
  type CampaignMessageRow,
  type CampaignMessagesResponse,
} from '../../../lib/api/backendClient'
import type { CampaignSummary } from '../campaigns.types'
import { sellerLabel } from './mobile-format'

/**
 * Campaign Detail — Queue, mobile.
 *
 * Reads send_queue through /messages. This listed campaign_send_windows before —
 * planning slots written once as "planned" and never updated — so Miami showed
 * June windows labelled SCHEDULED directly under "Scheduled 0". Its real queue:
 * nothing waiting, 354 sent.
 *
 * Two views of one table: what's waiting (next first) and what went out (latest
 * first). Messages that didn't go out live in Exceptions, one tap away. Rows
 * open the seller's conversation.
 */

const nf = (n: number) => n.toLocaleString()
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const LIVE = new Set(['active', 'activating', 'live_limited'])

function dayLabel(iso: string | null, now = new Date()): string {
  if (!iso) return 'Not scheduled'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Not scheduled'
  const key = (x: Date) => x.toDateString()
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  const t = new Date(now)
  t.setDate(now.getDate() + 1)
  if (key(d) === key(now)) return 'Today'
  if (key(d) === key(y)) return 'Yesterday'
  if (key(d) === key(t)) return 'Tomorrow'
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}

const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null

function stateOf(m: CampaignMessageRow): { label: string; tone: 'ok' | 'live' | 'test' | '' } {
  if (m.test_only) return { label: 'Test', tone: 'test' }
  switch (m.status) {
    case 'delivered': return { label: 'Delivered', tone: 'ok' }
    case 'sent': return { label: 'Sent', tone: 'live' }
    case 'processing':
    case 'sending': return { label: 'Sending', tone: 'live' }
    case 'queued':
    case 'ready':
    case 'pending': return { label: 'Queued', tone: '' }
    case 'approval': return { label: 'Needs approval', tone: '' }
    default: return { label: 'Scheduled', tone: '' }
  }
}

function emptyCopy(bucket: CampaignMessageBucket, campaign: CampaignSummary): { title: string; body: string | null } {
  const status = String(campaign.status ?? '').toLowerCase()
  const ready = Number(campaign.ready_targets ?? 0)
  if (bucket === 'sent') {
    return { title: 'Nothing has been sent yet', body: null }
  }
  if (status === 'paused') {
    return {
      title: 'Nothing is waiting to send',
      body: 'The campaign is paused, so nothing new is being lined up.',
    }
  }
  if (!LIVE.has(status) && status !== 'scheduled') {
    return {
      title: 'Nothing is waiting to send',
      body: ready > 0 ? `${nf(ready)} ${ready === 1 ? 'seller is' : 'sellers are'} ready once the campaign runs.` : null,
    }
  }
  return { title: 'Nothing is waiting right now', body: null }
}

export function CampaignQueueMobile({
  campaign,
  onOpenSection,
}: {
  campaign: CampaignSummary
  /** Switch the detail to another section (used for the Exceptions link). */
  onOpenSection?: (section: 'failures') => void
}) {
  const [bucket, setBucket] = useState<CampaignMessageBucket>('upcoming')
  const [data, setData] = useState<CampaignMessagesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const chosen = useRef(false)
  const request = useRef(0)

  const load = useCallback(async (which: CampaignMessageBucket) => {
    const id = ++request.current
    setLoading(true)
    setFailed(false)
    const res = await getCampaignMessagesBackend(campaign.id, { bucket: which, limit: 40 })
    if (id !== request.current) return
    if (res.ok && res.data?.counts) {
      setData(res.data)
      // First visit: if nothing is waiting but messages went out, open on Sent.
      if (!chosen.current) {
        chosen.current = true
        if (which === 'upcoming' && res.data.counts.upcoming + res.data.counts.sending === 0 && res.data.counts.sent > 0) {
          setBucket('sent')
          return
        }
      }
    } else {
      setFailed(true)
    }
    setLoading(false)
  }, [campaign.id])

  useEffect(() => { void load(bucket) }, [bucket, load])

  const counts = data?.counts
  const waiting = (counts?.upcoming ?? 0) + (counts?.sending ?? 0)
  const rows = data && data.bucket === bucket ? data.messages : []

  const groups = useMemo(() => {
    const out: Array<{ day: string; rows: CampaignMessageRow[] }> = []
    for (const m of rows) {
      const day = dayLabel(bucket === 'sent' ? (m.sent_at ?? m.updated_at) : m.scheduled_for)
      const last = out[out.length - 1]
      if (last && last.day === day) last.rows.push(m)
      else out.push({ day, rows: [m] })
    }
    return out
  }, [rows, bucket])

  const openThread = (m: CampaignMessageRow) => {
    if (m.thread_key) pushRoutePath(`/inbox?thread=${encodeURIComponent(m.thread_key)}`)
  }

  const inTest = campaign.operator_state === 'test_mode'
  const empty = emptyCopy(bucket, campaign)

  return (
    <div className="cq">
      <div className="cq-seg" role="tablist" aria-label="Queue view">
        {([
          { id: 'upcoming' as const, label: 'Waiting', count: counts ? waiting : null },
          { id: 'sent' as const, label: 'Sent', count: counts ? counts.sent : null },
        ]).map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={bucket === s.id}
            className={cls('cq-seg__opt', bucket === s.id && 'is-on')}
            onClick={() => { chosen.current = true; setBucket(s.id) }}
          >
            {s.label}
            {s.count != null && <span className="cq-seg__n">{nf(s.count)}</span>}
          </button>
        ))}
      </div>

      {bucket === 'sent' && counts && counts.sent > 0 && (
        <p className="cq-summary">
          {nf(counts.delivered)} of {nf(counts.sent)} confirmed delivered.
        </p>
      )}
      {bucket === 'upcoming' && inTest && waiting > 0 && (
        <p className="cq-summary is-test">Test mode is on — nothing here reaches sellers.</p>
      )}

      {loading && !rows.length ? (
        <div className="cq-card" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="cq-skel" />)}
        </div>
      ) : failed ? (
        <section className="cov2-card is-warn" role="status">
          <h3 className="cov2-card__h">The queue couldn’t be loaded</h3>
          <p className="cov2-note">Nothing about the campaign has changed.</p>
          <button type="button" className="cex-retry" onClick={() => void load(bucket)}>Try again</button>
        </section>
      ) : rows.length === 0 ? (
        <section className="cov2-card cq-empty">
          <h3 className="cq-empty__title">{empty.title}</h3>
          {empty.body && <p className="cov2-note">{empty.body}</p>}
        </section>
      ) : (
        <div className="cq-card">
          {groups.map((g) => (
            <section key={g.day} className="cq-day" aria-label={g.day}>
              <h3 className="cq-day__h">{g.day}</h3>
              <ul className="cq-list">
                {g.rows.map((m) => {
                  const state = stateOf(m)
                  const at = timeOf(bucket === 'sent' ? (m.sent_at ?? m.updated_at) : m.scheduled_for)
                  const who = sellerLabel(m.seller_name, m.to_phone_number)
                  // The address, whole. The number was cut mid-digit at 375px, and
                  // the row opens the conversation, which carries it.
                  const sub = m.property_address || m.market || null
                  const Row = m.thread_key ? 'button' : 'div'
                  return (
                    <li key={m.id}>
                      <Row
                        {...(m.thread_key ? { type: 'button' as const, onClick: () => openThread(m) } : {})}
                        className={cls('cq-row', m.thread_key && 'is-link')}
                      >
                        <span className="cq-row__top">
                          <span className="cq-row__who">{who}</span>
                          {at && <span className="cq-row__at">{at}</span>}
                        </span>
                        <span className="cq-row__bottom">
                          <span className="cq-row__sub">{sub || '\u00a0'}</span>
                          <span className={cls('cq-pill', state.tone && `is-${state.tone}`)}>{state.label}</span>
                        </span>
                      </Row>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          {data?.has_more && (
            <p className="cq-more">Showing the {bucket === 'sent' ? 'latest' : 'next'} {nf(rows.length)}.</p>
          )}
        </div>
      )}

      {counts && counts.not_sent > 0 && onOpenSection && (
        <button type="button" className="cq-exc" onClick={() => onOpenSection('failures')}>
          <span>
            <strong>{nf(counts.not_sent)}</strong> didn’t go out
          </span>
          <span className="cq-exc__go">
            Exceptions <Icon name="chevron-right" size={14} />
          </span>
        </button>
      )}
    </div>
  )
}

export default CampaignQueueMobile
