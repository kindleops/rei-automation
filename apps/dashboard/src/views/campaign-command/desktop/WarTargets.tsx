import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { LCDataGrid, LCSearch, LCSegmented, LCSelect, LCToolbar, type LCColumn } from '../../../shared/lc'
import { sound } from '../../../shared/sound'
import { describeIntent } from '../campaign-responses'
import { fetchCockpitTargets, type CockpitTargetRow } from './cockpit-api'
import { holdWords } from './cockpit-model'
import { queueWordsOf } from './war-room-words'
import { dayClock, formatPhone, nf } from './war-room-model'

/**
 * TARGETS — the exact cohort, dense and searchable; one row per seller, what
 * the queue did with them, and whether they replied. Pages of 100 load as
 * the grid scrolls (never the whole cohort at startup).
 */

export type TargetStatus = 'all' | 'planned' | 'ready' | 'blocked'
const PAGE = 100

/** DEV demo only: the same filters the targets read applies, over fixture rows. */
function filterRows(rows: CockpitTargetRow[], status: TargetStatus, search: string, reason: string | null): CockpitTargetRow[] {
  const q = search.trim().toLowerCase()
  return rows.filter((r) => (status === 'all' || r.target_status === status)
    && (!reason || r.block_reason === reason)
    && (!q || [r.seller, r.property, r.phone, r.market].some((v) => String(v ?? '').toLowerCase().includes(q))))
}

type Pages = { key: string; rows: CockpitTargetRow[]; total: number | null; next: number | null; error: string | null }

export const TargetsMode = memo(function TargetsMode({
  campaignId, tz, counts, heldReasons, status, reason, onStatus, onReason, activeId, onActivate, now, demoRows,
}: {
  campaignId: string
  tz: string | null
  counts: { all: number | null; planned: number | null; ready: number | null; blocked: number | null }
  heldReasons: Array<{ code: string; label: string; n: number }>
  status: TargetStatus
  reason: string | null
  onStatus: (s: TargetStatus) => void
  onReason: (code: string | null) => void
  activeId: string | null
  onActivate: (row: CockpitTargetRow) => void
  now: number
  /** DEV demo fixtures — when set, nothing is fetched */
  demoRows?: CockpitTargetRow[]
}) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const key = `${campaignId}|${status}|${reason ?? ''}|${search}`
  const [pages, setPages] = useState<Pages>({ key: '', rows: [], total: null, next: 1, error: null })
  const [want, setWant] = useState<{ key: string; page: number }>({ key: '', page: 1 })
  const inflight = useRef<string | null>(null)

  // debounce typing into one request per pause
  useEffect(() => {
    if (query === search) return
    const id = window.setTimeout(() => setSearch(query), 320)
    return () => window.clearTimeout(id)
  }, [query, search])

  const current = pages.key === key ? pages : { key, rows: [], total: null, next: 1, error: null }
  const page = want.key === key ? want.page : 1
  useEffect(() => {
    if (demoRows || current.next === null || page < current.next) return
    const tag = `${key}#${current.next}`
    if (inflight.current === tag) return
    inflight.current = tag
    const ctl = new AbortController()
    const n = current.next
    fetchCockpitTargets(campaignId, { page: n, pageSize: PAGE, status, search, reason }, ctl.signal).then(
      (res) => {
        inflight.current = null
        setPages((p) => {
          const base = p.key === key ? p.rows : []
          return { key, rows: [...base, ...res.targets], total: res.total, next: res.page < res.total_pages ? res.page + 1 : null, error: null }
        })
      },
      (err: unknown) => {
        inflight.current = null
        if (ctl.signal.aborted) return
        setPages((p) => ({ ...(p.key === key ? p : { key, rows: [], total: null, next: n }), error: err instanceof Error ? err.message : 'unavailable' }))
      },
    )
    return () => { ctl.abort(); if (inflight.current === tag) inflight.current = null }
  }, [campaignId, status, search, reason, key, page, current.next, demoRows])

  const demoView = useMemo(() => (demoRows ? filterRows(demoRows, status, search, reason) : null), [demoRows, status, search, reason])
  const rows = demoView ?? current.rows
  const total = demoView ? demoView.length : current.total
  // still loading only while a first page is owed — an empty answer is an answer
  const firstPageOwed = !demoView && current.rows.length === 0 && current.next !== null && !current.error

  const columns = useMemo<LCColumn<CockpitTargetRow>[]>(() => [
    { id: 'seller', header: 'Seller', minWidth: 230, render: (r) => <span className="cc3-cell-two"><b>{r.seller ?? '—'}</b><span className="lc-num">{formatPhone(r.phone)}</span></span> },
    { id: 'property', header: 'Property', minWidth: 190, render: (r) => <span className="cc3-cell-trunc" title={r.property ?? ''}>{r.property ?? '—'}</span> },
    { id: 'market', header: 'Market', width: 130, hideable: true, render: (r) => r.market ?? '—' },
    {
      id: 'status', header: 'Status', width: 128, render: (r) => {
        const s = r.target_status === 'blocked' ? { t: 'Held', tone: 'attn' } : r.target_status === 'planned' ? { t: 'Handed to queue', tone: 'exec' } : r.target_status === 'ready' ? { t: 'Ready', tone: 'neutral' } : { t: r.target_status ?? '—', tone: 'neutral' }
        return <span className="cc3-chip" data-tone={s.tone}>{s.t}</span>
      },
    },
    { id: 'reason', header: 'Eligibility', minWidth: 170, render: (r) => (r.target_status === 'blocked' && r.block_reason ? <span className="cc3-cell-trunc">{holdWords(r.block_reason)}</span> : <span className="cc3-dim">eligible</span>) },
    { id: 'scheduled', header: 'Scheduled', width: 150, hideable: true, render: (r) => (r.queue?.scheduled_for ? <span className="lc-num">{dayClock(r.queue.scheduled_for, tz, now)}</span> : <span className="cc3-dim">—</span>) },
    { id: 'sender', header: 'Sender', width: 124, hideable: true, render: (r) => (r.queue?.from ? <span className="lc-num">{formatPhone(r.queue.from)}</span> : <span className="cc3-dim">—</span>) },
    {
      id: 'delivery', header: 'Delivery', width: 140, render: (r) => {
        if (!r.queue) return <span className="cc3-dim">not queued</span>
        const q = queueWordsOf(r.queue.status)
        return <span className="cc3-chip" data-tone={q.tone}>{q.label}</span>
      },
    },
    { id: 'sent', header: 'Sent', width: 150, hideable: true, render: (r) => (r.queue?.sent_at ? <span className="lc-num">{dayClock(r.queue.sent_at, tz, now)}</span> : <span className="cc3-dim">—</span>) },
    {
      id: 'reply', header: 'Reply', width: 150, render: (r) => {
        if (!r.reply) return <span className="cc3-dim">—</span>
        const d = describeIntent(r.reply.intent)
        return <span className="cc3-chip" data-tone={d.tone === 'good' ? 'ok' : d.tone === 'bad' ? 'attn' : 'flow'}>{d.label}</span>
      },
    },
  ], [tz, now])

  const statusOptions: Array<{ value: TargetStatus; label: string }> = [
    { value: 'all', label: `All${counts.all !== null ? ` ${nf(counts.all)}` : ''}` },
    { value: 'planned', label: `Handed to queue${counts.planned !== null ? ` ${nf(counts.planned)}` : ''}` },
    { value: 'ready', label: `Ready${counts.ready !== null ? ` ${nf(counts.ready)}` : ''}` },
    { value: 'blocked', label: `Held${counts.blocked !== null ? ` ${nf(counts.blocked)}` : ''}` },
  ]
  return (
    <div className="cc3-targets">
      <LCToolbar
        className="cc3-targets__bar"
        search={<LCSearch value={query} onChange={setQuery} label="Search targets" placeholder="Seller, address, phone, market" />}
        filters={<LCSegmented size="sm" label="Target state" value={status} onChange={(v) => { sound.ui.select(); onStatus(v) }} options={statusOptions} />}
        controls={status === 'blocked' && heldReasons.length ? (
          <LCSelect
            label="Held reason"
            variant="chip"
            size="sm"
            value={reason ?? '__all'}
            onChange={(v) => onReason(v === '__all' ? null : v)}
            options={[{ value: '__all', label: 'Every reason' }, ...heldReasons.map((h) => ({ value: h.code, label: `${h.label} · ${nf(h.n)}` }))]}
          />
        ) : null}
      />
      <LCDataGrid
        id="cc3-targets"
        label="Campaign targets"
        rows={rows}
        rowKey={(r) => r.id}
        columns={columns}
        density="dense"
        activeKey={activeId}
        onActivate={onActivate}
        rowTone={(r) => (r.target_status === 'blocked' ? 'attn' : r.reply ? 'flow' : null)}
        loading={firstPageOwed}
        error={!demoView && current.error && !current.rows.length ? { what: 'Targets didn’t load', onRetry: () => setPages((p) => ({ ...p, key: '' })) } : null}
        empty={{ title: search ? 'No target matches this search' : 'No targets in this state', body: status === 'blocked' ? 'Nothing is held.' : undefined }}
        onEndReached={() => { if (!demoView && current.next !== null) setWant({ key, page: current.next }) }}
        loadingMore={!demoView && current.next !== null && page >= current.next && current.rows.length > 0}
        total={total}
        height="100%"
      />
    </div>
  )
})
