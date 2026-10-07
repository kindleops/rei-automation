/**
 * THE FILTER RAIL — the campaign field catalog, laid out for a desk.
 *
 *   Active    every filter on the cohort, removable
 *   Quick     the one-tap presets (ordinary catalog filters)
 *   Facets    market / state / county / type: EVERY value with its exact count
 *             from one grouped query (composition all=1), searchable; counted
 *             without the facet's own selection so other values stay pickable
 *   Fields    any field the tab's query can execute (CAMPAIGN_FIELD_CATALOG),
 *             edited as a draft and applied together — a half-typed value
 *             never fires a query
 *
 * Unsupported filters fail closed server-side (422 names the field); the
 * grid states that instead of showing an unfiltered list.
 */
import { useEffect, useMemo, useState } from 'react'
import { LCButton, LCChip, LCError, LCSearch, LCSelect, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import {
  completeFieldFilters,
  defaultOperatorFor,
  defaultValueFor,
  describeFieldFilter,
  fetchEntityGraphFilterCatalog,
  findCatalogField,
  operatorIsMultiValue,
  operatorIsRange,
  operatorNeedsValue,
  searchCatalogFields,
  type EntityGraphFieldFilter,
  type EntityGraphFilterCatalog,
  type EntityGraphFilterField,
} from '../../../domain/entity-graph/entity-graph-field-filters'
import { fetchComposition, type Composition } from '../../../domain/entity-graph/entity-graph-intel-api'
import { fieldFiltersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import { PRESETS, presetActive, togglePreset } from '../mobile/entity-graph-presets'
import { tabForScope, type EntityScope } from '../mobile/entity-graph-mobile-format'
import { DESK_DISTRESS_FACETS, DESK_DISTRESS_TOGGLES, DESK_FACETS, facetValues, filtersExcept, fmtCount, toggleFacetValue, type DeskFacet as Facet } from './desk-model'

type Props = {
  scope: EntityScope
  filters: EntityGraphFieldFilter[]
  onChange: (next: EntityGraphFieldFilter[]) => void
}

export function DeskFilterRail({ scope, filters, onChange }: Props) {
  const tab = tabForScope(scope)
  const [catalogState, setCatalogState] = useState<{ tab: string; catalog: EntityGraphFilterCatalog | null; failed: boolean } | null>(null)
  const catalog = catalogState?.tab === tab ? catalogState.catalog : null
  const catalogLoading = catalogState?.tab !== tab
  useEffect(() => {
    const ctl = new AbortController()
    void fetchEntityGraphFilterCatalog(tab, ctl.signal)
      .then((c) => { if (!ctl.signal.aborted) setCatalogState({ tab, catalog: c, failed: !c }) })
      .catch(() => { if (!ctl.signal.aborted) setCatalogState({ tab, catalog: null, failed: true }) })
    return () => ctl.abort()
  }, [tab])

  const facets = useMemo(() => DESK_FACETS[scope] ?? [], [scope])
  const distress = scope === 'properties'
  const facetKeys = useMemo(() => new Set([...facets, ...(distress ? DESK_DISTRESS_FACETS : [])].map((f) => f.fieldKey)), [facets, distress])
  const sameFilter = (a: EntityGraphFieldFilter, b: EntityGraphFieldFilter) => a.field_key === b.field_key && a.operator === b.operator && JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
  const isToggle = (f: EntityGraphFieldFilter) => distress && DESK_DISTRESS_TOGGLES.some((t) => sameFilter(t.filter, f))
  const presets = PRESETS[scope] ?? []
  const isPreset = (f: EntityGraphFieldFilter) => presets.some((g) => g.presets.some((p) => p.filter.field_key === f.field_key && p.filter.operator === f.operator && JSON.stringify(p.filter.value ?? null) === JSON.stringify(f.value ?? null)))
  const isFacet = (f: EntityGraphFieldFilter) => facetKeys.has(f.field_key) && f.operator === 'is_any_of'
  const custom = filters.filter((f) => !isPreset(f) && !isFacet(f) && !isToggle(f))

  // Field drafts: edited locally, applied together.
  const [draft, setDraft] = useState<{ base: string; rows: EntityGraphFieldFilter[] } | null>(null)
  const customSig = JSON.stringify(custom)
  const rows = draft && draft.base === customSig ? draft.rows : custom
  const dirty = Boolean(draft && draft.base === customSig && JSON.stringify(completeFieldFilters(draft.rows)) !== customSig)
  const setRows = (next: EntityGraphFieldFilter[]) => setDraft({ base: customSig, rows: next })
  const apply = () => {
    onChange([...filters.filter((f) => isPreset(f) || isFacet(f) || isToggle(f)), ...completeFieldFilters(rows)])
    setDraft(null)
  }

  const [fieldQuery, setFieldQuery] = useState('')
  const matches = useMemo(() => (fieldQuery.trim() ? searchCatalogFields(catalog, fieldQuery).slice(0, 40) : []), [catalog, fieldQuery])
  const addField = (field: EntityGraphFilterField) => {
    const operator = defaultOperatorFor(field)
    setRows([...rows, { field_key: field.key, operator, value: defaultValueFor(field, operator) }])
    setFieldQuery('')
  }

  const label = (f: EntityGraphFieldFilter) => {
    const field = findCatalogField(catalog, f.field_key)
    if (isFacet(f)) {
      const facet = [...facets, ...DESK_DISTRESS_FACETS].find((x) => x.fieldKey === f.field_key)
      const vals = Array.isArray(f.value) ? f.value.map(String) : []
      return `${facet?.label ?? field?.label ?? f.field_key}: ${vals.length > 2 ? `${vals.slice(0, 2).join(', ')} +${vals.length - 2}` : vals.join(', ')}`
    }
    return describeFieldFilter(f, field)
  }

  return (
    <aside className="egdk-rail lc-scroll" aria-label="Filters">
      <header className="egdk-rail__head">
        <span className="egdk-rail__title">Filters</span>
        {filters.length ? <button type="button" className="egdk-link" onClick={() => { onChange([]); setDraft(null) }}>Clear all</button> : <span className="egdk-rail__hint">none</span>}
      </header>

      {filters.length ? (
        <div className="egdk-rail__active">
          {filters.map((f, i) => (
            <LCChip key={`${f.field_key}:${i}`} value={label(f)} onRemove={() => onChange(filters.filter((_, j) => j !== i))} />
          ))}
        </div>
      ) : null}

      {distress ? (
        <section className="egdk-rail__sec" aria-label="Distress and condition">
          <span className="egdk-rail__label">Distress & condition</span>
          {DESK_DISTRESS_FACETS.map((facet) => (
            <FacetSection key={`distress:${facet.dimension}`} tab={tab} facet={facet} filters={filters} onChange={onChange} />
          ))}
          <div className="egdk-presets__chips egdk-distress__toggles">
            {DESK_DISTRESS_TOGGLES.map((t) => {
              const on = filters.some((f) => sameFilter(f, t.filter))
              return (
                <button key={t.key} type="button" aria-pressed={on} className={cx('egdk-preset', on && 'is-on')} onClick={() => onChange(on ? filters.filter((f) => !sameFilter(f, t.filter)) : [...filters.filter((f) => f.field_key !== t.filter.field_key), t.filter])}>
                  {on ? <Icon name="check" size={11} /> : null}{t.label}
                </button>
              )
            })}
          </div>
          <p className="egdk-facet__foot">Any of within a list · all lists together</p>
        </section>
      ) : null}

      {facets.length ? (
        <section className="egdk-rail__sec">
          <span className="egdk-rail__label">Facets</span>
          {facets.map((facet) => (
            <FacetSection key={`${scope}:${facet.dimension}`} tab={tab} facet={facet} filters={filters} onChange={onChange} />
          ))}
        </section>
      ) : null}

      {presets.length ? (
        <section className="egdk-rail__sec">
          <span className="egdk-rail__label">Quick filters</span>
          {presets.map((group) => (
            <div key={group.label} className="egdk-presets">
              <span className="egdk-presets__group">{group.label}</span>
              <div className="egdk-presets__chips">
                {group.presets.map((p) => {
                  const on = presetActive(filters, p)
                  return (
                    <button key={p.key} type="button" aria-pressed={on} className={cx('egdk-preset', on && 'is-on', p.tone && `is-${p.tone}`)} onClick={() => onChange(togglePreset(filters, p))}>
                      {on ? <Icon name="check" size={11} /> : null}{p.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="egdk-rail__sec">
        <span className="egdk-rail__label">Fields{catalog ? ` · ${catalog.total_fields}` : ''}</span>
        {catalogLoading ? <LCSkeleton shape="lines" count={3} label="Loading the field catalog" /> : !catalog ? (
          <p className="egdk-none">This scope has no field filters — its rows are an aggregate.</p>
        ) : (
          <>
            <LCSearch value={fieldQuery} onChange={setFieldQuery} label="Find a field" placeholder={`Find a field · ${catalog.total_fields} on ${catalog.source}`} className="egdk-rail__find" />
            {matches.length ? (
              <ul className="egdk-fields" role="listbox" aria-label="Matching fields">
                {matches.map((field) => (
                  <li key={field.key}>
                    <button type="button" className="egdk-field" onClick={() => addField(field)}>
                      <span>{field.label}</span>
                      <small>{field.category}{field.data_coverage === 'empty' ? ' · holds no data' : ''}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : fieldQuery.trim() ? <p className="egdk-none">No field matches “{fieldQuery.trim()}”.</p> : null}
            {rows.length ? (
              <ul className="egdk-edits">
                {rows.map((row, i) => (
                  <FieldEditor
                    key={`${row.field_key}:${i}`}
                    field={findCatalogField(catalog, row.field_key)}
                    filter={row}
                    onChange={(next) => setRows(rows.map((r, j) => (j === i ? next : r)))}
                    onRemove={() => setRows(rows.filter((_, j) => j !== i))}
                  />
                ))}
              </ul>
            ) : null}
            {dirty ? (
              <div className="egdk-rail__apply">
                <LCButton size="sm" variant="primary" onClick={apply}>Apply {completeFieldFilters(rows).length} field {completeFieldFilters(rows).length === 1 ? 'filter' : 'filters'}</LCButton>
                <LCButton size="sm" variant="quiet" onClick={() => setDraft(null)}>Discard</LCButton>
              </div>
            ) : null}
          </>
        )}
      </section>
    </aside>
  )
}

function FieldEditor({ field, filter, onChange, onRemove }: { field: EntityGraphFilterField | null; filter: EntityGraphFieldFilter; onChange: (f: EntityGraphFieldFilter) => void; onRemove: () => void }) {
  if (!field) {
    return (
      <li className="egdk-edit is-unknown">
        <span>{filter.field_key} is not filterable on this scope</span>
        <button type="button" className="egdk-link" onClick={onRemove}>Remove</button>
      </li>
    )
  }
  const op = filter.operator
  const inputType = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'
  return (
    <li className="egdk-edit">
      <div className="egdk-edit__head">
        <strong>{field.label}</strong>
        <button type="button" className="egdk-edit__x" aria-label={`Remove ${field.label}`} onClick={onRemove}><Icon name="x" size={11} /></button>
      </div>
      <LCSelect
        size="sm"
        label={`${field.label} operator`}
        value={op}
        options={field.operators.map((o) => ({ value: o.key, label: o.label }))}
        onChange={(next) => onChange({ ...filter, operator: next, value: defaultValueFor(field, next) })}
      />
      {!operatorNeedsValue(op) ? null : operatorIsRange(op) ? (
        <div className="egdk-edit__range">
          <input className="egdk-input" type={inputType} placeholder="From" value={String((Array.isArray(filter.value) ? filter.value[0] : '') ?? '')} onChange={(e) => onChange({ ...filter, value: [e.target.value, Array.isArray(filter.value) ? filter.value[1] ?? '' : ''] })} />
          <span aria-hidden="true">–</span>
          <input className="egdk-input" type={inputType} placeholder="To" value={String((Array.isArray(filter.value) ? filter.value[1] : '') ?? '')} onChange={(e) => onChange({ ...filter, value: [Array.isArray(filter.value) ? filter.value[0] ?? '' : '', e.target.value] })} />
        </div>
      ) : operatorIsMultiValue(op) ? (
        <input className="egdk-input" type="text" placeholder="Value, value, value" value={(Array.isArray(filter.value) ? filter.value : []).map(String).join(', ')} onChange={(e) => onChange({ ...filter, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
      ) : (
        <input className="egdk-input" type={inputType} placeholder={field.label} value={String(filter.value ?? '')} onChange={(e) => onChange({ ...filter, value: e.target.value })} />
      )}
      {field.data_coverage === 'empty' ? <p className="egdk-edit__warn">This column holds no data ({field.data_coverage_note}) — it can only return 0 records.</p> : null}
    </li>
  )
}

function FacetSection({ tab, facet, filters, onChange }: { tab: string; facet: Facet; filters: EntityGraphFieldFilter[]; onChange: (f: EntityGraphFieldFilter[]) => void }) {
  const selected = facetValues(filters, facet.fieldKey)
  const [open, setOpen] = useState(selected.length > 0)
  const [find, setFind] = useState('')
  const [attempt, setAttempt] = useState(0)
  const others = filtersExcept(filters, facet.fieldKey)
  const sig = `${tab}|${facet.dimension}|${JSON.stringify(others)}|${attempt}`
  const [state, setState] = useState<{ sig: string; data: Composition | null; failed: boolean } | null>(null)
  const current = state?.sig === sig ? state : null

  useEffect(() => {
    if (!open) return
    const ctl = new AbortController()
    void fetchComposition({ tab, dimension: facet.dimension, all: '1', ...fieldFiltersToApiParams(others) }, ctl.signal)
      .then((data) => { if (!ctl.signal.aborted) setState({ sig, data, failed: !data }) })
      .catch(() => { if (!ctl.signal.aborted) setState({ sig, data: null, failed: true }) })
    return () => ctl.abort()
    // `sig` encodes tab, dimension, the other filters and the retry attempt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sig])

  const buckets = current?.data?.buckets ?? []
  const valued = buckets.filter((b) => !b.key.startsWith('__'))
  const blank = buckets.find((b) => b.key === '__blank')
  const other = buckets.find((b) => b.key === '__other')
  const q = find.trim().toLowerCase()
  const shown = q ? valued.filter((b) => b.label.toLowerCase().includes(q)) : valued
  const max = Math.max(1, ...valued.map((b) => b.value ?? 0))
  const exhaustive = (current?.data as (Composition & { exhaustive?: boolean }) | null)?.exhaustive !== false

  return (
    <div className={cx('egdk-facet', open && 'is-open')}>
      <button type="button" className="egdk-facet__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{facet.label}</span>
        {selected.length ? <span className="egdk-facet__count">{selected.length}</span> : null}
        {open && current?.data ? <small>{valued.length} values</small> : null}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
      </button>
      {open ? (
        <div className="egdk-facet__body">
          {!current ? <LCSkeleton shape="lines" count={4} label={`Counting ${facet.label.toLowerCase()}`} /> : current.failed ? (
            <LCError what={`${facet.label} counts didn’t load`} onRetry={() => setAttempt((a) => a + 1)} compact />
          ) : (
            <>
              {valued.length > 8 ? (
                <label className="egdk-facet__find">
                  <Icon name="search" size={12} />
                  <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder={`Find ${facet.label.toLowerCase()} · ${valued.length}`} aria-label={`Find a ${facet.label.toLowerCase()}`} autoComplete="off" spellCheck={false} />
                </label>
              ) : null}
              <ul className="egdk-facet__list" role="listbox" aria-multiselectable="true" aria-label={facet.label}>
                {shown.map((b) => {
                  const on = selected.includes(b.key)
                  return (
                    <li key={b.key}>
                      <button type="button" role="option" aria-selected={on} className={cx('egdk-bucket', on && 'is-on')} onClick={() => onChange(toggleFacetValue(filters, facet.fieldKey, b.key))} style={{ ['--w' as string]: `${Math.max(1, ((b.value ?? 0) / max) * 100)}%` }}>
                        <span className="egdk-bucket__check" aria-hidden="true">{on ? <Icon name="check" size={10} /> : null}</span>
                        <span className="egdk-bucket__label">{b.label}</span>
                        <span className="egdk-bucket__n">{fmtCount(b.value)}</span>
                        <span className="egdk-bucket__bar" aria-hidden="true" />
                      </button>
                    </li>
                  )
                })}
                {q && shown.length === 0 ? <li className="egdk-none">No {facet.label.toLowerCase()} matches “{find.trim()}”.</li> : null}
              </ul>
              {blank && !q ? <p className="egdk-facet__foot">Not recorded · {fmtCount(blank.value)}</p> : null}
              {!exhaustive ? <p className="egdk-facet__foot">{other ? `Sampled list · ${fmtCount(other.value)} in values not shown` : 'Sampled list — may be incomplete'}</p> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
