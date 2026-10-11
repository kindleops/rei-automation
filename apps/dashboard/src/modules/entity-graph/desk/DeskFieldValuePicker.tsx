/**
 * ENTITY GRAPH DESK · the "All fields" value picker (owner P0, 2026-10-10:
 * "a DROPDOWN of real values with counts for every categorical field, min/max
 * range pickers for numeric fields, never free typing — except name/address
 * text search").
 *
 * Values come from the header filters' endpoint (?field=, any tab): exact
 * counts over the filtered cohort with this field's own filter left out, never
 * a sample. The chip it writes is the header filter's chip (desk-field-values.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import { LCButton, LCSearch, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { fetchEntityGraphFieldValues, type EntityGraphHeaderValues } from '../../../domain/entity-graph/entity-graph-api'
import { fieldFiltersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import type { EntityGraphFieldFilter, EntityGraphFilterField } from '../../../domain/entity-graph/entity-graph-field-filters'
import { headerAsOfText, headerValueLabel, type HeaderKind, type HeaderSelection } from './desk-header-filter'
import {
  checklistModeOf,
  checklistModes,
  compactNumber,
  histogramBars,
  pickerControlFor,
  pickerFilterFromSelection,
  pickerKindFor,
  pickerSelectionFromFilter,
  pickerSelectionProblem,
  textFilterFrom,
  optionMembers,
  optionSelected,
  toggleMembers,
  type ChecklistMode,
} from './desk-field-values'
import { fmtCount } from './desk-model'

type Props = {
  tab: string
  field: EntityGraphFilterField
  filter: EntityGraphFieldFilter
  /** the APPLIED cohort (the values are counted in it; this field's own chip is left out server-side) */
  cohort: EntityGraphFieldFilter[]
  onChange: (next: EntityGraphFieldFilter) => void
}

const MODE_LABEL: Record<ChecklistMode, string> = { any: 'Any of', all: 'All of', not: 'Exclude' }

export function DeskFieldValuePicker({ tab, field, filter, cohort, onChange }: Props) {
  const declaredKind = pickerKindFor(field as EntityGraphFilterField & { fact_kind?: string | null })
  const control0 = pickerControlFor(field, declaredKind)
  const [search, setSearch] = useState('')
  const [serverSearch, setServerSearch] = useState('')
  const [attempt, setAttempt] = useState(0)
  // debounce the server-side value search (only fires when the list was truncated or the operator typed)
  useEffect(() => {
    const t = setTimeout(() => setServerSearch(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  const others = useMemo(() => cohort.filter((f) => f.field_key !== field.key), [cohort, field.key])
  const sig = `${tab}|${field.key}|${JSON.stringify(others)}|${serverSearch}|${attempt}`
  const [loaded, setLoaded] = useState<{ sig: string; data: EntityGraphHeaderValues | null; error: string | null } | null>(null)
  const state = loaded?.sig === sig ? loaded : null
  useEffect(() => {
    if (control0 === 'text') return
    const ctl = new AbortController()
    void fetchEntityGraphFieldValues({ tab, field: field.key, ...(serverSearch ? { search: serverSearch } : {}), ...fieldFiltersToApiParams(others) }, ctl.signal)
      .then((data) => { if (!ctl.signal.aborted) setLoaded({ sig, data, error: null }) })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setLoaded({ sig, data: null, error: e instanceof Error ? e.message : 'These values did not load' }) })
    return () => ctl.abort()
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  const data = state?.data ?? null
  const kind = ((data?.kind as HeaderKind | undefined) ?? declaredKind)
  const control = data?.control ?? control0
  const sel = pickerSelectionFromFilter(filter, kind)
  const mode = checklistModeOf(filter)
  const modes = checklistModes(field)
  const emptyRow = (): EntityGraphFieldFilter => ({ field_key: field.key, operator: filter.operator, value: Array.isArray(filter.value) ? [] : '' })
  const write = (nextSel: HeaderSelection, nextMode: ChecklistMode = mode) => {
    const next = pickerFilterFromSelection(field, kind, nextSel, nextMode)
    onChange(next ?? emptyRow())
  }
  const problem = pickerSelectionProblem(field, kind, sel)

  if (control === 'text') {
    const text = typeof filter.value === 'string' ? filter.value : Array.isArray(filter.value) ? String(filter.value[0] ?? '') : ''
    return (
      <div className="egdk-hf egdk-fv">
        <input className="egdk-input" type="search" value={text} placeholder={`Search ${field.label.toLowerCase()}`} aria-label={`${field.label} contains`}
          onChange={(e) => onChange(textFilterFrom(field, e.target.value) ?? { field_key: field.key, operator: field.operators.some((o) => o.key === 'contains') ? 'contains' : filter.operator, value: '' })} />
        <p className="egdk-hf__note">Text search — names, addresses and ids are matched as typed.</p>
      </div>
    )
  }

  return (
    <div className="egdk-hf egdk-fv">
      {field.sensitive ? <p className="egdk-fv__sensitive" title={field.sensitive_note}><Icon name="shield" size={11} />Personal attribute · display &amp; targeting only, never pricing</p> : null}
      {!state ? <LCSkeleton shape="lines" count={3} label={`Counting ${field.label}`} />
        : state.error ? (
          <div className="egdk-hf__error" role="alert">
            <p>{state.error}</p>
            <LCButton size="sm" variant="quiet" onClick={() => setAttempt((n) => n + 1)}>Try again</LCButton>
          </div>
        ) : !data?.supported ? (
          <p className="egdk-hf__none">No values for this field on this scope{data?.reason ? ` (${data.reason.replace(/_/g, ' ')})` : ''}.</p>
        ) : control === 'range' ? (
          <RangePicker data={data} kind={kind} sel={sel} onSel={(s) => write(s)} />
        ) : control === 'boolean' ? (
          <div className="egdk-fv__bool" role="group" aria-label={field.label}>
            {(['true', 'false', null] as Array<string | null>).map((v) => {
              const count = data.values?.find((x) => x.value === v)?.count ?? (v === null && data.total !== null && data.known !== null ? Math.max(0, data.total - data.known) : 0)
              const on = (sel.values ?? []).length === 1 && (sel.values ?? [])[0] === v
              const op = v === 'true' ? 'is_true' : v === 'false' ? 'is_false' : 'is_empty'
              const possible = field.operators.some((o) => o.key === op)
              return (
                <button key={v ?? '__none'} type="button" disabled={!possible} aria-pressed={on} className={cx('egdk-hf__sortbtn', on && 'is-on')} onClick={() => write({ values: on ? [] : [v] })}>
                  {v === 'true' ? 'Yes' : v === 'false' ? 'No' : 'Not recorded'} · {fmtCount(count)}
                </button>
              )
            })}
          </div>
        ) : (
          <>
            <p className="egdk-hf__meta">
              {data.total !== null && data.known !== null ? `${fmtCount(data.known)} of ${fmtCount(data.total)} have a value` : `Values matching “${data.search ?? ''}”`}
              {data.asOf || data.mode ? <><span aria-hidden="true"> · </span><span title={data.asOf ?? undefined}>{headerAsOfText(data.mode, data.source, data.asOf)}</span></> : null}
            </p>
            {modes.length > 1 ? (
              <div className="egdk-hf__sort" role="group" aria-label={`${field.label}: match`}>
                {modes.map((m) => (
                  <button key={m} type="button" className={cx('egdk-hf__sortbtn', mode === m && 'is-on')} aria-pressed={mode === m} onClick={() => write(sel, m)}>{MODE_LABEL[m]}</button>
                ))}
              </div>
            ) : null}
            <ValueList data={data} kind={kind} column={field.source_column} search={search} onSearch={setSearch} selected={sel.values ?? []}
              onToggle={(members) => write({ values: toggleMembers(sel.values ?? [], members) })} />
          </>
        )}
      {problem && state?.data ? <p className="egdk-hf__warn" role="status">{problem}</p> : null}
    </div>
  )
}

function ValueList({ data, kind, column, search, onSearch, selected, onToggle }: {
  data: EntityGraphHeaderValues
  kind: HeaderKind
  column: string
  search: string
  onSearch: (s: string) => void
  selected: Array<string | null>
  onToggle: (members: Array<string | null>) => void
}) {
  const q = search.trim().toLowerCase()
  const values = (data.values ?? []).filter((v) => !q || headerValueLabel(column, v.value, kind).toLowerCase().includes(q) || String(v.value ?? '').toLowerCase().includes(q))
  const max = Math.max(1, ...values.map((v) => v.count))
  // a chosen value outside the visible list stays visible (and removable)
  const missing = selected.filter((s) => !values.some((v) => optionMembers(v).includes(s)))
  return (
    <>
      {(data.values?.length ?? 0) > 8 || data.truncated || q ? <LCSearch value={search} onChange={onSearch} label="Find a value" placeholder={data.truncated ? 'Search all values' : `Find a value · ${data.values?.length ?? 0}`} className="egdk-hf__find" /> : null}
      <ul className="egdk-hf__list egdk-fv__list" role="listbox" aria-multiselectable="true">
        {missing.map((s) => (
          <li key={`sel:${s ?? '__none'}`}>
            <button type="button" role="option" aria-selected="true" className="egdk-hf__opt is-on" onClick={() => onToggle([s])}>
              <span className="egdk-hf__check" aria-hidden="true"><Icon name="check" size={10} /></span>
              <span className="egdk-hf__label">{headerValueLabel(column, s, kind)}</span>
              <span className="egdk-hf__count">—</span>
            </button>
          </li>
        ))}
        {values.map((v) => {
          const members = optionMembers(v)
          const on = optionSelected(selected, members)
          return (
            <li key={v.value ?? '__none'}>
              <button type="button" role="option" aria-selected={on} className={cx('egdk-hf__opt', 'egdk-fv__opt', on && 'is-on', v.value === null && 'is-none')} style={{ ['--w' as string]: `${Math.max(1, (v.count / max) * 100)}%` }} onClick={() => onToggle(members)}
                title={members.length > 1 ? `Spelled ${members.map((m) => `“${m}”`).join(', ')} in the data — all selected together` : undefined}>
                <span className="egdk-hf__check" aria-hidden="true">{on ? <Icon name="check" size={10} /> : null}</span>
                <span className="egdk-hf__label">{headerValueLabel(column, v.value, kind)}{members.length > 1 ? <small className="egdk-fv__variants"> · {members.length} spellings</small> : null}</span>
                <span className="egdk-hf__count">{fmtCount(v.count)}</span>
              </button>
            </li>
          )
        })}
        {!values.length && !missing.length ? <li className="egdk-hf__empty">{q ? 'No value matches' : 'No values in this cohort'}</li> : null}
      </ul>
      {data.truncated ? <p className="egdk-hf__note">The 300 most common values are listed — search finds any value.</p> : null}
    </>
  )
}

function RangePicker({ data, kind, sel, onSel }: { data: EntityGraphHeaderValues; kind: HeaderKind; sel: HeaderSelection; onSel: (s: HeaderSelection) => void }) {
  const isDate = kind === 'date'
  const bars = histogramBars(data.histogram?.buckets)
  const years = data.histogram?.years ?? []
  const yMax = Math.max(1, ...years.map((y) => y.count))
  const qs = data.histogram?.quantiles
  const hint = (v: string | null | undefined) => (v === null || v === undefined ? '' : isDate ? String(v).slice(0, 10) : compactNumber(Number(v)))
  const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100)
  return (
    <div className="egdk-hf__range">
      <label><span>From</span><input className="egdk-input" type={isDate ? 'date' : 'number'} value={sel.from ?? ''} placeholder={hint(data.range?.min)} onChange={(e) => onSel({ ...sel, presence: null, from: e.target.value })} /></label>
      <label><span>To</span><input className="egdk-input" type={isDate ? 'date' : 'number'} value={sel.to ?? ''} placeholder={hint(data.range?.max)} onChange={(e) => onSel({ ...sel, presence: null, to: e.target.value })} /></label>
      {bars.length ? (
        <div className="egdk-fv__hist" role="group" aria-label="Distribution in this cohort — pick a bar to use its range">
          {bars.map((b, i) => (
            <button key={i} type="button" className={cx('egdk-fv__bar', b.tail && 'is-tail')} style={{ ['--h' as string]: `${Math.max(4, b.share * 100)}%` }}
              title={`${compactNumber(b.lo)} – ${compactNumber(b.hi)}${b.tail ? (b.tail === 'below' ? ' (lowest 1%)' : ' (highest 1%)') : ''} · ${fmtCount(b.count)}`}
              onClick={() => onSel({ presence: null, from: String(round(b.lo)), to: String(round(b.hi)) })} />
          ))}
        </div>
      ) : null}
      {isDate && years.length ? (
        <div className="egdk-fv__hist" role="group" aria-label="Per year in this cohort — pick a year">
          {years.map((y) => (
            <button key={y.year} type="button" className="egdk-fv__bar" style={{ ['--h' as string]: `${Math.max(4, (y.count / yMax) * 100)}%` }} title={`${y.year} · ${fmtCount(y.count)}`}
              onClick={() => onSel({ presence: null, from: `${y.year}-01-01`, to: `${y.year}-12-31` })} />
          ))}
        </div>
      ) : null}
      {qs ? <p className="egdk-hf__note">{`Median ${compactNumber(qs.p50)} · middle half ${compactNumber(qs.p25)}–${compactNumber(qs.p75)} · 90% within ${compactNumber(qs.p5)}–${compactNumber(qs.p95)}`}</p> : null}
      <div className="egdk-hf__presence" role="group" aria-label="Presence">
        <button type="button" className={cx('egdk-hf__sortbtn', sel.presence === 'has' && 'is-on')} onClick={() => onSel({ presence: sel.presence === 'has' ? null : 'has' })}>{`Has a value · ${fmtCount(data.known)}`}</button>
        <button type="button" className={cx('egdk-hf__sortbtn', sel.presence === 'none' && 'is-on')} onClick={() => onSel({ presence: sel.presence === 'none' ? null : 'none' })}>{`Not recorded · ${fmtCount(data.total !== null && data.known !== null ? Math.max(0, data.total - data.known) : null)}`}</button>
      </div>
      <p className="egdk-hf__note">{`Range in this cohort: ${hint(data.range?.min) || '—'} – ${hint(data.range?.max) || '—'}`}</p>
    </div>
  )
}
