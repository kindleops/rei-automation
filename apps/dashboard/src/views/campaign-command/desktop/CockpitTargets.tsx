import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { CampaignSummary } from '../campaigns.types'
import { describeIntent } from '../campaign-responses'
import { fetchCockpitTargets, type CockpitRead, type CockpitTargetPage, type CockpitTargetRow } from './cockpit-api'
import { holdWords, nf, whenIn } from './cockpit-model'
import { cls, formatPhone } from './cockpit-ui'

export type TargetFilter = { status: 'all' | 'ready' | 'planned' | 'blocked'; search: string; page: number }
export const DEFAULT_TARGET_FILTER: TargetFilter = { status: 'all', search: '', page: 1 }

const PAGE_SIZE = 50
const OVERDUE_GRACE_MS = 15 * 60 * 1000

const TARGET_WORDS: Record<string, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'plan' },
  planned: { label: 'Handed to queue', tone: 'exec' },
  blocked: { label: 'Held', tone: 'warn' },
}

const QUEUE_WORDS: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'exec' },
  scheduled: { label: 'Scheduled', tone: 'plan' },
  pending: { label: 'Queued', tone: 'exec' },
  ready: { label: 'Queued', tone: 'exec' },
  approved: { label: 'Queued', tone: 'exec' },
  processing: { label: 'Sending', tone: 'exec' },
  sending: { label: 'Sending', tone: 'exec' },
  sent: { label: 'Sent', tone: 'exec' },
  delivered: { label: 'Delivered', tone: 'ok' },
  failed_transport: { label: 'Not delivered', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  blocked_by_health_guard: { label: 'Held at send', tone: 'warn' },
  cancelled: { label: 'Withdrawn', tone: 'muted' },
  expired: { label: 'Expired', tone: 'muted' },
  duplicate_blocked: { label: 'Duplicate stopped', tone: 'muted' },
}

export function queueWords(status: string | null | undefined): { label: string; tone: string } {
  const key = String(status ?? '').trim()
  if (!key) return { label: '—', tone: 'muted' }
  if (QUEUE_WORDS[key]) return QUEUE_WORDS[key]
  if (key.startsWith('paused_') || key.startsWith('blocked')) return { label: 'Held', tone: 'warn' }
  return { label: key.replace(/_/g, ' '), tone: 'muted' }
}

export function isOverdueRow(row: CockpitTargetRow, now = Date.now()): boolean {
  const q = row.queue
  if (!q || !['queued', 'scheduled', 'pending', 'ready', 'approved'].includes(String(q.status))) return false
  const at = Date.parse(String(q.scheduled_for ?? ''))
  return Number.isFinite(at) && at <= now - OVERDUE_GRACE_MS
}

/** TARGETS — dense, paginated, one row per seller, with what the queue did. */
export function CockpitTargets({
  campaign, k, filter, onFilter, selectedId, onSelect,
}: {
  campaign: CampaignSummary
  k: CockpitRead | null
  filter: TargetFilter
  onFilter: (f: TargetFilter) => void
  selectedId: string | null
  onSelect: (row: CockpitTargetRow) => void
}) {
  const [page, setPage] = useState<CockpitTargetPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(filter.search)
  const [attempt, setAttempt] = useState(0)
  const tz = k?.window.timezone ?? campaign.lineage?.timezone ?? null
  const statusCounts = k?.targets?.by_status ?? null
  const lastKey = useRef('')

  // Search as you type, one request per pause.
  useEffect(() => {
    if (query === filter.search) return
    const id = window.setTimeout(() => onFilter({ ...filter, search: query, page: 1 }), 320)
    return () => window.clearTimeout(id)
  }, [query, filter, onFilter])

  useEffect(() => {
    const key = `${campaign.id}|${filter.status}|${filter.search}|${filter.page}|${attempt}`
    if (key === lastKey.current) return
    lastKey.current = key
    const ctl = new AbortController()
    setLoading(true)
    setError(null)
    fetchCockpitTargets(campaign.id, { page: filter.page, pageSize: PAGE_SIZE, status: filter.status, search: filter.search }, ctl.signal)
      .then((res) => { setPage(res); setLoading(false) })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return
        setError(err instanceof Error ? err.message : 'unavailable')
        setLoading(false)
      })
    return () => ctl.abort()
  }, [campaign.id, filter.status, filter.search, filter.page, attempt])

  const chips: Array<{ key: TargetFilter['status']; label: string; n: number | null }> = [
    { key: 'all', label: 'All', n: k?.targets?.total ?? campaign.total_targets },
    { key: 'planned', label: 'Handed to queue', n: statusCounts ? Number(statusCounts.planned ?? 0) : null },
    { key: 'ready', label: 'Ready', n: statusCounts ? Number(statusCounts.ready ?? 0) : null },
    { key: 'blocked', label: 'Held', n: statusCounts ? Number(statusCounts.blocked ?? 0) : null },
  ]

  const from = page && page.total ? (page.page - 1) * page.page_size + 1 : 0
  const to = page ? Math.min(page.total, page.page * page.page_size) : 0

  return (
    <section className="cpk-targets" aria-label="Targets">
      <div className="cpk-targets__bar">
        <div className="cpk-seg" role="tablist" aria-label="Target state">
          {chips.map((ch) => (
            <button key={ch.key} type="button" role="tab" aria-selected={filter.status === ch.key} className={cls('cpk-seg__btn', filter.status === ch.key && 'is-on')} onClick={() => onFilter({ ...filter, status: ch.key, page: 1 })}>
              {ch.label}{ch.n !== null ? <b>{nf(ch.n)}</b> : null}
            </button>
          ))}
        </div>
        <label className="cpk-search is-inline">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Seller, address, phone, market" aria-label="Search targets" />
        </label>
      </div>

      {error ? (
        <div className="cpk-targets__empty">
          <p>Targets couldn’t be loaded.</p>
          <button type="button" className="cpk-btn is-ghost" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : (
        <div className={cls('cpk-table-wrap', loading && 'is-loading')}>
          <table className="cpk-table">
            <thead>
              <tr>
                <th scope="col">Seller</th>
                <th scope="col">Property</th>
                <th scope="col">State</th>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Scheduled</th>
                <th scope="col">Sent</th>
                <th scope="col">Reply</th>
                <th scope="col">Hold reason</th>
              </tr>
            </thead>
            <tbody>
              {(page?.targets ?? []).map((row) => {
                const t = TARGET_WORDS[String(row.target_status)] ?? { label: String(row.target_status ?? '—'), tone: 'muted' }
                const q = queueWords(row.queue?.status)
                const overdue = isOverdueRow(row)
                const intent = row.reply ? describeIntent(row.reply.intent) : null
                return (
                  <tr
                    key={row.id}
                    className={cls('cpk-tr', selectedId === row.id && 'is-selected', row.target_status === 'blocked' && 'is-held')}
                    onClick={() => onSelect(row)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onSelect(row) }}
                  >
                    <td className="cpk-td-seller">
                      <b>{row.seller ?? '—'}</b>
                      <span>{formatPhone(row.phone)}</span>
                    </td>
                    <td className="cpk-td-prop">{row.property ?? '—'}</td>
                    <td><span className={cls('cpk-pill', `is-${t.tone}`)}>{t.label}</span></td>
                    <td className="cpk-td-dim">SMS</td>
                    <td>
                      {row.queue ? (
                        <span className={cls('cpk-pill', `is-${overdue ? 'bad' : q.tone}`)}>{q.label}{overdue ? ' · overdue' : ''}</span>
                      ) : <span className="cpk-td-dim">—</span>}
                    </td>
                    <td className="cpk-td-time">{row.queue?.scheduled_for ? whenIn(row.queue.scheduled_for, tz) : '—'}</td>
                    <td className="cpk-td-time">{row.queue?.sent_at ? whenIn(row.queue.sent_at, tz) : '—'}</td>
                    <td>{intent ? <span className={cls('cpk-pill', `is-intent-${intent.tone}`)}>{intent.label}</span> : <span className="cpk-td-dim">—</span>}</td>
                    <td className="cpk-td-hold">{row.target_status === 'blocked' && row.block_reason ? holdWords(row.block_reason) : row.queue?.reason && ['blocked_by_health_guard', 'failed', 'failed_transport'].includes(String(row.queue.status)) ? row.queue.reason.replace(/_/g, ' ') : ''}</td>
                  </tr>
                )
              })}
              {!loading && page && !page.targets.length ? (
                <tr><td colSpan={9} className="cpk-td-empty">{filter.search ? 'No target matches this search.' : 'No targets in this state.'}</td></tr>
              ) : null}
            </tbody>
          </table>
          {loading && !page ? <div className="cpk-table__skel" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</div> : null}
        </div>
      )}

      <footer className="cpk-pager">
        <span>{page ? (page.total ? `${nf(from)}–${nf(to)} of ${nf(page.total)}` : '0 targets') : loading ? 'Loading…' : ''}</span>
        {page?.truncated.queue || page?.truncated.replies ? <span className="cpk-muted">Some rows show partial history.</span> : null}
        <span className="cpk-pager__btns">
          <button type="button" className="cpk-icon-btn" aria-label="Previous page" disabled={!page || page.page <= 1 || loading} onClick={() => onFilter({ ...filter, page: filter.page - 1 })}><Icon name="chevron-left" size={14} /></button>
          <button type="button" className="cpk-icon-btn" aria-label="Next page" disabled={!page || page.page >= page.total_pages || loading} onClick={() => onFilter({ ...filter, page: filter.page + 1 })}><Icon name="chevron-right" size={14} /></button>
        </span>
      </footer>
    </section>
  )
}
