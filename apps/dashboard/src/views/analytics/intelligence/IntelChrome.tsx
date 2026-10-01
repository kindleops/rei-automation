/**
 * THE LAB'S CHROME — compact, never a hero header.
 *
 *   command bar   what is being looked at (the machine, or the narrowed
 *                 slice), the period and its comparison, LIVE with the data's
 *                 age; then the controls that change the whole Lab: range,
 *                 comparison, grain, filter, group by, the metric explorer and
 *                 views
 *   lenses        ten analytical lenses as one quiet tab rail (overflow
 *                 scrolls), each answering one question
 *   cohort        the active slice as chips (breadcrumb steps, a seller
 *                 cohort, filters) with the population it leaves, and Clear
 */
import { useMemo, useState } from 'react'
import type { LabGrain, LabRangePreset } from '../../../domain/analytics/analytics-lab-api'
import { decodeB64Url, fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import { LCButton, LCChip, LCIconButton, LCLive, LCMenu, LCPopover, LCSearch, LCSegmented, LCSelect, LCTabs, cx, lcMenu } from '../../../shared/lc'
import type { LCMenuEntry } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { DateRangePicker } from '../../../shared/arc/date-range-picker/date-range-picker'
import { useLab } from './intel-context'
import type { IntelContext, Lens } from './intel-state'
import { HISTORY_START, LENSES, urlFor } from './intel-state'
import type { PeriodCohort } from './intel-model'
import { FAMILY_LABEL, FAMILY_ORDER, filterText } from './intel-model'
import { fmtAge, fmtInt, fmtRange } from './intel-format'

const RANGES: ReadonlyArray<{ value: LabRangePreset; label: string }> = [
  { value: 'today', label: 'Today' }, { value: '7d', label: '7D' }, { value: '30d', label: '30D' }, { value: '90d', label: '90D' }, { value: 'ytd', label: 'YTD' }, { value: 'custom', label: 'Custom' },
]
const DAY = 86_400_000
const LENSES_WITH_HERO = new Set<Lens>(['overview', 'acquisition'])
const DEVICE_VIEWS = 'anx:intel:views:v1'
type SavedView = { id: string; label: string; href: string; savedAt: string }
const readViews = (): SavedView[] => { try { const v = JSON.parse(localStorage.getItem(DEVICE_VIEWS) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }

export function IntelCommandBar({ live, updatedAt, loading, onRefresh, onFilters }: { live: boolean; updatedAt: number | null; loading: boolean; onRefresh: () => void; onFilters: () => void }) {
  const { ctx, act, defs, dims, overview } = useLab()
  const [customOpen, setCustomOpen] = useState(false)
  const last = ctx.segment[ctx.segment.length - 1]
  const subject = last ? last.label || String(last.value) : 'The machine'
  const period = overview ? fmtRange(overview.period.start, overview.period.end, ctx.tz) : '…'
  const compare = overview?.compare.available ? `vs ${fmtRange(overview.compare.start, overview.compare.end, ctx.tz)}` : ctx.compare.mode === 'none' ? 'no comparison' : overview?.compare.reason ? 'comparison unavailable' : ''
  const days = overview ? overview.period.days : 30
  const grainOk = (g: LabGrain) => {
    if (g === 'auto') return true
    const n = g === 'hour' ? days * 24 : g === 'day' ? days : g === 'week' ? days / 7 : days / 30
    return n >= 2 && n <= 400
  }
  const metricDef = defs[ctx.metric]
  const compareItems = lcMenu([
    { label: 'Previous period', hint: `the ${Math.round(days)} days before`, checked: ctx.compare.mode === 'previous', onSelect: () => act.setCompare('previous') },
    { label: 'A week earlier', hint: 'same window, −7 days', checked: ctx.compare.mode === 'week', onSelect: () => act.setCompare('week') },
    { label: 'A month earlier', hint: 'same window, −1 month', checked: ctx.compare.mode === 'month', onSelect: () => act.setCompare('month') },
    { label: 'A year earlier', checked: ctx.compare.mode === 'year', disabled: true, reason: `History begins ${new Date(`${HISTORY_START}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — no prior year` },
    { label: 'No comparison', checked: ctx.compare.mode === 'none', onSelect: () => act.setCompare('none') },
  ])
  const customValue = ctx.range.preset === 'custom' && ctx.range.start && ctx.range.end ? { start: new Date(ctx.range.start), end: new Date(Date.parse(ctx.range.end) - 1) } : null
  return (
    <header className="ix-bar">
      <div className="ix-bar__id">
        <span className="ix-eyebrow">Analytics{ctx.segment.length ? ' · narrowed' : ''}</span>
        <h1 className="ix-bar__title" title={subject}>{subject}</h1>
        <p className="ix-bar__period"><b>{period}</b> <span>{compare}</span></p>
      </div>
      <div className="ix-bar__live">
        <LCLive live={live} updatedAt={updatedAt} label={live ? 'Live' : 'Closed window'} />
        <span className="ix-muted">{updatedAt ? `updated ${fmtAge(updatedAt)}` : loading ? 'reading…' : ''}</span>
        <LCIconButton icon="refresh-cw" label="Refresh now" size="sm" onClick={onRefresh} className={cx(loading && 'is-busy')} />
      </div>
      <div className="ix-bar__controls" role="toolbar" aria-label="Analytical context">
        <LCSegmented label="Period" size="sm" value={ctx.range.preset} onChange={(v) => {
          if (v === 'custom') { setCustomOpen(true); if (!customValue) act.setRange('custom', { start: new Date(Date.now() - 30 * DAY).toISOString(), end: new Date().toISOString() }) }
          else { setCustomOpen(false); act.setRange(v) }
        }} options={RANGES} />
        {ctx.range.preset === 'custom' || customOpen ? (
          <div className="lc-arc ix-bar__custom">
            <DateRangePicker
              label="Custom period"
              value={customValue}
              minDate={new Date(`${HISTORY_START}T00:00:00`)}
              maxDate={new Date()}
              weekStartsOn={1}
              boundary={() => document.querySelector('.ix') as HTMLElement | null}
              presets={[
                { label: 'Last 14 days', range: (t) => ({ start: new Date(t.getFullYear(), t.getMonth(), t.getDate() - 13), end: t }) },
                { label: 'Last 60 days', range: (t) => ({ start: new Date(t.getFullYear(), t.getMonth(), t.getDate() - 59), end: t }) },
                { label: 'This month', range: (t) => ({ start: new Date(t.getFullYear(), t.getMonth(), 1), end: t }) },
                { label: 'Last month', range: (t) => ({ start: new Date(t.getFullYear(), t.getMonth() - 1, 1), end: new Date(t.getFullYear(), t.getMonth(), 0) }) },
              ]}
              onChange={(r) => act.setRange('custom', { start: new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate()).toISOString(), end: new Date(r.end.getFullYear(), r.end.getMonth(), r.end.getDate() + 1).toISOString() })}
            />
          </div>
        ) : null}
        <LCMenu label="Comparison window" items={compareItems} align="start" width={260} trigger={<button type="button" className="ix-ctl"><Icon name="clock" size={13} />{ctx.compare.mode === 'none' ? 'No comparison' : `Compare · ${ctx.compare.mode === 'previous' ? 'previous' : ctx.compare.mode === 'week' ? 'week earlier' : ctx.compare.mode === 'month' ? 'month earlier' : ctx.compare.mode}`}<Icon name="chevron-down" size={12} /></button>} />
        <LCSelect label="Time grain" prefix="Grain" variant="quiet" size="sm" value={ctx.grain} onChange={(g) => act.set({ grain: g })} options={(['auto', 'hour', 'day', 'week', 'month'] as LabGrain[]).map((g) => ({ value: g, label: g === 'auto' ? `Auto${overview?.grain.auto ? ` · ${overview.grain.grain}` : ''}` : g[0].toUpperCase() + g.slice(1), disabled: !grainOk(g) }))} />
        <span className="ix-bar__rule" aria-hidden="true" />
        <LCButton size="sm" variant={ctx.filters.length ? 'secondary' : 'quiet'} icon="filter" onClick={onFilters}>Filter{ctx.filters.length ? <span className="ix-count">{ctx.filters.length}</span> : null}</LCButton>
        <LCSelect label="Group by" prefix="Group" variant="quiet" size="sm" value={ctx.groupBy || '__none'} onChange={(d) => act.set({ groupBy: d === '__none' ? null : d, lens: LENSES_WITH_HERO.has(ctx.lens) ? ctx.lens : 'overview' })} options={[{ value: '__none', label: 'None' }, ...((metricDef?.dimensions || []).filter((d) => dims[d]).map((d) => ({ value: d, label: dims[d].label, group: dims[d].family.toLowerCase() })))]} menuWidth={240} />
        <MetricExplorer />
        <ViewsMenu />
      </div>
    </header>
  )
}

/** The KPI explorer: every registry metric, searchable by family; pick one to trend, define or break down. */
function MetricExplorer() {
  const { ctx, act, defs, dims, overview, inspect } = useLab()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const metrics = useMemo(() => Object.values(defs).filter((m) => !q || `${m.label} ${m.short} ${m.description} ${m.family}`.toLowerCase().includes(q.toLowerCase())), [defs, q])
  const families = FAMILY_ORDER.filter((f) => metrics.some((m) => m.family === f))
  const pick = (id: string, groupBy?: string | null) => {
    act.set({ metric: id, groupBy: groupBy === undefined ? (ctx.groupBy && defs[id]?.dimensions.includes(ctx.groupBy) ? ctx.groupBy : null) : groupBy, lens: LENSES_WITH_HERO.has(ctx.lens) ? ctx.lens : 'overview' })
    setOpen(false)
  }
  return (
    <LCPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={460}
      material="smoke"
      label="Metric explorer"
      trigger={<button type="button" className={cx('ix-ctl', open && 'is-on')}><Icon name="search" size={13} />Metrics<Icon name="chevron-down" size={12} /></button>}
    >
      <div className="ix-explorer">
        <LCSearch value={q} onChange={setQ} label="Search metrics" placeholder="Reply rate, delivery, holds, opportunities…" autoFocus />
        <div className="ix-explorer__list lc-scroll">
          {families.map((f) => (
            <section key={f}>
              <span className="ix-eyebrow">{FAMILY_LABEL[f] || f}</span>
              <ul>
                {metrics.filter((m) => m.family === f).map((m) => {
                  const v = overview?.metrics[m.id]?.cur
                  return (
                    <li key={m.id} className={cx(ctx.metric === m.id && 'is-on')}>
                      <button type="button" className="ix-explorer__pick" onClick={() => pick(m.id)} title={m.description}>
                        <b>{m.label}</b>
                        <small>{m.unit === 'rate' ? `${m.numerator.label} ÷ ${m.denominator?.label}` : m.numerator.label}</small>
                      </button>
                      <span className="ix-explorer__val">{v ? fmtMetric(m, v.value) : ''}</span>
                      <LCMenu
                        label={`Break ${m.label} down by`}
                        title={`Break ${m.short || m.label} down by`}
                        width={220}
                        items={m.dimensions.slice(0, 14).filter((d) => dims[d]).map((d): LCMenuEntry => ({ id: d, label: dims[d].label, hint: dims[d].family.toLowerCase(), onSelect: () => pick(m.id, d) }))}
                        trigger={<button type="button" className="ix-mini" aria-label={`Break ${m.label} down`}><Icon name="layers" size={12} /></button>}
                      />
                      <button type="button" className="ix-mini" onClick={() => { inspect({ kind: 'metric', id: m.id }); setOpen(false) }} aria-label={`Definition of ${m.label}`}><Icon name="hash" size={12} /></button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          {!families.length ? <p className="ix-note">No metric matches “{q}”.</p> : null}
        </div>
        <p className="ix-note">{Object.keys(defs).length} registry metrics · every one with a numerator, a base where it is a rate, a time basis and its sources.</p>
      </div>
    </LCPopover>
  )
}

function ViewsMenu() {
  const { ctx, act } = useLab()
  const [views, setViews] = useState<SavedView[]>(readViews)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [copied, setCopied] = useState(false)
  const save = () => {
    const label = name.trim()
    if (!label) return
    const next = [{ id: `v-${Date.now()}`, label, href: urlFor(ctx), savedAt: new Date().toISOString() }, ...views.filter((v) => v.label !== label)].slice(0, 30)
    try { localStorage.setItem(DEVICE_VIEWS, JSON.stringify(next)) } catch { /* private mode */ }
    setViews(next); setName(''); setNaming(false)
  }
  const remove = (id: string) => {
    const next = views.filter((v) => v.id !== id)
    try { localStorage.setItem(DEVICE_VIEWS, JSON.stringify(next)) } catch { /* ignore */ }
    setViews(next)
  }
  const restore = (href: string) => {
    const lab = new URLSearchParams(href.split('?')[1] || '').get('lab')
    const decoded = lab ? decodeB64Url<Partial<IntelContext>>(lab) : null
    if (decoded) act.set(decoded) // a corrupt view decodes to null and is ignored
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}${urlFor(ctx)}`); setCopied(true); window.setTimeout(() => setCopied(false), 1600) } catch { setCopied(false) }
  }
  return (
    <LCPopover align="end" width={300} material="smoke" label="Views" trigger={<button type="button" className="ix-ctl"><Icon name="bookmark" size={13} />Views<Icon name="chevron-down" size={12} /></button>}>
      <div className="ix-views">
        {views.length ? (
          <ul>
            {views.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => restore(v.href)}><Icon name="bookmark" size={12} /><span>{v.label}</span></button>
                <button type="button" className="ix-mini is-icon" onClick={() => remove(v.id)} aria-label={`Remove view ${v.label}`}><Icon name="x" size={11} /></button>
              </li>
            ))}
          </ul>
        ) : <p className="ix-note">No saved views on this device yet.</p>}
        {naming ? (
          <div className="ix-views__save">
            <input autoFocus placeholder="Name this view — e.g. Miami delivery" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(false) } }} aria-label="View name" />
            <LCButton size="sm" variant="primary" onClick={save} disabled={!name.trim()}>Save</LCButton>
          </div>
        ) : (
          <div className="ix-views__acts">
            <LCButton size="sm" variant="secondary" icon="bookmark" onClick={() => setNaming(true)}>Save this view</LCButton>
            <LCButton size="sm" variant="quiet" icon="link" onClick={copy}>{copied ? 'Link copied' : 'Copy link'}</LCButton>
          </div>
        )}
        <p className="ix-note">Views are kept on this device (a shared store is proposed and awaits approval). The link always restores this exact analysis.</p>
      </div>
    </LCPopover>
  )
}

export function IntelLenses() {
  const { ctx, act } = useLab()
  const lens = LENSES.find((l) => l.key === ctx.lens) || LENSES[0]
  return (
    <div className="ix-lensbar">
      <LCTabs label="Analytical lens" variant="line" value={ctx.lens} onChange={(l) => act.setLens(l as Lens)} items={LENSES.map((l) => ({ id: l.key, label: l.label }))} className="ix-lenses" />
      <p className="ix-lensbar__q">{lens.question}</p>
    </div>
  )
}

export function IntelCohortBar({ onFilters }: { onFilters: () => void }) {
  const { ctx, act, dims, registry, overview } = useLab()
  const p = (overview?.thePeriod.cohort as PeriodCohort | undefined) || null
  const chips = [
    ...ctx.segment.map((s, i) => ({ id: `s-${i}`, field: s.dim === 'cohort' ? 'Cohort' : dims[s.dim]?.label || s.dim, value: s.label || (s.dim === 'cohort' ? registry.cohorts?.[String(s.value)]?.label : null) || String(s.value), onRemove: () => act.removeSegment(i) })),
    ...ctx.filters.map((f, i) => { const t = filterText(f, registry.filters); return { id: `f-${i}`, field: t.field, value: t.value, onRemove: () => act.removeFilter(i) } }),
  ]
  const narrowed = chips.length > 0
  return (
    <div className={cx('ix-cohort', narrowed && 'is-narrowed')} role="group" aria-label="Active analytical slice">
      <span className="ix-cohort__all"><Icon name={narrowed ? 'filter' : 'globe'} size={12} />{narrowed ? 'Slice' : 'All activity'}</span>
      {chips.map((c) => <LCChip key={c.id} field={c.field} value={c.value} onRemove={c.onRemove} />)}
      {!ctx.filters.some((f) => f.field === 'include_test_campaigns') ? <span className="ix-cohort__fixed" title="Structural test / proof campaigns are excluded from every figure unless included under Filter → System">test campaigns excluded</span> : null}
      <span className="ix-cohort__fixed" title="The 5 internal test phones and canary-flagged rows are always excluded">canary excluded</span>
      <span className="ix-cohort__count" aria-live="polite">
        {p ? <>{fmtInt(p.sellers)} sellers · {fmtInt(p.messages)} messages · {fmtInt(p.replies)} repliers · {fmtInt(p.transitions)} stage events · {fmtInt(p.runs)} runs</> : null}
        {p?.sellerCohort ? <> · cohort <b>{fmtInt(p.sellerCohort.current)}</b></> : null}
      </span>
      <span className="ix-cohort__acts">
        <button type="button" className="ix-link" onClick={onFilters}>Edit</button>
        {narrowed ? <button type="button" className="ix-link" onClick={act.clearSlice}>Clear</button> : null}
      </span>
    </div>
  )
}
