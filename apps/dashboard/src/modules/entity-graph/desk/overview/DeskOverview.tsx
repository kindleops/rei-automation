/**
 * ENTITY GRAPH · OVERVIEW (spec 9 §4; owner 2026-10-09: "an overview section
 * where it shows the advanced metrics and the graph and the charts and
 * basically a breakdown of all the fields filtered").
 *
 *   OverviewBand   collapsible strip above the grid: the headline metrics and
 *                  six pinned charts for the CURRENT filtered cohort
 *   OverviewMode   every field, sectioned like the column groups; sections
 *                  load in viewport order (IntersectionObserver), at most two
 *                  at a time, aborted when the filters change
 *
 * Every number is exact and every bar carries the rail's own chip — clicking
 * it edits the one filter list the rail and the grid read, so everything
 * refetches the same cohort. A section the server could not finish in budget
 * reads "Unavailable — took longer than …" with Retry, never an estimate.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { LCButton, cx } from '../../../../shared/lc'
import { Icon } from '../../../../shared/icons'
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'
import { fetchOverview, OverviewRequestError } from './overview-api'
import { OverviewCard } from './OverviewCard'
import { applyBucketClick, clickModeFromEvent, fmtInt, fmtShare, OVERVIEW_SECTION_ORDER } from './overview-model'
import type { OverviewField, OverviewHeadline, OverviewMetric, OverviewResponse, OverviewSection } from './overview-types'
import './desk-overview.css'

type FiltersChange = (next: EntityGraphFieldFilter[], opts?: { showRecords?: boolean }) => void

const SECTION_LABEL: Record<string, string> = {
  outreach: 'Outreach & pipeline', geography: 'Geography', property: 'Property', distress: 'Distress & signals', value: 'Value & equity',
  debt: 'Debt, liens & sales', ownership: 'Ownership', company: 'Owning company status', owner: 'Owner', people: 'People', contacts: 'Contacts',
  decision: 'Decision Engine', zip: 'ZIP market',
}

/* ── preferences (band open, Overview mode) ─────────────────────────────── */

const BAND_KEY = 'nexus.entityGraph.desk.overviewBand.v1'
const MODE_KEY = 'nexus.entityGraph.desk.overviewMode.v1'
export function useOverviewPrefs(uid: string) {
  const [bandOpen, setBandOpenState] = useState(() => { try { return window.localStorage.getItem(`${BAND_KEY}:${uid}`) !== 'closed' } catch { return true } })
  const [mode, setModeState] = useState(() => { try { return window.sessionStorage.getItem(`${MODE_KEY}:${uid}`) === 'on' } catch { return false } })
  const setBandOpen = (v: boolean) => { setBandOpenState(v); try { window.localStorage.setItem(`${BAND_KEY}:${uid}`, v ? 'open' : 'closed') } catch { /* private mode */ } }
  const setMode = (v: boolean) => { setModeState(v); try { window.sessionStorage.setItem(`${MODE_KEY}:${uid}`, v ? 'on' : 'off') } catch { /* private mode */ } }
  return { bandOpen, setBandOpen, mode, setMode }
}

/* ── loading ────────────────────────────────────────────────────────────── */

type Load = { sig: string; data: OverviewResponse | null; error: string | null; loading: boolean }
const sigOf = (filters: EntityGraphFieldFilter[]) => JSON.stringify(filters)

/** One request at a time per caller; a newer filter set aborts the older request. */
function useOverviewRequest(filters: EntityGraphFieldFilter[], sections: string[], enabled: boolean, gate?: Gate) {
  const sig = `${sigOf(filters)}|${sections.join(',')}`
  const [state, setState] = useState<Load>({ sig: '', data: null, error: null, loading: false })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const ctl = new AbortController()
    setState((cur) => ({ sig, data: cur.data, error: null, loading: true })) // the previous cohort stays on screen, dimmed, until the new one lands
    const go = () => fetchOverview(filters, sections, ctl.signal)
    void (gate ? gate.run(go, ctl.signal) : go())
      .then((data) => { if (!ctl.signal.aborted) setState({ sig, data, error: null, loading: false }) })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return
        const message = e instanceof OverviewRequestError && e.status === 422
          ? 'These filters cannot be charted yet (they need the property facts read model).'
          : e instanceof Error ? e.message : 'The Overview did not load.'
        setState({ sig, data: null, error: message, loading: false })
      })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig encodes filters + sections
  }, [sig, enabled, attempt])
  const current = state.sig === sig
  return { data: state.data, stale: !current || state.loading, error: current ? state.error : null, retry: () => setAttempt((n) => n + 1) }
}

/** At most `limit` section requests in flight (spec §4.4: max 2 concurrent). */
type Gate = { run: <T>(fn: () => Promise<T>, signal: AbortSignal) => Promise<T> }
function useGate(limit = 2): Gate {
  const ref = useRef<{ active: number; queue: Array<() => void> }>({ active: 0, queue: [] })
  return useMemo(() => ({
    run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
      const g = ref.current
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); next(); return }
          g.active += 1
          fn().then(resolve, reject).finally(() => { g.active -= 1; next() })
        }
        const next = () => { const n = g.queue.shift(); if (n) n() }
        if (g.active < limit) start(); else g.queue.push(start)
      })
    },
  }), [limit])
}

/* ── headline ───────────────────────────────────────────────────────────── */

function headlineCards(h: OverviewHeadline, total: number): OverviewField[] {
  const card = (key: string, label: string, buckets: OverviewField['buckets'], note?: string): OverviewField => ({
    key, label, kind: 'tokens', section: 'headline', coverage: { known: total, total, share: 1 }, buckets: buckets ?? [], note,
  })
  const out: OverviewField[] = [card('headline.distress', 'Distress signals', [...h.distress].sort((a, b) => b.count - a.count), h.distressNote)]
  if (h.stack) out.push({ ...card('headline.stack', 'Distress stack', h.stack), kind: 'categorical' })
  if (h.pipeline) out.push({ ...card('headline.pipeline', 'Pipeline stage', h.pipeline, h.definitions?.pipeline), kind: 'categorical' })
  if (h.inbox) out.push({ ...card('headline.inbox', 'Inbox bucket (properties with a thread)', h.inbox, h.definitions?.inbox), kind: 'categorical' })
  if (h.smsReasons) out.push({ ...card('headline.sms', 'SMS eligibility', h.smsReasons, 'The campaign target builder’s readiness verdict, per property.'), kind: 'categorical' })
  return out
}

function Metrics({ headline, total, filters, onFiltersChange, loading }: { headline: OverviewHeadline | null; total: number | null; filters: EntityGraphFieldFilter[]; onFiltersChange: FiltersChange; loading: boolean }) {
  const metrics = headline?.metrics ?? []
  return (
    <div className={cx('egov-metrics', loading && 'is-stale')} role="list" aria-label="Cohort metrics">
      {(metrics.length ? metrics : Array.from({ length: 7 }, (_, i): OverviewMetric => ({ key: `s${i}`, label: '', value: null, basis: '' }))).map((m) => {
        const pct = m.key !== 'cohort' && typeof m.value === 'number' && total ? fmtShare(m.value, total) : null
        const body = (
          <>
            <span className="egov-metric__label">{m.label || <i className="lc-skel egov-skel-line" />}</span>
            <b className="egov-metric__value">{m.label ? (m.value === null ? <span className="egov-metric__na">Not available</span> : fmtInt(m.value)) : <i className="lc-skel egov-skel-num" />}</b>
            <span className="egov-metric__sub">{m.unavailable ? m.unavailable : pct ? `${pct} of the cohort` : m.key === 'cohort' ? 'exact · the grid’s count' : ' '}</span>
          </>
        )
        return m.filter ? (
          <button key={m.key} type="button" role="listitem" className="egov-metric is-clickable" title={`${m.basis}\nClick to filter the cohort to these.`}
            onClick={(e) => { const r = applyBucketClick(filters, m.filter, clickModeFromEvent(e)); if (r.applied) onFiltersChange(r.filters) }}>{body}</button>
        ) : (
          <div key={m.key} role="listitem" className="egov-metric" title={m.basis}>{body}</div>
        )
      })}
    </div>
  )
}

function SourceLine({ data }: { data: OverviewResponse | null }) {
  if (!data?.source) return null
  const at = (s: string | null | undefined) => (s ? new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null)
  return (
    <span className="egov-source" title={data.source.note}>
      <i className={cx('egov-source__dot', data.source.mode === 'facts' ? 'is-facts' : 'is-live')} aria-hidden="true" />
      {data.source.mode === 'facts' ? `Records as of ${at(data.refreshed_at?.facts) ?? '—'}` : 'Live records'}
      {data.refreshed_at?.engagement ? ` · engagement as of ${at(data.refreshed_at.engagement)}` : ''}
      {' · exact'}
    </span>
  )
}

/* ── the band ───────────────────────────────────────────────────────────── */

export function DeskOverviewBand({ filters, onFiltersChange, open, onOpenChange, onOpenMode }: {
  filters: EntityGraphFieldFilter[]
  onFiltersChange: FiltersChange
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenMode: () => void
}) {
  const req = useOverviewRequest(filters, ['pinned', 'headline'], open)
  const data = req.data
  const pinned = data?.sections.find((s) => s.id === 'pinned')?.fields ?? []
  return (
    <section className={cx('egov', 'egov-band', open ? 'is-open' : 'is-closed')} aria-label="Overview">
      <div className="egov-band__bar">
        <button type="button" className="egov-band__toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          <span className="egdk-eyebrow">Overview</span>
        </button>
        <span className="egov-band__summary">
          {data?.total !== null && data?.total !== undefined ? <><b>{fmtInt(data.total)}</b> properties · every chart exact for this cohort</> : open && req.stale ? 'Charting the cohort…' : 'The filtered cohort, field by field'}
        </span>
        <SourceLine data={data} />
        <LCButton size="sm" variant="quiet" icon="stats" onClick={onOpenMode} title="Every field, sectioned like the columns">All fields</LCButton>
      </div>
      {open ? (
        req.error && !data ? (
          <div className="egov-band__error" role="alert"><Icon name="alert-circle" size={13} /> {req.error} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></div>
        ) : (
          <div className={cx('egov-band__body', req.stale && 'is-stale')}>
            <Metrics headline={data?.headline ?? null} total={data?.total ?? null} filters={filters} onFiltersChange={onFiltersChange} loading={req.stale} />
            <div className="egov-grid is-band">
              {pinned.length ? pinned.map((f) => <OverviewCard key={f.key} field={f} filters={filters} onFiltersChange={onFiltersChange} compact />)
                : Array.from({ length: 6 }, (_, i) => <div key={i} className="egov-card is-skeleton" aria-hidden="true"><i className="lc-skel" /></div>)}
            </div>
            {data?.unavailable?.length ? <p className="egov-unavail">{data.unavailable.map((u) => u.reason).filter((v, i, a) => a.indexOf(v) === i).join(' · ')} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></p> : null}
          </div>
        )
      ) : null}
    </section>
  )
}

/* ── the full mode ──────────────────────────────────────────────────────── */

function SectionBlock({ id, filters, onFiltersChange, gate }: { id: string; filters: EntityGraphFieldFilter[]; onFiltersChange: FiltersChange; gate: Gate }) {
  const ref = useRef<HTMLElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setSeen(true) }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  const req = useOverviewRequest(filters, [id], seen, gate)
  const section: OverviewSection | undefined = req.data?.sections.find((s) => s.id === id)
  const fields = section?.fields ?? []
  const live = fields.filter((f) => !f.unavailable)
  const pending = fields.filter((f) => f.unavailable)
  const [showPending, setShowPending] = useState(false)
  return (
    <section ref={ref} id={`egov-sec-${id}`} className={cx('egov-section', req.stale && seen && 'is-stale')} aria-label={SECTION_LABEL[id] ?? id}>
      <header className="egov-section__head">
        <h3>{SECTION_LABEL[id] ?? id}</h3>
        <span className="egov-section__meta">{section ? `${live.length} ${live.length === 1 ? 'field' : 'fields'}${pending.length ? ` · ${pending.length} waiting on the property facts read model` : ''}` : seen ? 'Counting…' : ''}</span>
      </header>
      {req.error ? (
        <div className="egov-band__error" role="alert"><Icon name="alert-circle" size={13} /> {req.error} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></div>
      ) : section?.unavailable ? (
        <div className="egov-band__error" role="alert"><Icon name="clock" size={13} /> {section.unavailable} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></div>
      ) : null}
      <div className="egov-grid">
        {section ? live.map((f) => <OverviewCard key={f.key} field={f} filters={filters} onFiltersChange={onFiltersChange} />)
          : Array.from({ length: 4 }, (_, i) => <div key={i} className="egov-card is-skeleton" aria-hidden="true"><i className="lc-skel" /></div>)}
      </div>
      {pending.length ? (
        <div className="egov-pending">
          <button type="button" className="egov-link" aria-expanded={showPending} onClick={() => setShowPending((s) => !s)}>{showPending ? 'Hide' : 'Show'} {pending.length} fields waiting on the read model</button>
          {showPending ? <ul>{pending.map((f) => <li key={f.key}><b>{f.label}</b> — {f.unavailable}</li>)}</ul> : null}
        </div>
      ) : null}
    </section>
  )
}

export function DeskOverviewMode({ filters, onFiltersChange, onClose }: { filters: EntityGraphFieldFilter[]; onFiltersChange: FiltersChange; onClose: () => void }) {
  const head = useOverviewRequest(filters, ['headline'], true)
  const gate = useGate(2)
  const data = head.data
  const cards = data?.headline && data.total !== null ? headlineCards(data.headline, data.total) : []
  return (
    <div className="egov egov-mode">
      <header className="egov-mode__head">
        <div className="egov-mode__id">
          <span className="egdk-eyebrow">Overview · every field</span>
          <h2>{data?.total !== null && data?.total !== undefined ? <>{fmtInt(data.total)} <small>properties</small></> : <i className="lc-skel egov-skel-num" />}</h2>
          <SourceLine data={data} />
        </div>
        <nav className="egov-mode__nav" aria-label="Sections">
          {OVERVIEW_SECTION_ORDER.map((id) => (
            <button key={id} type="button" className="egov-chip" onClick={() => document.getElementById(`egov-sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{SECTION_LABEL[id]}</button>
          ))}
        </nav>
        <LCButton size="sm" variant="secondary" icon="list" onClick={onClose} title="Back to the records">Records</LCButton>
      </header>
      <div className="egov-mode__scroll lc-scroll">
        <Metrics headline={data?.headline ?? null} total={data?.total ?? null} filters={filters} onFiltersChange={onFiltersChange} loading={head.stale} />
        {head.error ? <div className="egov-band__error" role="alert"><Icon name="alert-circle" size={13} /> {head.error} <button type="button" className="egov-link" onClick={head.retry}>Retry</button></div> : null}
        {cards.length ? (
          <section className="egov-section" aria-label="Headline">
            <header className="egov-section__head"><h3>Engagement & distress</h3><span className="egov-section__meta">contacted · replied · positive · inbox · pipeline · distress</span></header>
            <div className="egov-grid">{cards.map((f) => <OverviewCard key={f.key} field={f} filters={filters} onFiltersChange={onFiltersChange} />)}</div>
          </section>
        ) : null}
        {OVERVIEW_SECTION_ORDER.map((id) => <SectionBlock key={id} id={id} filters={filters} onFiltersChange={onFiltersChange} gate={gate} />)}
        <p className="egov-foot">Click a bar to filter · Shift-click adds to the field · Alt-click excludes · “Show records” in a table opens the grid. Every count is exact for the cohort; nothing is sampled.</p>
      </div>
    </div>
  )
}
