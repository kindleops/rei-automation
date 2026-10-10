/**
 * ENTITY GRAPH · OVERVIEW — the landing view of every scope (owner
 * 2026-10-10: "instead of the main screen being properties, it should be an
 * overview: charts, graphs, visual animated components … universal across all
 * the tables, with many filters applied").
 *
 *   DeskOverviewMode  the scope's whole picture: an animated KPI band, the
 *                     headline charts (distress × market, the signal stack,
 *                     pipeline, inbox, SMS eligibility) and every field,
 *                     sectioned; sections load in viewport order
 *                     (IntersectionObserver), at most two at a time, aborted
 *                     when the filters change
 *   DeskOverviewBand  the collapsible strip above the Properties grid
 *
 * Every number is exact and every bar carries the rail's own chip — clicking
 * it edits the one filter list the rail and the grid read, so everything
 * refetches the same cohort. A section the server could not finish in budget
 * reads "Unavailable — took longer than 8 s" with Retry; the unfiltered
 * universe is "Computing" until the snapshot job has run — never an estimate,
 * never a live universe scan.
 *
 * Motion (respects prefers-reduced-motion and the LC Animations switch):
 * numbers count up, cards rise in staggered, bars grow on arrival and glide on
 * a filter change; the previous cohort stays on screen (dimmed) until the new
 * one lands, so nothing jumps.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { LCButton, cx, useLcReducedMotion } from '../../../../shared/lc'
import { Icon } from '../../../../shared/icons'
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'
import { fetchOverview, OverviewRequestError, type CampaignScopeSummary } from './overview-api'
import { OverviewCard } from './OverviewCard'
import {
  applyBucketClick,
  clickModeFromEvent,
  countUpAt,
  fmtInt,
  fmtShare,
  matrixCellFilters,
  overviewSectionsForScope,
  staggerDelay,
} from './overview-model'
import type { DistressByMarket, OverviewField, OverviewHeadline, OverviewMetric, OverviewResponse, OverviewSection } from './overview-types'
import './desk-overview.css'

type FiltersChange = (next: EntityGraphFieldFilter[], opts?: { showRecords?: boolean }) => void

/* ── preferences (the band above the grid) ──────────────────────────────── */

const BAND_KEY = 'nexus.entityGraph.desk.overviewBand.v2'
export function useOverviewPrefs(uid: string) {
  // the Overview is the landing view now, so the band above the grid starts folded
  const [bandOpen, setBandOpenState] = useState(() => { try { return window.localStorage.getItem(`${BAND_KEY}:${uid}`) === 'open' } catch { return false } })
  const setBandOpen = (v: boolean) => { setBandOpenState(v); try { window.localStorage.setItem(`${BAND_KEY}:${uid}`, v ? 'open' : 'closed') } catch { /* private mode */ } }
  return { bandOpen, setBandOpen }
}

/* ── loading ────────────────────────────────────────────────────────────── */

type Load = { sig: string; data: OverviewResponse | null; error: string | null; loading: boolean }
const sigOf = (filters: EntityGraphFieldFilter[]) => JSON.stringify(filters)

/** One request at a time per caller; a newer filter set aborts the older request. */
function useOverviewRequest(scope: string, filters: EntityGraphFieldFilter[], sections: string[], enabled: boolean, gate?: Gate) {
  const sig = `${scope}|${sigOf(filters)}|${sections.join(',')}`
  const [state, setState] = useState<Load>({ sig: '', data: null, error: null, loading: false })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const ctl = new AbortController()
    setState((cur) => ({ sig, data: cur.sig.startsWith(`${scope}|`) ? cur.data : null, error: null, loading: true })) // the previous cohort stays on screen, dimmed, until the new one lands
    const go = () => fetchOverview(filters, sections, ctl.signal, scope)
    void (gate ? gate.run(go, ctl.signal) : go())
      .then((data) => { if (!ctl.signal.aborted) setState({ sig, data, error: null, loading: false }) })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return
        const message = e instanceof OverviewRequestError && e.status === 422
          ? (e.code === 'overview_filters_need_facts' ? 'These filters cannot be charted yet (they need the property facts read model).' : e.message || 'These filters cannot be charted on this scope.')
          : e instanceof Error ? e.message : 'The Overview did not load.'
        setState({ sig, data: null, error: message, loading: false })
      })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig encodes scope + filters + sections
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

/* ── animated numbers ───────────────────────────────────────────────────── */

/** Counts up from the last value shown (0 the first time) — immediate under reduced motion. */
export function useCountUp(value: number | null, ms = 760): number | null {
  const reduced = useLcReducedMotion()
  const [shown, setShown] = useState<number | null>(() => (value === null ? null : reduced ? value : 0))
  const last = useRef(0)
  useEffect(() => {
    if (value === null) { setShown(null); return }
    if (reduced || typeof requestAnimationFrame !== 'function') { setShown(value); last.current = value; return }
    const from = last.current
    if (from === value) { setShown(value); return }
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = (now - t0) / ms
      const v = countUpAt(from, value, t)
      last.current = v
      setShown(v)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, reduced, ms])
  return shown
}

function CountUp({ value }: { value: number | null }) {
  const v = useCountUp(value)
  return <>{fmtInt(v)}</>
}

/* ── the KPI band ───────────────────────────────────────────────────────── */

function MetricTile({ m, total, filters, onFiltersChange, index }: { m: OverviewMetric; total: number | null; filters: EntityGraphFieldFilter[]; onFiltersChange: FiltersChange; index: number }) {
  const share = m.key !== 'cohort' && typeof m.value === 'number' && total ? Math.min(1, m.value / total) : null
  const body = (
    <>
      <span className="egov-kpi__label">
        {m.label}
        {m.sensitive ? <i className="egov-sensitive" title="Sensitive field — descriptive only; never used in pricing" aria-label="sensitive field">S</i> : null}
      </span>
      <b className="egov-kpi__value">{m.value === null ? <span className="egov-kpi__na">{m.unavailable ? 'Unavailable' : '—'}</span> : <CountUp value={m.value} />}</b>
      <span className="egov-kpi__sub">{m.value === null ? (m.unavailable || 'Not available') : share !== null ? `${fmtShare(m.value, total)} of the cohort` : m.key === 'cohort' ? 'exact · the grid’s count' : ' '}</span>
      <span className="egov-kpi__meter" aria-hidden="true"><i style={{ width: `${share === null ? (m.key === 'cohort' && m.value ? 100 : 0) : share * 100}%` }} /></span>
    </>
  )
  const style = { animationDelay: `${staggerDelay(index, 40)}ms` }
  return m.filter ? (
    <button type="button" role="listitem" className={cx('egov-kpi', 'egov-enter', 'is-clickable', m.key === 'cohort' && 'is-hero')} style={style} title={`${m.basis}\nClick to filter the cohort to these.`}
      onClick={(e) => { const r = applyBucketClick(filters, m.filter, clickModeFromEvent(e)); if (r.applied) onFiltersChange(r.filters) }}>{body}</button>
  ) : (
    <div role="listitem" className={cx('egov-kpi', 'egov-enter', m.key === 'cohort' && 'is-hero')} style={style} title={m.basis}>{body}</div>
  )
}

export function KpiBand({ headline, total, filters, onFiltersChange, loading, computing }: { headline: OverviewHeadline | null; total: number | null; filters: EntityGraphFieldFilter[]; onFiltersChange: FiltersChange; loading: boolean; computing?: boolean }) {
  const metrics = headline?.metrics ?? []
  // the universe is computing: no placeholder tiles pretending to count — the computing plate says why
  if (!metrics.length && computing) return null
  if (!metrics.length) {
    return (
      <div className={cx('egov-kpis', loading && 'is-stale')} role="list" aria-label="Cohort metrics" aria-busy={loading}>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} role="listitem" className="egov-kpi is-skeleton">
            <i className="lc-skel egov-skel-line" /><i className="lc-skel egov-skel-num" /><i className="lc-skel egov-skel-line" />
          </div>
        ))}
        {computing ? <p className="egov-kpis__note"><Icon name="clock" size={12} /> The whole-universe numbers come from the snapshot job — pick a filter to count a cohort live.</p> : null}
      </div>
    )
  }
  return (
    <div className={cx('egov-kpis', loading && 'is-stale')} role="list" aria-label="Cohort metrics">
      {metrics.map((m, i) => <MetricTile key={m.key} m={m} total={total} filters={filters} onFiltersChange={onFiltersChange} index={i} />)}
    </div>
  )
}

/* ── headline charts ────────────────────────────────────────────────────── */

function headlineCards(h: OverviewHeadline, total: number): OverviewField[] {
  const card = (key: string, label: string, buckets: OverviewField['buckets'], note?: string): OverviewField => ({
    key, label, kind: 'tokens', section: 'headline', coverage: { known: total, total, share: 1 }, buckets: buckets ?? [], note,
  })
  const out: OverviewField[] = []
  if (h.distress?.length) out.push(card('headline.distress', 'Distress signals', [...h.distress].sort((a, b) => b.count - a.count), h.distressNote))
  if (h.stack) out.push({ ...card('headline.stack', 'Distress stack · signals per property', h.stack, h.stackNote), kind: 'numeric' })
  if (h.pipeline) out.push({ ...card('headline.pipeline', 'Pipeline stage', h.pipeline, h.definitions?.pipeline), kind: 'categorical' })
  if (h.inbox) out.push({ ...card('headline.inbox', 'Inbox bucket (properties with a thread)', h.inbox, h.definitions?.inbox), kind: 'categorical' })
  if (h.smsReasons) out.push({ ...card('headline.sms', 'SMS eligibility', h.smsReasons, 'The campaign target builder’s readiness verdict, per property.'), kind: 'categorical' })
  return out
}

/**
 * "Distress signals by market" — the cohort's largest markets × each signal.
 * One hue (the distress gold), intensity = the share of that market carrying
 * the signal; a cell's click = that market's chip + that signal's chip.
 */
export function DistressMatrix({ data, filters, onFiltersChange }: { data: DistressByMarket; filters: EntityGraphFieldFilter[]; onFiltersChange: FiltersChange }) {
  const [hover, setHover] = useState<string | null>(null)
  if (!data.markets.length) return null
  const maxTotal = Math.max(1, ...data.markets.map((m) => m.total))
  return (
    <article className="egov-card egov-matrix egov-enter" aria-label="Distress signals by market">
      <header className="egov-card__head">
        <h4 className="egov-card__title">Distress signals by market</h4>
        <span className="egov-matrix__hint">{hover ?? data.note}</span>
      </header>
      <div className="egov-matrix__scroll lc-scroll">
        <table className="egov-matrix__table">
          <thead>
            <tr>
              <th scope="col" className="egov-matrix__corner">Market</th>
              <th scope="col" className="egov-matrix__totalh">Properties</th>
              {data.signals.map((s) => (
                <th key={s.key} scope="col" className="egov-matrix__sig">
                  <button type="button" className="egov-matrix__sigbtn" onClick={() => onFiltersChange(applyBucketClick(filters, s.filter, 'replace').filters)} title={`Filter to ${s.label}`}>{s.label}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.markets.map((m, row) => (
              <tr key={m.key} style={{ animationDelay: `${staggerDelay(row, 36)}ms` }} className="egov-matrix__row">
                <th scope="row">
                  <button type="button" className="egov-matrix__market" disabled={!m.filter} onClick={() => m.filter && onFiltersChange(applyBucketClick(filters, m.filter, 'replace').filters)} title={m.filter ? `Filter to ${m.label}` : undefined}>{m.label}</button>
                </th>
                <td className="egov-matrix__total">
                  <span className="egov-matrix__tbar" aria-hidden="true"><i style={{ width: `${(m.total / maxTotal) * 100}%` }} /></span>
                  <b>{fmtInt(m.total)}</b>
                </td>
                {data.signals.map((s) => {
                  const n = m.counts[s.key] ?? 0
                  const share = m.total ? n / m.total : 0
                  // a square-root ramp keeps a 2% cell visible next to a 40% one
                  const alpha = n ? 0.1 + Math.sqrt(share) * 0.78 : 0
                  return (
                    <td key={s.key} className="egov-matrix__cell">
                      <button type="button" className={cx('egov-matrix__btn', !n && 'is-zero')} style={{ '--egov-cell': alpha } as CSSProperties} disabled={!n}
                        onMouseEnter={() => setHover(`${m.label} · ${s.label} · ${fmtInt(n)} (${fmtShare(n, m.total)})`)} onMouseLeave={() => setHover(null)}
                        onFocus={() => setHover(`${m.label} · ${s.label} · ${fmtInt(n)} (${fmtShare(n, m.total)})`)} onBlur={() => setHover(null)}
                        onClick={() => onFiltersChange(matrixCellFilters(filters, m.filter, s.filter))}
                        aria-label={`${m.label}, ${s.label}: ${fmtInt(n)} of ${fmtInt(m.total)}`}>
                        {n ? fmtInt(n) : '·'}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  )
}

function SourceLine({ data }: { data: OverviewResponse | null }) {
  if (!data?.source) return null
  const at = (s: string | null | undefined) => (s ? new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null)
  const mode = data.source.mode
  return (
    <span className="egov-source" title={data.source.note}>
      <i className={cx('egov-source__dot', mode === 'facts' || mode === 'snapshot' ? 'is-facts' : 'is-live')} aria-hidden="true" />
      {mode === 'snapshot' ? `Universe snapshot · ${at(data.refreshed_at?.snapshot) ?? '—'}` : mode === 'facts' ? `Records as of ${at(data.refreshed_at?.facts) ?? '—'}` : 'Live records'}
      {data.refreshed_at?.engagement ? ` · engagement as of ${at(data.refreshed_at.engagement)}` : ''}
      {' · exact'}
    </span>
  )
}

function ComputingCard({ reason }: { reason: string }) {
  return (
    <div className="egov-computing egov-enter" role="status">
      <span className="egov-computing__orb" aria-hidden="true"><Icon name="clock" size={14} /></span>
      <div>
        <b>Computing the universe</b>
        <p>{reason}</p>
      </div>
      <div className="egov-computing__ghost" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} className="lc-skel" style={{ height: `${28 + ((i * 37) % 60)}%` }} />)}</div>
    </div>
  )
}

/* ── the band (above the Properties grid) ───────────────────────────────── */

export function DeskOverviewBand({ scope = 'properties', filters, onFiltersChange, open, onOpenChange, onOpenMode }: {
  scope?: string
  filters: EntityGraphFieldFilter[]
  onFiltersChange: FiltersChange
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenMode: () => void
}) {
  const req = useOverviewRequest(scope, filters, ['pinned', 'headline'], open)
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
          {data?.total !== null && data?.total !== undefined ? <><b>{fmtInt(data.total)}</b> in this cohort · every chart exact</> : open && req.stale ? 'Charting the cohort…' : data?.computing ? 'Universe charts come from the snapshot job' : 'The filtered cohort, field by field'}
        </span>
        <SourceLine data={data} />
        <LCButton size="sm" variant="quiet" icon="stats" onClick={onOpenMode} title="The full Overview — every field">Overview</LCButton>
      </div>
      {open ? (
        req.error && !data ? (
          <div className="egov-band__error" role="alert"><Icon name="alert-circle" size={13} /> {req.error} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></div>
        ) : (
          <div className={cx('egov-band__body', req.stale && 'is-stale')}>
            <KpiBand headline={data?.headline ?? null} total={data?.total ?? null} filters={filters} onFiltersChange={onFiltersChange} loading={req.stale} computing={data?.computing} />
            <div className="egov-grid is-band">
              {pinned.length ? pinned.map((f, i) => <OverviewCard key={f.key} field={f} filters={filters} onFiltersChange={onFiltersChange} compact enterIndex={i} />)
                : Array.from({ length: 6 }, (_, i) => <div key={i} className="egov-card is-skeleton is-compact" aria-hidden="true"><i className="lc-skel" /></div>)}
            </div>
            {data?.unavailable?.length ? <p className="egov-unavail">{data.unavailable.map((u) => u.reason).filter((v, i, a) => a.indexOf(v) === i).join(' · ')} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></p> : null}
          </div>
        )
      ) : null}
    </section>
  )
}

/* ── the full Overview ──────────────────────────────────────────────────── */

function SectionBlock({ scope, id, label, filters, onFiltersChange, gate }: { scope: string; id: string; label: string; filters: EntityGraphFieldFilter[]; onFiltersChange: FiltersChange; gate: Gate }) {
  const ref = useRef<HTMLElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver !== 'function') { setSeen(true); return }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setSeen(true) }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  const req = useOverviewRequest(scope, filters, [id], seen, gate)
  const section: OverviewSection | undefined = req.data?.sections.find((s) => s.id === id)
  const fields = section?.fields ?? []
  const live = fields.filter((f) => !f.unavailable)
  const pending = fields.filter((f) => f.unavailable)
  const [showPending, setShowPending] = useState(false)
  return (
    <section ref={ref} id={`egov-sec-${scope}-${id}`} className={cx('egov-section', req.stale && seen && 'is-stale')} aria-label={label} aria-busy={req.stale && seen}>
      <header className="egov-section__head">
        <h3>{label}</h3>
        <span className="egov-section__meta">
          {section?.computing ? 'computing' : section ? `${live.length} ${live.length === 1 ? 'field' : 'fields'}${pending.length ? ` · ${pending.length} waiting on the property facts read model` : ''}${section.snapshot ? ' · snapshot' : ''}` : seen ? 'Counting…' : ''}
        </span>
      </header>
      {req.error ? (
        <div className="egov-band__error" role="alert"><Icon name="alert-circle" size={13} /> {req.error} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></div>
      ) : section?.computing ? null : section?.unavailable ? (
        <div className="egov-band__error" role="alert"><Icon name="clock" size={13} /> {section.unavailable} <button type="button" className="egov-link" onClick={req.retry}>Retry</button></div>
      ) : null}
      {section?.computing ? (
        <div className="egov-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="egov-card is-skeleton is-computing" aria-hidden="true"><i className="lc-skel" /></div>)}</div>
      ) : (
        <div className="egov-grid">
          {section ? live.map((f, i) => <OverviewCard key={f.key} field={f} filters={filters} onFiltersChange={onFiltersChange} enterIndex={i} />)
            : Array.from({ length: 4 }, (_, i) => <div key={i} className="egov-card is-skeleton" aria-hidden="true"><i className="lc-skel" /></div>)}
        </div>
      )}
      {pending.length ? (
        <div className="egov-pending">
          <button type="button" className="egov-link" aria-expanded={showPending} onClick={() => setShowPending((s) => !s)}>{showPending ? 'Hide' : 'Show'} {pending.length} fields waiting on the read model</button>
          {showPending ? <ul>{pending.map((f) => <li key={f.key}><b>{f.label}</b> — {f.unavailable}</li>)}</ul> : null}
        </div>
      ) : null}
    </section>
  )
}

const SCOPE_NOUN: Record<string, string> = { properties: 'properties', master_owners: 'owners', people: 'people', contact_methods: 'phones', buyers: 'buyers', organizations: 'companies' }
const SCOPE_TITLE: Record<string, string> = { properties: 'Properties', master_owners: 'Owners', people: 'People', contact_methods: 'Contacts', buyers: 'Buyers', organizations: 'Companies' }

export function DeskOverviewMode({ scope = 'properties', filters, onFiltersChange, onOpenGrid, campaign = null, universeTotal = null }: {
  scope?: string
  filters: EntityGraphFieldFilter[]
  onFiltersChange: FiltersChange
  onOpenGrid: () => void
  /** the campaign the cohort is scoped to (Campaign: <name> chip), when one is */
  campaign?: CampaignScopeSummary | null
  /** the scope's universe count (tab counts) — shown while the universe Overview is computing */
  universeTotal?: number | null
}) {
  const head = useOverviewRequest(scope, filters, ['headline'], true)
  const gate = useGate(2)
  const data = head.data
  const sections = overviewSectionsForScope(scope)
  const cards = data?.headline && data.total !== null ? headlineCards(data.headline, data.total) : []
  const computing = Boolean(data?.computing)
  const total = data?.total ?? (computing ? universeTotal : null)
  const shownTotal = useCountUp(total ?? null)
  const noun = SCOPE_NOUN[scope] ?? 'records'
  return (
    <div className="egov egov-mode" data-scope={scope}>
      <header className="egov-mode__head">
        <div className="egov-mode__id">
          <span className="egdk-eyebrow">Overview · {SCOPE_TITLE[scope] ?? scope}{campaign ? ` · Campaign: ${campaign.name}` : ''}</span>
          <h2 aria-live="polite">{total !== null && total !== undefined ? <>{fmtInt(shownTotal)} <small>{noun}{computing ? ' · universe' : filters.length ? ' in this cohort' : ''}</small></> : <i className="lc-skel egov-skel-num" />}</h2>
          {computing ? <span className="egov-source"><i className="egov-source__dot is-pending" aria-hidden="true" /> Universe charts are computing (snapshot job) · live for any filtered cohort</span> : <SourceLine data={data} />}
        </div>
        <nav className="egov-mode__nav" aria-label="Sections">
          {(data?.headline ? [{ id: 'headline', label: 'Headline' }] : []).concat(sections).map((s) => (
            <button key={s.id} type="button" className="egov-chip" onClick={() => document.getElementById(`egov-sec-${scope}-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{s.label}</button>
          ))}
        </nav>
        <LCButton size="sm" variant="secondary" icon="list" onClick={onOpenGrid} title="Every record and every column">Grid</LCButton>
      </header>
      <div className="egov-mode__scroll lc-scroll">
        <KpiBand headline={data?.headline ?? null} total={data?.total ?? null} filters={filters} onFiltersChange={onFiltersChange} loading={head.stale} computing={computing} />
        {head.error ? <div className="egov-band__error" role="alert"><Icon name="alert-circle" size={13} /> {head.error} <button type="button" className="egov-link" onClick={head.retry}>Retry</button></div> : null}
        {computing ? <ComputingCard reason={data?.unavailable.find((u) => u.computing)?.reason ?? 'The whole-universe Overview is precomputed by the snapshot job.'} /> : null}
        {data?.headline?.distressByMarket?.markets.length || cards.length ? (
          <section className={cx('egov-section', head.stale && 'is-stale')} id={`egov-sec-${scope}-headline`} aria-label="Headline">
            <header className="egov-section__head"><h3>{scope === 'properties' ? 'Engagement & distress' : 'Headline'}</h3><span className="egov-section__meta">{scope === 'properties' ? 'distress × market · signal stack · pipeline · inbox · SMS eligibility' : ''}</span></header>
            {data?.headline?.distressByMarket?.markets.length ? <DistressMatrix data={data.headline.distressByMarket} filters={filters} onFiltersChange={onFiltersChange} /> : null}
            {cards.length ? <div className="egov-grid">{cards.map((f, i) => <OverviewCard key={f.key} field={f} filters={filters} onFiltersChange={onFiltersChange} enterIndex={i} />)}</div> : null}
          </section>
        ) : null}
        {sections.map((s) => <SectionBlock key={`${scope}:${s.id}`} scope={scope} id={s.id} label={s.label} filters={filters} onFiltersChange={onFiltersChange} gate={gate} />)}
        <p className="egov-foot">Click a bar to filter · Shift-click adds to the field · Alt-click excludes · “Show records” in a table opens the grid. Every count is exact for the cohort; nothing is sampled. Fields marked <i className="egov-sensitive" aria-hidden="true">S</i> are sensitive: shown as descriptive analytics, never used in pricing.</p>
      </div>
    </div>
  )
}
