/**
 * THE CONTEXT BAR — one row above everything it scopes: period, comparison,
 * grain, filters, group-by, saved views, freshness. Every chart, KPI and
 * record list below re-renders against the same slice.
 */
import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { FilterFieldDef, LabCompareMode, LabContext, LabEnvelope, LabFilter, LabGrain, LabRangePreset, LabRegistry } from '../../../domain/analytics/analytics-lab-api'
import { fetchLabFilterOptions, fetchSavedViews } from '../../../domain/analytics/analytics-lab-api'
import type { LabActions } from './lab-state'
import { Menu, Popover, Segmented, cls } from './LabUi'
import { fmtRangeShort } from './charts/chart-kit'

const RANGES: Array<{ key: LabRangePreset; label: string }> = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7D' }, { key: '30d', label: '30D' }, { key: '90d', label: '90D' }, { key: 'ytd', label: 'YTD' }, { key: 'custom', label: 'Custom' },
]
const DAY = 86_400_000
const HISTORY = Date.parse('2026-04-18T00:00:00Z')
export const OP_LABEL: Record<string, string> = {
  eq: 'is', neq: 'is not', in: 'is any of', not_in: 'is none of', gt: '>', lt: '<', between: 'between', exists: 'has a value', missing: 'is missing', before: 'before', after: 'after', is_true: 'is true', is_false: 'is false',
}

function approxDays(ctx: LabContext) {
  const r = ctx.range
  if (r.preset === 'custom' && r.start && r.end) return Math.max(1, (Date.parse(r.end) - Date.parse(r.start)) / DAY)
  if (r.preset === 'today') return 1
  if (r.preset === 'ytd') { const n = new Date(); return (n.getTime() - new Date(n.getFullYear(), 0, 1).getTime()) / DAY }
  return ({ '7d': 7, '30d': 30, '90d': 90 } as Record<string, number>)[r.preset] ?? 30
}

export function filterChipText(f: LabFilter & { labels?: string[] }, reg: LabRegistry | null) {
  const def = reg?.filters.find((x) => x.id === f.field)
  const name = def?.label || f.field
  const op = OP_LABEL[f.op] || f.op
  if (['exists', 'missing', 'is_true', 'is_false'].includes(f.op)) return `${name} ${op}`
  const labels = f.labels && f.labels.length ? f.labels : Array.isArray(f.value) ? (f.value as unknown[]).map(String) : [String(f.value)]
  const v = f.op === 'between' && Array.isArray(f.value) ? `${(f.value as number[])[0]} – ${(f.value as number[])[1]}` : labels.length > 2 ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}` : labels.join(', ')
  return `${name} ${op} ${v}${def?.unit === '%' && !Array.isArray(f.value) ? '%' : ''}`
}

type Props = {
  ctx: LabContext
  act: LabActions
  registry: LabRegistry | null
  envelope: LabEnvelope | null
  loading: boolean
  onRefresh: () => void
}

export function LabContextBar({ ctx, act, registry, envelope, loading, onRefresh }: Props) {
  const days = approxDays(ctx)
  const metricDef = registry?.metrics.find((m) => m.id === ctx.metric)
  const tz = ctx.tz
  const compareItems = [
    { key: 'previous', label: 'Previous period', hint: `the ${Math.round(days)} days before` },
    { key: 'week', label: 'Week earlier', hint: 'same window, −7 days' },
    { key: 'month', label: 'Month earlier', hint: 'same window, −1 month' },
    { key: 'year', label: 'Year earlier', disabled: true, reason: 'History begins Apr 18, 2026 — no prior year' },
    { key: 'custom', label: 'Custom window…' },
    { key: 'none', label: 'No comparison' },
  ].map((x) => ({ ...x, checked: ctx.compare.mode === x.key }))
  const grainOk = (g: LabGrain) => {
    if (g === 'auto') return true
    const n = g === 'hour' ? days * 24 : g === 'day' ? days : g === 'week' ? days / 7 : days / 30
    return n >= 2 && n <= 400
  }
  const autoGrain = envelope?.grain?.auto ? envelope.grain.grain : null
  const grainItems = (['auto', 'hour', 'day', 'week', 'month'] as LabGrain[]).map((g) => ({
    key: g, label: g === 'auto' ? `Auto${autoGrain ? ` · ${autoGrain}` : ''}` : g[0].toUpperCase() + g.slice(1), checked: ctx.grain === g,
    disabled: !grainOk(g), reason: 'Too many or too few points for this range',
  }))
  const groupItems = [{ key: '__none', label: 'No grouping', checked: !ctx.groupBy }, ...(metricDef?.dimensions || []).map((d) => ({ key: d, label: registry?.dimensions[d]?.label || d, hint: registry?.dimensions[d]?.family.toLowerCase(), checked: ctx.groupBy === d }))]
  const compareText = envelope?.compare?.available ? `vs ${fmtRangeShort(envelope.compare.start, envelope.compare.end, tz)}` : ctx.compare.mode === 'none' ? 'No comparison' : 'Comparison unavailable'
  const asOf = envelope?.dataAsOf ? new Date(envelope.dataAsOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null

  return (
    <div className="alab-bar" role="toolbar" aria-label="Analytical context">
      <Segmented label="Period" value={ctx.range.preset} options={RANGES.map((r) => ({ key: r.key, label: r.label }))} onChange={(k) => {
        if (k === 'custom') {
          const end = new Date()
          const start = new Date(end.getTime() - 30 * DAY)
          act.set({ range: { preset: 'custom', start: start.toISOString(), end: end.toISOString() }, grain: 'auto' })
        } else act.set({ range: { preset: k }, grain: 'auto' })
      }} />
      {ctx.range.preset === 'custom' ? <CustomRange ctx={ctx} act={act} /> : null}
      <Popover label={compareText} icon="clock" active={ctx.compare.mode !== 'previous'} width={290} title="Comparison window">
        {(close) => (
          <div className="lab-pop__body">
            <Menu items={compareItems} onPick={(k) => {
              if (k === 'custom') {
                const s = envelope ? Date.parse(envelope.period.start) : Date.now() - 30 * DAY
                const e = envelope ? Date.parse(envelope.period.end) : Date.now()
                act.set({ compare: { mode: 'custom', start: new Date(s - (e - s)).toISOString(), end: new Date(s).toISOString() } })
              } else act.set({ compare: { mode: k as LabCompareMode } })
              close()
            }} />
            {ctx.compare.mode === 'custom' ? <CustomCompare ctx={ctx} act={act} /> : null}
            {envelope?.compare?.reason ? <p className="lab-note">{envelope.compare.reason}</p> : null}
          </div>
        )}
      </Popover>
      <Popover label={ctx.grain === 'auto' ? `Auto${autoGrain ? ` · ${autoGrain}` : ''}` : ctx.grain} icon="calendar" width={220} title="Time grain">
        {(close) => <div className="lab-pop__body"><Menu items={grainItems} onPick={(k) => { act.set({ grain: k as LabGrain }); close() }} /><p className="lab-note">Buckets use your local calendar ({tz}). Hour-of-day analysis uses the seller’s local time.</p></div>}
      </Popover>
      <span className="alab-bar__rule" aria-hidden="true" />
      <div className="alab-bar__filters">
        {ctx.filters.map((f, i) => (
          <span key={`${f.field}-${f.op}-${i}`} className={cls('lab-chip', f.field === 'include_test_campaigns' && 'is-system')}>
            <span>{filterChipText(f as LabFilter & { labels?: string[] }, registry)}</span>
            <button type="button" aria-label="Remove filter" onClick={() => act.removeFilter(i)}><Icon name="close" /></button>
          </span>
        ))}
        {!ctx.filters.some((f) => f.field === 'include_test_campaigns') ? <span className="lab-chip is-fixed" title="Structural test / proof campaigns are excluded from every figure and ranking unless you include them">Test campaigns excluded</span> : null}
        <span className="lab-chip is-fixed" title="The 5 internal test phones and canary-flagged rows are always excluded">Canary excluded</span>
        <Popover label="Filter" icon="filter" width={620} className="lab-pop--builder" title="Add a filter">
          {(close) => <FilterBuilder ctx={ctx} registry={registry} onAdd={(f) => { act.addFilter(f); close() }} />}
        </Popover>
      </div>
      <span className="alab-bar__spacer" />
      <Popover label={ctx.groupBy ? `Group · ${registry?.dimensions[ctx.groupBy]?.label || ctx.groupBy}` : 'Group by'} icon="layers" active={Boolean(ctx.groupBy)} width={260} align="end" title={metricDef ? `Dimensions valid for ${metricDef.label}` : 'Group by'}>
        {(close) => <div className="lab-pop__body is-scroll"><Menu items={groupItems} onPick={(k) => { act.set({ groupBy: k === '__none' ? null : k }); close() }} /></div>}
      </Popover>
      <SavedViewsMenu ctx={ctx} act={act} />
      <button type="button" className={cls('lab-ctl is-quiet', loading && 'is-busy')} onClick={onRefresh} title={envelope?.dataAsOf ? `Data as of ${new Date(envelope.dataAsOf).toLocaleString()}` : 'Refresh'}>
        <i className={cls('lab-live', loading && 'is-syncing')} aria-hidden="true" />{asOf ? `as of ${asOf}` : 'live'}<Icon name="refresh-cw" />
      </button>
    </div>
  )
}

function dateInput(iso: string | undefined) { return iso ? iso.slice(0, 10) : '' }
function CustomRange({ ctx, act }: { ctx: LabContext; act: LabActions }) {
  const [s, setS] = useState(dateInput(ctx.range.start))
  const [e, setE] = useState(dateInput(ctx.range.end))
  const bad = !s || !e || Date.parse(s) >= Date.parse(e) || (Date.parse(e) - Date.parse(s)) / DAY > 400
  return (
    <span className="lab-range">
      <input type="date" value={s} min="2026-04-18" onChange={(x) => setS(x.target.value)} aria-label="Start date" />
      <span>→</span>
      <input type="date" value={e} min="2026-04-18" onChange={(x) => setE(x.target.value)} aria-label="End date" />
      <button type="button" className="lab-ctl is-primary" disabled={bad} onClick={() => act.set({ range: { preset: 'custom', start: new Date(`${s}T00:00:00`).toISOString(), end: new Date(`${e}T23:59:59`).toISOString() }, grain: 'auto' })}>Apply</button>
      {Date.parse(s) < HISTORY ? <em className="lab-note">History begins Apr 18</em> : null}
    </span>
  )
}
function CustomCompare({ ctx, act }: { ctx: LabContext; act: LabActions }) {
  const [s, setS] = useState(dateInput(ctx.compare.start))
  const [e, setE] = useState(dateInput(ctx.compare.end))
  const bad = !s || !e || Date.parse(s) >= Date.parse(e)
  return (
    <div className="lab-range is-block">
      <input type="date" value={s} onChange={(x) => setS(x.target.value)} aria-label="Comparison start" />
      <span>→</span>
      <input type="date" value={e} onChange={(x) => setE(x.target.value)} aria-label="Comparison end" />
      <button type="button" className="lab-ctl is-primary" disabled={bad} onClick={() => act.set({ compare: { mode: 'custom', start: new Date(`${s}T00:00:00`).toISOString(), end: new Date(`${e}T23:59:59`).toISOString() } })}>Apply</button>
    </div>
  )
}

/* ── the + FILTER builder ─────────────────────────────────────────────────── */

const FAMILY_ORDER = ['GEOGRAPHY', 'PROPERTY', 'OWNER', 'SELLER', 'CAMPAIGN', 'COMMUNICATION', 'CHANNEL', 'SENDER', 'TEMPLATE', 'WORKFLOW', 'PIPELINE', 'TIME', 'SYSTEM']

function FilterBuilder({ ctx, registry, onAdd }: { ctx: LabContext; registry: LabRegistry | null; onAdd: (f: LabFilter & { labels?: string[] }) => void }) {
  const fields = registry?.filters || []
  const [q, setQ] = useState('')
  const [family, setFamily] = useState<string>('GEOGRAPHY')
  const [field, setField] = useState<FilterFieldDef | null>(null)
  const shown = useMemo(() => (q ? fields.filter((f) => `${f.label} ${f.family} ${f.source}`.toLowerCase().includes(q.toLowerCase())) : fields.filter((f) => f.family === family)), [fields, q, family])
  const families = FAMILY_ORDER.filter((fam) => fields.some((f) => f.family === fam))
  return (
    <div className="lab-fb">
      <div className="lab-fb__head">
        <Icon name="search" />
        <input autoFocus placeholder="Search fields — market, equity, sender, template…" value={q} onChange={(e) => { setQ(e.target.value); setField(null) }} />
      </div>
      <div className="lab-fb__cols">
        <nav className="lab-fb__families" aria-label="Field families">
          {families.map((fam) => <button key={fam} type="button" className={cls(!q && family === fam && 'is-on')} onClick={() => { setFamily(fam); setQ(''); setField(null) }}>{fam.toLowerCase()}</button>)}
        </nav>
        <div className="lab-fb__fields">
          {field ? <FieldEditor ctx={ctx} field={field} onBack={() => setField(null)} onAdd={onAdd} /> : (
            <ul>
              {shown.map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => setField(f)}>
                    <b>{f.label}</b>
                    <span>{f.type} · applies to {f.applies.join(', ')}</span>
                    <small>{f.coverage} · {f.source}</small>
                  </button>
                </li>
              ))}
              {!shown.length ? <li className="lab-note">No field matches. {registry?.nonViable.length ? 'Some fields are deliberately not offered — see below.' : ''}</li> : null}
            </ul>
          )}
          {!field && (q || family === 'SYSTEM') && registry?.nonViable.length ? (
            <details className="lab-fb__nonviable">
              <summary>Not offered, and why</summary>
              <ul>{registry.nonViable.map((x) => <li key={x.field}><b>{x.field}</b><span>{x.reason}</span></li>)}</ul>
            </details>
          ) : null}
        </div>
      </div>
      <p className="lab-note lab-fb__foot">Filters narrow the period’s activity cohort (joined by primary key) — they never scan the 168K-property universe. A filter that does not apply to a metric marks it “not filterable”; it is never silently ignored.</p>
    </div>
  )
}

function FieldEditor({ ctx, field, onBack, onAdd }: { ctx: LabContext; field: FilterFieldDef; onBack: () => void; onAdd: (f: LabFilter & { labels?: string[] }) => void }) {
  const [op, setOp] = useState(field.operators[0])
  const [picked, setPicked] = useState<Map<string, string>>(new Map())
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [search, setSearch] = useState('')
  const [opts, setOpts] = useState<{ values: Array<{ value: string; label: string; n: number; test?: boolean }>; loading: boolean; error: string | null }>({ values: [], loading: field.type === 'category', error: null })
  useEffect(() => {
    if (field.type !== 'category') return
    const ctl = new AbortController()
    fetchLabFilterOptions(ctx, field.id, ctl.signal)
      .then((r) => setOpts({ values: r.values, loading: false, error: null }))
      .catch((e) => { if (!ctl.signal.aborted) setOpts({ values: [], loading: false, error: String(e?.message || e) }) })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id])
  const noValue = ['exists', 'missing', 'is_true', 'is_false'].includes(op)
  const values = opts.values.filter((v) => !search || v.label.toLowerCase().includes(search.toLowerCase()))
  const ready = noValue || (field.type === 'category' ? picked.size > 0 : op === 'between' ? a !== '' && b !== '' : a !== '')
  const submit = () => {
    if (!ready) return
    if (noValue) return onAdd({ field: field.id, op, value: null })
    if (field.type === 'category') {
      const keys = [...picked.keys()]
      return onAdd({ field: field.id, op, value: op === 'eq' || op === 'neq' ? keys[0] : keys, labels: [...picked.values()] })
    }
    if (op === 'between') return onAdd({ field: field.id, op, value: [Number(a), Number(b)] })
    return onAdd({ field: field.id, op, value: Number(a) })
  }
  return (
    <div className="lab-fe">
      <button type="button" className="lab-fe__back" onClick={onBack}><Icon name="chevron-left" />{field.family.toLowerCase()}</button>
      <div className="lab-fe__title"><b>{field.label}</b><small>{field.coverage} · {field.source}</small></div>
      <div className="lab-fe__ops" role="radiogroup" aria-label="Operator">
        {field.operators.map((o) => <button key={o} type="button" role="radio" aria-checked={op === o} className={cls(op === o && 'is-on')} onClick={() => setOp(o)}>{OP_LABEL[o] || o}</button>)}
      </div>
      {noValue ? null : field.type === 'category' ? (
        <div className="lab-fe__values">
          <input placeholder={`Search ${field.label.toLowerCase()} in this period`} value={search} onChange={(e) => setSearch(e.target.value)} />
          {opts.loading ? <p className="lab-note">Reading the values present in this period…</p> : opts.error ? <p className="lab-note is-bad">{opts.error}</p> : null}
          <ul>
            {values.slice(0, 200).map((v) => {
              const on = picked.has(v.value)
              return (
                <li key={v.value}>
                  <label className={cls(on && 'is-on')}>
                    <input type={op === 'eq' || op === 'neq' ? 'radio' : 'checkbox'} name={`fv-${field.id}`} checked={on} onChange={() => setPicked((m) => { const n = op === 'eq' || op === 'neq' ? new Map<string, string>() : new Map(m); if (on) n.delete(v.value); else n.set(v.value, v.label); return n })} />
                    <span>{v.label}{v.test ? <em className="lab-tag">test</em> : null}</span>
                    <em>{v.n.toLocaleString('en-US')}</em>
                  </label>
                </li>
              )
            })}
            {!opts.loading && !values.length ? <li className="lab-note">No values in this period’s cohort.</li> : null}
          </ul>
        </div>
      ) : (
        <div className="lab-fe__num">
          <input type="number" value={a} onChange={(e) => setA(e.target.value)} placeholder={field.unit ? `value ${field.unit}` : 'value'} aria-label="Value" />
          {op === 'between' ? <><span>and</span><input type="number" value={b} onChange={(e) => setB(e.target.value)} aria-label="Upper value" /></> : null}
        </div>
      )}
      <div className="lab-fe__foot">
        <span className="lab-note">Applies to {field.applies.join(', ')}.</span>
        <button type="button" className="lab-ctl is-primary" disabled={!ready} onClick={submit}>Add filter</button>
      </div>
    </div>
  )
}

/* ── saved views ──────────────────────────────────────────────────────────── */

const DEVICE_VIEWS = 'anx:lab:views:v1'
function readDeviceViews(): Array<{ id: string; label: string; context: LabContext; updated_at: string }> {
  try { return JSON.parse(localStorage.getItem(DEVICE_VIEWS) || '[]') } catch { return [] }
}
function SavedViewsMenu({ ctx, act }: { ctx: LabContext; act: LabActions }) {
  const [server, setServer] = useState<{ store: string; reason?: string; views: Array<{ id: string; label: string; context: LabContext }> } | null>(null)
  const [device, setDevice] = useState(readDeviceViews)
  const [name, setName] = useState('')
  useEffect(() => {
    const ctl = new AbortController()
    fetchSavedViews(ctl.signal).then(setServer).catch(() => setServer({ store: 'unavailable', views: [] }))
    return () => ctl.abort()
  }, [])
  const save = () => {
    const label = name.trim()
    if (!label) return
    const next = [{ id: `dev-${Date.now()}`, label, context: ctx, updated_at: new Date().toISOString() }, ...device.filter((v) => v.label !== label)].slice(0, 30)
    localStorage.setItem(DEVICE_VIEWS, JSON.stringify(next))
    setDevice(next)
    setName('')
  }
  const views = [...(server?.views || []), ...device]
  return (
    <Popover label="Views" icon="bookmark" width={300} align="end" title="Saved views">
      {(close) => (
        <div className="lab-pop__body">
          {views.length ? (
            <ul className="lab-menu">
              {views.map((v) => (
                <li key={v.id}>
                  <button type="button" onClick={() => { act.set(v.context); close() }}>
                    <span className="lab-menu__check"><Icon name="bookmark" /></span>
                    <span className="lab-menu__label">{v.label}<small>{v.context.range?.preset?.toUpperCase()} · {v.context.mode}{v.context.filters?.length ? ` · ${v.context.filters.length} filter${v.context.filters.length === 1 ? '' : 's'}` : ''}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="lab-note">No saved views yet.</p>}
          <div className="lab-save">
            <input placeholder="Name this view" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
            <button type="button" className="lab-ctl is-primary" disabled={!name.trim()} onClick={save}>Save</button>
          </div>
          <p className="lab-note">{server?.store === 'server' ? 'Saved to the server.' : 'Saved on this device. A shared store (analytics_saved_views) is proposed and awaits approval.'} The link in the address bar always restores this exact view.</p>
        </div>
      )}
    </Popover>
  )
}
