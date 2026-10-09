/**
 * ENTITY GRAPH DESK · the per-column header menu: sort the whole cohort, and
 * filter on that column with exact counts over the whole filtered cohort
 * (GET /entity-graph/header-values). Applying writes ONE ordinary chip into
 * the rail's filter AST (desk-header-filter.ts) — no second filter system.
 */
import { useEffect, useMemo, useState } from 'react'
import { LCButton, LCPopover, LCSearch, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { fetchEntityGraphHeaderValues, type EntityGraphHeaderValues } from '../../../domain/entity-graph/entity-graph-api'
import { fieldFiltersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import {
  activeHeaderFilter,
  headerAsOfText,
  headerFilterFromSelection,
  headerSelectionProblem,
  headerValueLabel,
  replaceFieldFilter,
  selectionFromFilter,
  type HeaderKind,
  type HeaderSelection,
} from './desk-header-filter'
import { fmtCount } from './desk-model'

type Props = {
  label: string
  /** the facts column the menu counts and filters on */
  column: string
  /** catalog field key resolved client-side (active state before the menu opens) */
  fieldKey: string | null
  filters: EntityGraphFieldFilter[]
  onFiltersChange: (next: EntityGraphFieldFilter[]) => void
  sortDir: 'asc' | 'desc' | null
  onSort: (dir: 'asc' | 'desc' | null) => void
  sortable: boolean
}

export function DeskHeaderFilter({ label, column, fieldKey, filters, onFiltersChange, sortDir, onSort, sortable }: Props) {
  const [open, setOpen] = useState(false)
  const active = activeHeaderFilter(filters, fieldKey)
  return (
    <LCPopover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      width={300}
      label={`${label} — sort and filter`}
      className="egdk-hf"
      trigger={(
        <button type="button" className={cx('egdk-hf__trigger', active && 'is-active')} aria-label={`${label}: sort and filter${active ? ' (filtered)' : ''}`} title={active ? `${label} is filtered — sort / change the filter` : `Sort / filter ${label}`}>
          <Icon name="filter" size={11} />
        </button>
      )}
    >
      {open ? <HeaderMenu label={label} column={column} filters={filters} onFiltersChange={(next) => { onFiltersChange(next); setOpen(false) }} sortDir={sortDir} onSort={(d) => { onSort(d); setOpen(false) }} sortable={sortable} /> : null}
    </LCPopover>
  )
}

function HeaderMenu({ label, column, filters, onFiltersChange, sortDir, onSort, sortable }: Omit<Props, 'fieldKey'>) {
  const [sel, setSel] = useState<HeaderSelection>({ values: [] })
  const [find, setFind] = useState('')
  const [attempt, setAttempt] = useState(0)
  // keyed by request: a stale answer is never shown for a newer cohort (no reset-in-effect)
  const sig = `${column}|${JSON.stringify(filters)}|${attempt}`
  const [loaded, setLoaded] = useState<{ sig: string; data: EntityGraphHeaderValues | null; error: string | null } | null>(null)
  const state = loaded?.sig === sig ? loaded : null

  useEffect(() => {
    const ctl = new AbortController()
    void fetchEntityGraphHeaderValues({ tab: 'properties', column, ...fieldFiltersToApiParams(filters) }, ctl.signal)
      .then((data) => {
        if (ctl.signal.aborted) return
        setLoaded({ sig, data, error: null })
        const kind = (data.kind || 'categorical') as HeaderKind
        setSel(selectionFromFilter(activeHeaderFilter(filters, data.field?.key ?? null), kind))
      })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setLoaded({ sig, data: null, error: e instanceof Error ? e.message : 'These values did not load' }) })
    return () => ctl.abort()
    // the column's own chip is left out of its counts server-side; refetch when the cohort changes
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  const data = state?.data ?? null
  const kind = (data?.kind || 'categorical') as HeaderKind
  const field = data?.field ?? null
  const current = activeHeaderFilter(filters, field?.key ?? null)
  const values = useMemo(() => {
    const list = data?.values ?? []
    const q = find.trim().toLowerCase()
    return q ? list.filter((v) => headerValueLabel(column, v.value, kind).toLowerCase().includes(q) || String(v.value ?? '').toLowerCase().includes(q)) : list
  }, [data, find, column, kind])
  const problem = data ? headerSelectionProblem(field, kind, sel) : null
  const next = data ? headerFilterFromSelection(field, kind, sel) : null
  const toggle = (v: string | null) => setSel((cur) => {
    const list = cur.values ?? []
    return { ...cur, contains: '', values: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] }
  })
  const listKind = kind === 'categorical' || kind === 'tokens' || kind === 'boolean' || kind === 'text'

  return (
    <div className="egdk-hf__body">
      <div className="egdk-hf__head">
        <strong>{label}</strong>
        {sortable ? (
          <div className="egdk-hf__sort" role="group" aria-label={`Sort ${label}`}>
            <button type="button" className={cx('egdk-hf__sortbtn', sortDir === 'asc' && 'is-on')} onClick={() => onSort(sortDir === 'asc' ? null : 'asc')}><Icon name="chevron-up" size={11} />Ascending</button>
            <button type="button" className={cx('egdk-hf__sortbtn', sortDir === 'desc' && 'is-on')} onClick={() => onSort(sortDir === 'desc' ? null : 'desc')}><Icon name="chevron-down" size={11} />Descending</button>
          </div>
        ) : null}
        <small className="egdk-hf__sub">Sorts and counts the whole filtered cohort on the server</small>
      </div>

      {!state ? <LCSkeleton shape="lines" count={4} label={`Counting ${label}`} />
        : state.error ? (
          <div className="egdk-hf__error" role="alert">
            <p>{state.error}</p>
            <LCButton size="sm" variant="quiet" onClick={() => setAttempt((n) => n + 1)}>Try again</LCButton>
          </div>
        ) : !data?.supported || !field ? (
          <p className="egdk-hf__none">This column has no filter field on this scope{data?.reason ? ` (${data.reason.replace(/_/g, ' ')})` : ''}.</p>
        ) : (
          <>
            <p className="egdk-hf__meta">
              {`${fmtCount(data.known)} of ${fmtCount(data.total)} have a value`}
              <span aria-hidden="true"> · </span>
              <span title={data.asOf ?? undefined}>{headerAsOfText(data.mode, data.source, data.asOf)}</span>
            </p>
            {listKind ? (
              <>
                {(data.values?.length ?? 0) > 10 ? <LCSearch value={find} onChange={setFind} label={`Find a ${label} value`} placeholder="Find a value" className="egdk-hf__find" /> : null}
                <ul className="egdk-hf__list" role="listbox" aria-multiselectable="true" aria-label={`${label} values`}>
                  {values.map((v) => {
                    const on = (sel.values ?? []).includes(v.value)
                    return (
                      <li key={v.value ?? '__none'}>
                        <button type="button" role="option" aria-selected={on} className={cx('egdk-hf__opt', on && 'is-on', v.value === null && 'is-none')} onClick={() => toggle(v.value)}>
                          <span className="egdk-hf__check" aria-hidden="true">{on ? <Icon name="check" size={10} /> : null}</span>
                          <span className="egdk-hf__label">{headerValueLabel(column, v.value, kind)}</span>
                          <span className="egdk-hf__count">{fmtCount(v.count)}</span>
                        </button>
                      </li>
                    )
                  })}
                  {!values.length ? <li className="egdk-hf__empty">{find ? 'No value matches' : 'No values in this cohort'}</li> : null}
                </ul>
                {data.truncated ? <p className="egdk-hf__note">The 300 most common values are listed{field.operators.some((o) => o.key === 'contains') ? ' — use “contains” for the rest' : ''}.</p> : null}
                {field.operators.some((o) => o.key === 'contains') && kind !== 'boolean' ? (
                  <label className="egdk-hf__contains">
                    <span>Contains</span>
                    <input className="egdk-input" type="text" value={sel.contains ?? ''} placeholder="text…" onChange={(e) => setSel({ values: [], contains: e.target.value })} />
                  </label>
                ) : null}
              </>
            ) : (
              <div className="egdk-hf__range">
                <label><span>From</span><input className="egdk-input" type={kind === 'date' ? 'date' : 'number'} value={sel.from ?? ''} placeholder={rangeHint(data.range?.min, kind)} onChange={(e) => setSel((c) => ({ ...c, presence: null, from: e.target.value }))} /></label>
                <label><span>To</span><input className="egdk-input" type={kind === 'date' ? 'date' : 'number'} value={sel.to ?? ''} placeholder={rangeHint(data.range?.max, kind)} onChange={(e) => setSel((c) => ({ ...c, presence: null, to: e.target.value }))} /></label>
                <div className="egdk-hf__presence" role="group" aria-label="Presence">
                  <button type="button" className={cx('egdk-hf__sortbtn', sel.presence === 'has' && 'is-on')} onClick={() => setSel({ presence: sel.presence === 'has' ? null : 'has' })}>{`Has a value · ${fmtCount(data.known)}`}</button>
                  <button type="button" className={cx('egdk-hf__sortbtn', sel.presence === 'none' && 'is-on')} onClick={() => setSel({ presence: sel.presence === 'none' ? null : 'none' })}>{`No value · ${fmtCount(Math.max(0, data.total - data.known))}`}</button>
                </div>
                <p className="egdk-hf__note">{`Range in this cohort: ${rangeHint(data.range?.min, kind) || '—'} – ${rangeHint(data.range?.max, kind) || '—'}`}</p>
              </div>
            )}
            {problem ? <p className="egdk-hf__warn" role="status">{problem}</p> : null}
            <div className="egdk-hf__actions">
              <LCButton size="sm" variant="quiet" disabled={!current} onClick={() => onFiltersChange(replaceFieldFilter(filters, field.key, null))}>Clear filter</LCButton>
              <LCButton size="sm" variant="primary" disabled={!next || Boolean(problem)} onClick={() => { if (next) onFiltersChange(replaceFieldFilter(filters, field.key, next)) }}>Apply</LCButton>
            </div>
          </>
        )}
    </div>
  )
}

function rangeHint(v: string | null | undefined, kind: HeaderKind): string {
  if (v === null || v === undefined || v === '') return ''
  if (kind === 'date') return String(v).slice(0, 10)
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(v)
}
