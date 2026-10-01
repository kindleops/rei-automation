/**
 * THE FILTER INSPECTOR — one place to narrow the analytical slice.
 *
 * Fields come from the registry (every one real and populated, measured);
 * their values come from the period's own cohort, with counts. Edits are a
 * DRAFT: before applying, the inspector shows the population the draft would
 * leave (sellers reached, measured by the same engine) against the current
 * one. A filter that does not apply to a metric makes that metric say "not
 * filterable" — it is never silently ignored.
 */
import { useMemo, useState } from 'react'
import type { FilterFieldDef, FilterOptions, LabQuery } from '../../../domain/analytics/analytics-lab-api'
import { LCButton, LCChip, LCFilterInspector, LCSearch, cx } from '../../../shared/lc'
import type { LCFilterSection } from '../../../shared/lc'
import { useLab } from './intel-context'
import { paths, stableJson, useIntel } from './intel-data'
import { fmtInt, fmtPct } from './intel-format'
import { serverContext } from './intel-state'
import type { FilterDraft } from './intel-model'
import { OP_LABEL, filterText } from './intel-model'

type Draft = FilterDraft

/** The brief's filter groups → the registry's field families. */
const GROUPS: ReadonlyArray<{ id: string; label: string; families: string[]; note?: string }> = [
  { id: 'time', label: 'Time', families: ['TIME'], note: 'The period and comparison live in the command bar; these narrow by the seller’s local clock.' },
  { id: 'geography', label: 'Geography', families: ['GEOGRAPHY'] },
  { id: 'seller', label: 'Seller', families: ['SELLER'] },
  { id: 'property', label: 'Property', families: ['PROPERTY', 'OWNER'] },
  { id: 'campaign', label: 'Campaign', families: ['CAMPAIGN'] },
  { id: 'communication', label: 'Communication', families: ['COMMUNICATION', 'CHANNEL', 'SENDER', 'TEMPLATE'] },
  { id: 'automation', label: 'Automation', families: ['WORKFLOW'] },
  { id: 'pipeline', label: 'Pipeline', families: ['PIPELINE'] },
  { id: 'financial', label: 'Financial', families: [], note: 'Estimated value and equity (the property record’s estimates) are under Property. Offers, contracts and revenue are not filterable: the ledgers are empty in production.' },
  { id: 'buyer', label: 'Buyer', families: [], note: 'The recorded-transaction corpus cannot filter seller activity (it is read through its own window); Buyers shows it with its data-through date.' },
  { id: 'system', label: 'System', families: ['SYSTEM'] },
]

export function IntelFilters() {
  const { ctx, act, registry, overview } = useLab()
  const fields = registry.filters
  const base = stableJson(ctx.filters)
  const [state, setState] = useState<{ base: string; draft: Draft[] }>({ base, draft: ctx.filters as Draft[] })
  // the applied filters changed elsewhere (a chip removed in the bar): start the draft from them
  if (state.base !== base) setState({ base, draft: ctx.filters as Draft[] })
  const draft = state.base === base ? state.draft : (ctx.filters as Draft[])
  const setDraft = (next: Draft[] | ((d: Draft[]) => Draft[])) => setState((st) => ({ base: st.base, draft: typeof next === 'function' ? next(st.draft) : next }))
  const [editing, setEditing] = useState<FilterFieldDef | null>(null)
  const dirty = stableJson(draft) !== stableJson(ctx.filters)
  // preview: the population the draft would leave, measured by the same engine
  const previewQ = useIntel<LabQuery>(dirty ? paths.query(serverContext({ ...ctx, filters: draft }, { metric: 'sellers_reached', groupBy: null }), 'metric') : null)
  const current = overview?.metrics.sellers_reached?.cur.value ?? null
  const preview = dirty ? previewQ.data?.metric?.cur.value ?? null : current
  const change = dirty && preview !== null && current ? (preview - current) / current : null

  const sections: LCFilterSection[] = GROUPS.map((g) => {
    const list = fields.filter((f) => g.families.includes(f.family) && f.id !== 'include_test_campaigns')
    return {
      id: g.id,
      label: g.label,
      active: draft.filter((d) => list.some((f) => f.id === d.field)).length,
      keywords: list.map((f) => f.label),
      render: () => (
        <div className="ix-fsec">
          {g.note ? <p className="ix-note">{g.note}</p> : null}
          {g.id === 'seller' ? <CohortPicker /> : null}
          {g.id === 'system' ? (
            <label className="ix-fcheck">
              <input type="checkbox" checked={draft.some((d) => d.field === 'include_test_campaigns' && d.op === 'is_true')} onChange={(e) => setDraft((dd) => [...dd.filter((d) => d.field !== 'include_test_campaigns'), ...(e.target.checked ? [{ field: 'include_test_campaigns', op: 'is_true', value: null }] : [])])} />
              <span>Include test / proof campaigns <small>excluded from every figure by default</small></span>
            </label>
          ) : null}
          <ul className="ix-ffields">
            {list.map((f) => (
              <li key={f.id}>
                <button type="button" className={cx(editing?.id === f.id && 'is-on')} onClick={() => setEditing(editing?.id === f.id ? null : f)}>
                  <b>{f.label}</b><small>{f.coverage} · applies to {f.applies.join(', ')}</small>
                </button>
                {editing?.id === f.id ? <FieldEditor field={f} onAdd={(d) => { setDraft((dd) => [...dd.filter((x) => !(x.field === d.field && x.op === d.op)), d]); setEditing(null) }} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ),
    }
  })

  return (
    <div className="ix-filters">
      {draft.length ? (
        <div className="ix-filters__chips">
          {draft.map((f, i) => { const t = filterText(f, fields); return <LCChip key={`${f.field}-${f.op}-${i}`} field={t.field} value={t.value} onRemove={() => setDraft((d) => d.filter((_, k) => k !== i))} /> })}
        </div>
      ) : <p className="ix-note">No filters: all activity in the period (canary phones and test campaigns are always excluded).</p>}
      <LCFilterInspector
        sections={sections}
        activeCount={draft.length}
        cohort={preview}
        cohortNoun={`sellers reached${change !== null ? ` · ${change > 0 ? '+' : '−'}${fmtPct(Math.abs(change), 0)} from now` : ''}`}
        counting={dirty && previewQ.loading}
        onApply={dirty ? () => act.set({ filters: draft }) : undefined}
        applyDisabled={!dirty}
        onClear={() => setDraft([])}
      />
      {registry.nonViable?.length ? (
        <details className="ix-fnon">
          <summary>Fields deliberately not offered, and why</summary>
          <ul>{registry.nonViable.map((x) => <li key={x.field}><b>{x.field}</b><span>{x.reason}</span></li>)}</ul>
        </details>
      ) : null}
    </div>
  )
}

function CohortPicker() {
  const { ctx, act, registry } = useLab()
  const active = ctx.segment.find((s) => s.dim === 'cohort')?.value || null
  return (
    <div className="ix-fcohort" role="radiogroup" aria-label="Seller cohort">
      <span className="ix-eyebrow">Seller cohort · applies immediately</span>
      <div>
        <button type="button" role="radio" aria-checked={!active} className={cx('ix-chip is-small', !active && 'is-on')} onClick={() => act.setCohort(null)}>Everyone</button>
        {Object.entries(registry.cohorts || {}).map(([k, c]) => (
          <button key={k} type="button" role="radio" aria-checked={active === k} className={cx('ix-chip is-small', active === k && 'is-on')} onClick={() => act.setCohort(k, c.label)}>{c.label}</button>
        ))}
      </div>
    </div>
  )
}

function FieldEditor({ field, onAdd }: { field: FilterFieldDef; onAdd: (f: Draft) => void }) {
  const { ctx } = useLab()
  const [op, setOp] = useState(field.operators[0])
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map())
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [q, setQ] = useState('')
  const opts = useIntel<FilterOptions>(field.type === 'category' ? paths.options(serverContext(ctx, { metric: 'reply_rate', groupBy: null }), field.id) : null)
  const values = useMemo(() => (opts.data?.values || []).filter((v) => !q || v.label.toLowerCase().includes(q.toLowerCase())), [opts.data, q])
  const noValue = ['exists', 'missing', 'is_true', 'is_false'].includes(op)
  const single = op === 'eq' || op === 'neq'
  const ready = noValue || (field.type === 'category' ? picked.size > 0 : op === 'between' ? a !== '' && b !== '' : a !== '')
  const submit = () => {
    if (!ready) return
    if (noValue) return onAdd({ field: field.id, op, value: null })
    if (field.type === 'category') {
      const keys = [...picked.keys()]
      return onAdd({ field: field.id, op, value: single ? keys[0] : keys, labels: [...picked.values()] })
    }
    if (op === 'between') return onAdd({ field: field.id, op, value: [Number(a), Number(b)] })
    return onAdd({ field: field.id, op, value: Number(a) })
  }
  return (
    <div className="ix-fedit">
      <div className="ix-fedit__ops" role="radiogroup" aria-label="Operator">
        {field.operators.map((o) => <button key={o} type="button" role="radio" aria-checked={op === o} className={cx('ix-chip is-small', op === o && 'is-on')} onClick={() => { setOp(o); setPicked(new Map()) }}>{OP_LABEL[o] || o}</button>)}
      </div>
      {noValue ? null : field.type === 'category' ? (
        <>
          <LCSearch value={q} onChange={setQ} label={`Search ${field.label.toLowerCase()} in this period`} />
          {opts.loading && !opts.data ? <p className="ix-note">Reading the values present in this period…</p> : null}
          {opts.error && !opts.data ? <p className="ix-note is-bad">{opts.error}</p> : null}
          <ul className="ix-fvalues lc-scroll">
            {values.slice(0, 200).map((v) => {
              const on = picked.has(v.value)
              return (
                <li key={v.value}>
                  <label className={cx(on && 'is-on')}>
                    <input type={single ? 'radio' : 'checkbox'} name={`fv-${field.id}`} checked={on} onChange={() => setPicked((m) => { const n = single ? new Map<string, string>() : new Map(m); if (on) n.delete(v.value); else n.set(v.value, v.label); return n })} />
                    <span>{v.label}{v.test ? <em className="ix-tag">test</em> : null}</span>
                    <em>{fmtInt(v.n)}</em>
                  </label>
                </li>
              )
            })}
            {opts.data && !values.length ? <li className="ix-note">No values in this period’s cohort.</li> : null}
          </ul>
        </>
      ) : (
        <div className="ix-fedit__num">
          <input type="number" value={a} onChange={(e) => setA(e.target.value)} placeholder={field.unit ? `value ${field.unit}` : 'value'} aria-label="Value" />
          {op === 'between' ? <><span>and</span><input type="number" value={b} onChange={(e) => setB(e.target.value)} aria-label="Upper value" /></> : null}
        </div>
      )}
      <div className="ix-fedit__foot">
        <small className="ix-muted">{field.source}</small>
        <LCButton size="sm" variant="secondary" disabled={!ready} onClick={submit}>Add to draft</LCButton>
      </div>
    </div>
  )
}
