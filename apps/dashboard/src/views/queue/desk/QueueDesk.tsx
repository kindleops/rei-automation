import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  LCButton, LCChip, LCDataGrid, LCEmpty, LCIconButton, LCKbd, LCProgress, LCSearch, LCSegmented, LCSelect, LCStatus, LCTabs, LCTooltip,
  type LCColumn, type LCMenuEntry, type LCTabItem,
} from '../../../shared/lc'
import { objectMenuEntries, propertyObject, sellerObject, type ObjectRef } from '../../../modules/desktop/objects'
import type { QueueItem, QueueModel, QueueRangeCounts } from '../../../domain/queue/queue.types'
import {
  BUCKET_LABEL, bucketOf, flowOf, holdCode, holdLabel, laneMarks, laneWindowFor, reasonBook, spanWords, senderCapacity, zoneLanes, zoneName,
  type DeskBucket, type FlowKey, type ReasonLine,
} from './queue-desk-model'
import './queue-desk.css'

/**
 * QUEUE DESK — the desktop command surface for outbound dispatch (R8.3).
 *
 *   TOP      identity, range / basis, the existing global actions
 *   FLOW     scheduled → queued → sending → sent → delivered, with the held /
 *            approval / failed branches — the range counts when the server
 *            aggregated them, else the page (and it says which)
 *   LANES    one lane per recipient time zone: a 24 h track around now with
 *            every page row placed at its send (or sent) time
 *   GRID     the page as an LCDataGrid (keyboard, selection, object menu)
 *   SIDE     sender capacity from the fleet's own caps; holds + failures by
 *            their canonical reason
 *   DOCK     the existing dossier (CommandIntelligenceDock), unchanged
 *
 * Presentation only. Every write is the page's existing action, reached
 * through `onRowAction` (which asks with lcConfirm first) or the page's
 * existing confirm modal for global actions. Nothing here sends.
 */

export type DeskSection = 'queue' | 'templates' | 'senders' | 'market' | 'failures' | 'events'
export type DeskRange = 'today' | '24h' | '7d' | '14d' | '30d' | '60d' | '90d' | 'all' | 'custom'
export type DeskBasis = 'created_at' | 'scheduled_for' | 'updated_at'

const RANGE_OPTIONS: Array<{ value: Exclude<DeskRange, 'custom'>; label: string }> = [
  { value: 'today', label: 'Today' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' },
  { value: '14d', label: '14d' }, { value: '30d', label: '30d' }, { value: '90d', label: '90d' }, { value: 'all', label: 'All' },
]
const RANGE_WORDS: Record<DeskRange, string> = {
  today: 'Today', '24h': 'Last 24 hours', '7d': 'Last 7 days', '14d': 'Last 14 days', '30d': 'Last 30 days',
  '60d': 'Last 60 days', '90d': 'Last 90 days', all: 'All time', custom: 'Custom range',
}
const BASIS_OPTIONS: Array<{ value: DeskBasis; label: string; hint: string }> = [
  { value: 'created_at', label: 'Created', hint: 'When the row was queued' },
  { value: 'scheduled_for', label: 'Scheduled', hint: 'When it is due to send' },
  { value: 'updated_at', label: 'Updated', hint: 'Last status change' },
]

const BUCKET_TONE: Record<DeskBucket, 'exec' | 'ok' | 'attn' | 'crit' | 'neutral'> = {
  upcoming: 'exec', inflight: 'exec', done: 'ok', failed: 'crit', held: 'attn', other: 'neutral',
}

export type DeskRowAction = 'approve' | 'retry' | 'cancel' | 'view-thread'

export interface QueueDeskProps {
  model: QueueModel | null
  items: QueueItem[]
  rows: QueueItem[]
  kpi: QueueRangeCounts
  kpiIsRange: boolean
  loading: boolean
  range: DeskRange
  onRange: (r: DeskRange) => void
  basis: DeskBasis
  onBasis: (b: DeskBasis) => void
  statusFilter: string
  onStatusFilter: (s: string) => void
  search: string
  onSearch: (q: string) => void
  market: string
  marketOptions: string[]
  onMarket: (m: string) => void
  sender: string
  senderOptions: string[]
  onSender: (s: string) => void
  template: string
  templateOptions: string[]
  onTemplate: (t: string) => void
  causeFilter: string | null
  causeLabel: (c: string) => string
  onCause: (c: string | null) => void
  failureCause: (item: QueueItem) => string | null
  failureLabels: Record<string, string>
  section: DeskSection
  onSection: (s: DeskSection) => void
  sectionCounts: Partial<Record<DeskSection, number>>
  sectionBody: ReactNode
  dock: ReactNode
  dockOpen: boolean
  selectedId: string | null
  onActivate: (item: QueueItem) => void
  selected: Set<string>
  onSelected: (next: Set<string>) => void
  onRowAction: (action: DeskRowAction, item: QueueItem) => void
  /** the page's existing global actions (they open its own confirm) */
  onGlobal: ((action: 'retry-all-failed' | 'run-queue-now') => void) | null
  busyAction: string | null
  onRefresh: () => void
  paging: { page: number; pages: number; total: number; pageSize: number; pageSizes: readonly number[]; onPage: (p: number) => void; onPageSize: (n: number) => void }
  overlays: ReactNode
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

const nf = (n: number) => n.toLocaleString('en-US')
const last4 = (p: string | null | undefined) => (p ? `··${p.replace(/\D/g, '').slice(-4)}` : '—')

function relWhen(iso: string | null | undefined, now: number): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const d = t - now
  const a = Math.abs(d)
  const m = Math.round(a / 60_000)
  const txt = m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  if (txt === 'now') return 'now'
  return d > 0 ? `in ${txt}` : `${txt} ago`
}

function localTimeOf(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
  } catch { return '—' }
}

function objectOf(item: QueueItem): ObjectRef | null {
  if (item.linkedInboxThreadId) {
    return sellerObject({ threadKey: item.linkedInboxThreadId, masterOwnerId: item.linkedOwnerId, propertyId: item.linkedPropertyId, propertyLabel: item.propertyAddress, label: item.sellerName, source: 'queue' })
  }
  if (item.linkedPropertyId) return propertyObject({ propertyId: item.linkedPropertyId, masterOwnerId: item.linkedOwnerId, label: item.propertyAddress, source: 'queue' })
  return null
}

/* ── flow instrument ───────────────────────────────────────────────────── */

function FlowInstrument({ kpi, scope, loading, active, onPick }: { kpi: QueueRangeCounts; scope: string; loading: boolean; active: string; onPick: (k: FlowKey | 'all') => void }) {
  const { main, branches } = useMemo(() => flowOf(kpi), [kpi])
  const peak = Math.max(1, ...main.map((n) => n.count))
  return (
    <section className="qdk-flow" aria-label="Dispatch flow" data-loading={loading ? '' : undefined}>
      <header className="qdk-flow__head">
        <span className="qdk-eyebrow">Dispatch flow</span>
        <span className="qdk-flow__scope">{scope}</span>
        {active !== 'all' ? <button type="button" className="qdk-link" onClick={() => onPick('all')}>Show all</button> : null}
      </header>
      <ol className="qdk-flow__main">
        {main.map((n, i) => (
          <li key={n.key} className="qdk-node" data-tone={n.tone} data-active={active === n.key ? '' : undefined} data-zero={n.count === 0 ? '' : undefined}>
            <LCTooltip content={n.hint}>
              <button type="button" className="qdk-node__btn" onClick={() => onPick(active === n.key ? 'all' : n.key)} aria-pressed={active === n.key}>
                <span className="qdk-node__label">{n.label}</span>
                <span className="qdk-node__value">{loading ? '—' : nf(n.count)}</span>
                <span className="qdk-node__bar" aria-hidden="true"><i style={{ inlineSize: `${Math.max(n.count ? 3 : 0, (n.count / peak) * 100)}%` }} /></span>
              </button>
            </LCTooltip>
            {i < main.length - 1 ? <span className="qdk-node__arrow" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
      <ul className="qdk-flow__branches" aria-label="Off the main path">
        {branches.map((n) => (
          <li key={n.key}>
            <LCTooltip content={n.hint}>
              <button type="button" className="qdk-branch" data-tone={n.tone} data-zero={n.count === 0 ? '' : undefined} data-active={active === n.key ? '' : undefined} onClick={() => onPick(active === n.key ? 'all' : n.key)} aria-pressed={active === n.key}>
                <span className="qdk-branch__dot" aria-hidden="true" />
                <span>{n.label}</span>
                <b>{loading ? '—' : nf(n.count)}</b>
              </button>
            </LCTooltip>
          </li>
        ))}
        <li className="qdk-flow__optout">
          <span>Opt-outs</span>
          <b>{loading ? '—' : nf(kpi.optOuts)}</b>
        </li>
      </ul>
    </section>
  )
}

/* ── time-zone lanes ───────────────────────────────────────────────────── */

const LANE_BUCKETS: DeskBucket[] = ['upcoming', 'inflight', 'done', 'held', 'failed']

function ZoneLanes({ rows, now, zone, onZone }: { rows: QueueItem[]; now: number; zone: string | null; onZone: (tz: string | null) => void }) {
  const win = useMemo(() => laneWindowFor(rows, now), [rows, now])
  const lanes = useMemo(() => zoneLanes(rows, now, win), [rows, now, win])
  const marks = useMemo(() => laneMarks(win, now), [win, now])
  const at = (ms: number) => `${((ms - win.fromMs) / (win.toMs - win.fromMs)) * 100}%`
  return (
    <section className="qdk-lanes" aria-label="Recipient time zones">
      <header className="qdk-lanes__head">
        <span className="qdk-eyebrow">Recipient time zones</span>
        <span className="qdk-lanes__note">This page · placed at send (or sent) time · {spanWords(win, now)}</span>
        <span className="qdk-legend" aria-hidden="true">
          {LANE_BUCKETS.map((b) => <span key={b} data-bucket={b}><i />{BUCKET_LABEL[b]}</span>)}
        </span>
      </header>
      {lanes.length === 0 ? (
        <p className="qdk-lanes__empty">No rows on this page to place.</p>
      ) : (
        <div className="qdk-lanes__grid" role="list">
          <div className="qdk-lane qdk-lane--axis" aria-hidden="true">
            <span className="qdk-lane__who" />
            <span className="qdk-lane__track">
              {marks.map((m) => <span key={m.at} className="qdk-lane__mark" style={{ insetInlineStart: at(m.at) }}>{m.label}</span>)}
            </span>
            <span className="qdk-lane__counts" />
          </div>
          {lanes.map((lane) => (
            <button
              key={lane.tz}
              type="button"
              role="listitem"
              className="qdk-lane"
              data-active={zone === lane.tz ? '' : undefined}
              data-dim={zone && zone !== lane.tz ? '' : undefined}
              onClick={() => onZone(zone === lane.tz ? null : lane.tz)}
              aria-pressed={zone === lane.tz}
              title={lane.tz === 'Unknown' ? 'Rows without a recorded recipient time zone' : `${lane.tz} · ${lane.total} rows on this page${lane.outside ? ` · ${lane.outside} outside the drawn window` : ''}`}
            >
              <span className="qdk-lane__who">
                <b>{lane.label}</b>
                <small>{lane.tz === 'Unknown' ? 'no zone' : lane.localTime}</small>
              </span>
              <span className="qdk-lane__track">
                {marks.map((m) => <i key={m.at} className="qdk-lane__grid" data-now={m.now ? '' : undefined} style={{ insetInlineStart: at(m.at) }} />)}
                {lane.ticks.map((t) => <i key={t.id} className="qdk-tick" data-bucket={t.bucket} style={{ insetInlineStart: `${t.pos * 100}%` }} />)}
              </span>
              <span className="qdk-lane__counts">
                <b>{nf(lane.total)}</b>
                {lane.counts.held ? <span data-bucket="held">{nf(lane.counts.held)} held</span> : null}
                {lane.counts.failed ? <span data-bucket="failed">{nf(lane.counts.failed)} failed</span> : null}
                {lane.outside ? <span className="is-quiet">{nf(lane.outside)} off-window</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

/* ── side planes ───────────────────────────────────────────────────────── */

function CapacityPlane({ model, items, sender, onSender }: { model: QueueModel | null; items: QueueItem[]; sender: string; onSender: (s: string) => void }) {
  const fleet = model?.textgridFleet ?? null
  const cap = useMemo(() => senderCapacity(fleet ?? [], items), [fleet, items])
  return (
    <section className="qdk-plane" aria-label="Sender capacity">
      <header className="qdk-plane__head">
        <span className="qdk-eyebrow">Sender capacity · today</span>
        {fleet ? <span className="qdk-plane__meta">{nf(cap.active)} active{cap.inactive ? ` · ${nf(cap.inactive)} off` : ''}</span> : null}
      </header>
      {!fleet ? (
        <LCEmpty compact title="Fleet not read" body="The sender fleet did not come back with this page." />
      ) : fleet.length === 0 ? (
        <LCEmpty compact title="No sender numbers" body="The fleet registry is empty." />
      ) : (
        <>
          <div className="qdk-cap__total">
            <span className="qdk-cap__big">{nf(cap.sentToday)}</span>
            <span className="qdk-cap__of">{cap.cap !== null ? `of ${nf(cap.cap)} daily cap` : 'sent today · no caps recorded'}</span>
            {cap.cap !== null ? <LCProgress value={cap.sentToday} max={cap.cap} tone="exec" label="Fleet daily cap used" valueText={`${nf(cap.sentToday)} of ${nf(cap.cap)}`} /> : null}
            {cap.uncapped ? <small className="qdk-cap__note">{nf(cap.uncapped)} active number{cap.uncapped === 1 ? '' : 's'} without a recorded cap</small> : null}
          </div>
          <ul className="qdk-cap__list lc-scroll">
            {cap.lines.map((l) => (
              <li key={l.phone}>
                <button type="button" className="qdk-cap__line" data-off={l.active ? undefined : ''} data-active={sender === l.phone ? '' : undefined} onClick={() => onSender(sender === l.phone ? 'all' : l.phone)} aria-pressed={sender === l.phone} title={`${l.phone} · ${l.status}`}>
                  <span className="qdk-cap__name"><b>{l.name}</b><small>{l.active ? l.market : l.status}</small></span>
                  <span className="qdk-cap__meter" aria-hidden="true"><i data-hot={l.used !== null && l.used >= 0.9 ? '' : undefined} style={{ inlineSize: `${(l.used ?? 0) * 100}%` }} /></span>
                  <span className="qdk-cap__num">{nf(l.sentToday)}{l.cap ? <small>/{nf(l.cap)}</small> : null}</span>
                  {l.pending ? <span className="qdk-cap__pending" title="Rows on this page still to go out from this number">{nf(l.pending)} due</span> : <span />}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function ReasonPlane({ lines, active, onPick }: { lines: ReasonLine[]; active: string | null; onPick: (l: ReasonLine) => void }) {
  const holds = lines.filter((l) => l.kind === 'hold')
  const fails = lines.filter((l) => l.kind === 'failure')
  const group = (title: string, list: ReasonLine[], note: string) => (
    <div className="qdk-reasons__group">
      <span className="qdk-reasons__title">{title}<small>{note}</small></span>
      {list.length === 0 ? <span className="qdk-reasons__none">None on this page</span> : (
        <ul>
          {list.map((l) => (
            <li key={`${l.kind}:${l.code}`}>
              <button type="button" className="qdk-reason" data-kind={l.kind} data-active={active === `${l.kind}:${l.code}` ? '' : undefined} onClick={() => onPick(l)} title={l.code}>
                <span className="qdk-reason__dot" aria-hidden="true" />
                <span className="qdk-reason__label">{l.label}{l.sender ? <small>sender routing · parked, no retry used</small> : null}</span>
                <b>{nf(l.count)}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <section className="qdk-plane" aria-label="Holds and failures">
      <header className="qdk-plane__head"><span className="qdk-eyebrow">Holds & failures</span><span className="qdk-plane__meta">this page</span></header>
      <div className="qdk-reasons">
        {group('Held', holds, 'before any provider call')}
        {group('Failed', fails, 'rejected or undeliverable')}
      </div>
    </section>
  )
}

/* ── the desk ──────────────────────────────────────────────────────────── */

export function QueueDesk(p: QueueDeskProps) {
  const now = useMinuteClock()
  const [zone, setZone] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)

  const { items: pageItems, failureCause, failureLabels } = p
  const reasons = useMemo(() => reasonBook(pageItems, ((i: QueueItem) => failureCause(i) ?? 'unknown') as (i: never) => string, failureLabels), [pageItems, failureCause, failureLabels])

  const gridRows = useMemo(() => {
    let r = p.rows
    if (zone) r = r.filter((i) => (i.timezone || 'Unknown') === zone)
    if (reason && reason.startsWith('hold:')) {
      const code = reason.slice(5)
      r = r.filter((i) => bucketOf(i.status) === 'held' && holdCode(i) === code)
    }
    return r
  }, [p.rows, zone, reason])

  const pickReason = (l: ReasonLine) => {
    const key = `${l.kind}:${l.code}`
    if (reason === key) {
      setReason(null)
      if (l.kind === 'failure') p.onCause(null)
      return
    }
    setReason(key)
    if (l.kind === 'failure') { p.onCause(l.code); p.onStatusFilter('failed') } else { p.onCause(null); p.onStatusFilter('blocked') }
  }

  const columns = useMemo((): LCColumn<QueueItem>[] => [
    {
      id: 'seller', header: 'Seller · property', minWidth: 190,
      render: (i) => (
        <span className="qdk-cell-2">
          <b>{i.sellerName}</b>
          <small>{i.propertyAddress}</small>
        </span>
      ),
    },
    {
      id: 'zone', header: 'Recipient time', width: 168, hint: 'The recipient’s wall clock at the send (or sent) time, and how far that is from now',
      render: (i) => (
        <span className="qdk-cell-2">
          <b>{localTimeOf(i.sentAt || i.scheduledForUtc, i.timezone)}</b>
          <small>{i.timezone ? zoneName(i.timezone) : 'Zone not recorded'} · {relWhen(i.sentAt || i.scheduledForUtc, now)}</small>
        </span>
      ),
    },
    {
      id: 'campaign', header: 'Campaign · template', minWidth: 150, hideable: true,
      render: (i) => (
        <span className="qdk-cell-2">
          <b>{i.campaignName || (i.campaignId ? 'Campaign' : 'Not from a campaign')}</b>
          <small>{i.templateName}</small>
        </span>
      ),
    },
    {
      id: 'sender', header: 'Sender', width: 116, hideable: true,
      render: (i) => (
        <span className="qdk-cell-2">
          <b className="qdk-num">{i.fromPhoneNumber ? last4(i.fromPhoneNumber) : 'Unassigned'}</b>
          <small>{i.market}</small>
        </span>
      ),
    },
    {
      id: 'status', header: 'Status', width: 180,
      render: (i) => {
        const b = bucketOf(i.status)
        const why = b === 'held' ? holdLabel(holdCode(i)) : b === 'failed' ? (p.failureLabels[p.failureCause(i) ?? 'unknown'] ?? null) : null
        return (
          <span className="qdk-status">
            <LCStatus tone={BUCKET_TONE[b]} label={i.statusLabel || BUCKET_LABEL[b]} quiet={b === 'done' || b === 'other'} />
            {why ? <small>{why}</small> : null}
          </span>
        )
      },
    },
  ], [now, p])

  const rowMenu = (i: QueueItem): LCMenuEntry[] => {
    const extra: LCMenuEntry[] = []
    if (i.linkedInboxThreadId) extra.push({ id: 'thread', label: 'Open conversation', icon: 'message', onSelect: () => p.onRowAction('view-thread', i) })
    if (i.status === 'approval') extra.push({ id: 'approve', label: 'Approve…', icon: 'check', onSelect: () => p.onRowAction('approve', i) })
    if (bucketOf(i.status) === 'failed' && i.retryEligible) extra.push({ id: 'retry', label: 'Retry…', icon: 'refresh-cw', onSelect: () => p.onRowAction('retry', i) })
    if (!['cancelled', 'delivered', 'sent'].includes(i.status)) extra.push({ id: 'cancel', label: 'Suppress…', icon: 'slash', tone: 'danger', onSelect: () => p.onRowAction('cancel', i) })
    return objectMenuEntries(objectOf(i), { extra })
  }

  const tabs: LCTabItem<DeskSection>[] = [
    { id: 'queue', label: 'Dispatch' },
    { id: 'templates', label: 'Templates', count: p.sectionCounts.templates ?? null },
    { id: 'senders', label: 'Senders', count: p.sectionCounts.senders ?? null },
    { id: 'market', label: 'Markets', count: p.sectionCounts.market ?? null },
    { id: 'failures', label: 'Failures', count: p.sectionCounts.failures ?? null, tone: (p.sectionCounts.failures ?? 0) > 0 ? 'crit' : undefined },
    { id: 'events', label: 'Events' },
  ]

  const chips: ReactNode[] = []
  if (p.statusFilter !== 'all') chips.push(<LCChip key="s" field="Status" value={p.statusFilter === 'blocked' ? 'Held' : p.statusFilter.replace(/^\w/, (c) => c.toUpperCase())} onRemove={() => { p.onStatusFilter('all'); setReason(null) }} />)
  if (zone) chips.push(<LCChip key="z" field="Zone" value={zone === 'Unknown' ? 'Not recorded' : zoneName(zone)} onRemove={() => setZone(null)} />)
  if (p.causeFilter) chips.push(<LCChip key="c" field="Cause" value={p.causeLabel(p.causeFilter)} onRemove={() => { p.onCause(null); setReason(null) }} />)
  if (reason?.startsWith('hold:')) chips.push(<LCChip key="h" field="Hold" value={holdLabel(reason.slice(5))} onRemove={() => setReason(null)} />)

  const { page, pages, total, pageSize } = p.paging
  const rowStart = total === 0 ? 0 : page * pageSize + 1
  const rowEnd = Math.min((page + 1) * pageSize, total)
  const scope = p.kpiIsRange ? `${RANGE_WORDS[p.range]} · whole range` : 'This page only — range totals unavailable'
  const dispatch = p.section === 'queue'

  return (
    <div className="qdk" data-dock={p.dockOpen ? '' : undefined} data-section={p.section}>
      {p.overlays}
      <header className="qdk-top">
        <div className="qdk-top__id">
          <h1>Queue</h1>
          <p>
            <span>Outbound dispatch</span>
            <span>{RANGE_WORDS[p.range]}</span>
            <span>by {BASIS_OPTIONS.find((b) => b.value === p.basis)?.label.toLowerCase()} time</span>
            {p.loading ? <span className="qdk-top__sync" role="status">Refreshing</span> : null}
          </p>
        </div>
        <div className="qdk-top__controls">
          <LCSegmented<DeskRange> label="Date range" size="sm" value={p.range === '60d' || p.range === 'custom' ? '30d' : p.range} onChange={p.onRange} options={RANGE_OPTIONS} />
          <LCSelect<DeskBasis> label="Date basis" prefix="Basis" variant="quiet" size="sm" value={p.basis} onChange={p.onBasis} options={BASIS_OPTIONS} />
          {p.onGlobal ? (
            <>
              <LCButton size="sm" variant="secondary" icon="refresh-cw" loading={p.busyAction === 'retry-all-failed'} disabled={p.busyAction !== null || p.kpi.failed === 0} onClick={() => p.onGlobal?.('retry-all-failed')}>Retry failed…</LCButton>
              <LCButton size="sm" variant="secondary" icon="play" loading={p.busyAction === 'run-queue-now'} disabled={p.busyAction !== null} onClick={() => p.onGlobal?.('run-queue-now')}>Run queue…</LCButton>
            </>
          ) : null}
          <LCIconButton icon="refresh-cw" label="Reload" onClick={p.onRefresh} disabled={p.loading} />
        </div>
      </header>

      <FlowInstrument kpi={p.kpi} scope={scope} loading={p.loading && !p.kpiIsRange && p.items.length === 0} active={p.statusFilter} onPick={(k) => { p.onStatusFilter(k); setReason(null) }} />

      <LCTabs<DeskSection> label="Queue views" className="qdk-tabs" value={p.section} onChange={p.onSection} items={tabs} variant="line" />

      <div className="qdk-body">
        {dispatch ? (
          <>
            <main className="qdk-main" aria-label="Dispatch">
              <ZoneLanes rows={p.rows} now={now} zone={zone} onZone={setZone} />
              <div className="qdk-gridwrap">
                <div className="qdk-toolbar">
                  <LCSearch value={p.search} onChange={p.onSearch} label="Search this page" placeholder="Seller, property, campaign, phone" className="qdk-toolbar__search" />
                  <LCSelect label="Market" variant="chip" size="sm" value={p.market} onChange={p.onMarket} options={p.marketOptions.map((m) => ({ value: m, label: m === 'all' ? 'All markets' : m }))} />
                  <LCSelect label="Template" variant="chip" size="sm" value={p.template} onChange={p.onTemplate} options={p.templateOptions.map((m) => ({ value: m, label: m === 'all' ? 'All templates' : m }))} />
                  <LCSelect label="Sender" variant="chip" size="sm" value={p.sender} onChange={p.onSender} options={p.senderOptions.map((m) => ({ value: m, label: m === 'all' ? 'All senders' : last4(m) }))} />
                  {chips.length ? <span className="qdk-toolbar__chips">{chips}</span> : null}
                </div>
                <div className="qdk-grid">
                  <LCDataGrid<QueueItem>
                    id="queue-desk"
                    label="Queue rows"
                    rows={gridRows}
                    rowKey={(i) => i.id}
                    columns={columns}
                    activeKey={p.selectedId}
                    onActivate={(i) => p.onActivate(i)}
                    selected={p.selected}
                    onSelectedChange={p.onSelected}
                    density="comfortable"
                    rowMenu={rowMenu}
                    rowTone={(i) => { const b = bucketOf(i.status); return b === 'failed' ? 'crit' : b === 'held' ? 'attn' : null }}
                    loading={p.loading && p.items.length === 0}
                    empty={p.items.length === 0 ? { title: 'No queue rows in this range', body: 'Widen the range or change the date basis.' } : { title: 'Nothing matches', body: 'Clear a filter to see the page again.' }}
                  />
                </div>
                <footer className="qdk-foot">
                  <span className="qdk-foot__keys"><LCKbd keys={['↑', '↓']} /> move <LCKbd keys={['↵']} /> inspect <LCKbd keys={['Space']} /> select <LCKbd keys={['Esc']} /> close</span>
                  <span className="qdk-foot__count">{gridRows.length !== p.items.length ? `${nf(gridRows.length)} shown · ` : ''}{nf(rowStart)}–{nf(rowEnd)} of {nf(total)}</span>
                  <span className="qdk-foot__pager">
                    <LCSelect<string> label="Rows per page" prefix="Rows" variant="quiet" size="sm" value={String(pageSize)} onChange={(v) => p.paging.onPageSize(Number(v))} options={p.paging.pageSizes.map((n) => ({ value: String(n), label: String(n) }))} />
                    <LCIconButton icon="chevron-left" label="Previous page" size="sm" disabled={page === 0} onClick={() => p.paging.onPage(page - 1)} />
                    <span className="qdk-num">{page + 1} / {pages}</span>
                    <LCIconButton icon="chevron-right" label="Next page" size="sm" disabled={page >= pages - 1} onClick={() => p.paging.onPage(page + 1)} />
                  </span>
                </footer>
              </div>
            </main>
            <aside className="qdk-side" aria-label="Capacity and holds">
              <CapacityPlane model={p.model} items={p.items} sender={p.sender} onSender={p.onSender} />
              <ReasonPlane lines={reasons} active={reason} onPick={pickReason} />
            </aside>
          </>
        ) : (
          <main className="qdk-main qdk-main--section" aria-label="Queue intelligence">{p.sectionBody}</main>
        )}
        {p.dockOpen ? <div className="qdk-dock">{p.dock}</div> : null}
      </div>
    </div>
  )
}
