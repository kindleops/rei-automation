/**
 * THE FILTER RAIL — the campaign field catalog, laid out for a desk, in
 * collapsible groups (owner 2026-10-08: "collapsible, organized into clear
 * groups, much more premium").
 *
 *   header      Filters · N active · Clear all · collapse to a slim strip
 *   Active      every filter on the cohort, removable
 *   Quick       one-tap presets (ordinary catalog filters)
 *   Facet groups  per scope (Distress & condition, Location, Asset … for
 *               properties; Owner matching, Demographics, Financial, Contact
 *               for people; Owner profile; Phone line): EVERY value with its
 *               exact count from one grouped query, counted without the
 *               facet's own selection so other values stay pickable
 *   All fields  every field the tab's query can execute — searchable, or
 *               browsed by catalog category — edited as a draft and applied
 *               together (a half-typed value never fires a query)
 *
 * Group open/closed is remembered per operator. Unsupported filters fail
 * closed server-side (422 names the field); the grid states that instead of
 * showing an unfiltered list.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { LCButton, LCChip, LCError, LCSearch, LCSegmented, LCSelect, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { useAuth } from '../../../components/auth/AuthProvider'
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
import { presetActive, togglePreset } from '../mobile/entity-graph-presets'
import { tabForScope, type EntityScope } from '../mobile/entity-graph-mobile-format'
import {
  DESK_FACET_GROUPS,
  deskFacetFields,
  deskPresets,
  deskToggles,
  FACET_OPERATORS,
  facetCountFilters,
  facetMatch,
  facetValues,
  fmtCount,
  readRailGroups,
  setFacetMatch,
  toggleFacetValue,
  writeRailGroups,
  type DeskFacet as Facet,
  type FacetMatch,
} from './desk-model'

type Props = {
  scope: EntityScope
  filters: EntityGraphFieldFilter[]
  onChange: (next: EntityGraphFieldFilter[]) => void
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

const sameFilter = (a: EntityGraphFieldFilter, b: EntityGraphFieldFilter) => a.field_key === b.field_key && a.operator === b.operator && JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)

export function DeskFilterRail({ scope, filters, onChange, collapsed = false, onCollapsedChange }: Props) {
  const uid = useAuth().user?.id || 'local'
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

  const groups = useMemo(() => DESK_FACET_GROUPS[scope] ?? [], [scope])
  const facets = useMemo(() => deskFacetFields(scope), [scope])
  const toggles = useMemo(() => deskToggles(scope), [scope])
  const presets = useMemo(() => deskPresets(scope), [scope])
  const facetKeys = useMemo(() => new Set(facets.map((f) => f.fieldKey)), [facets])
  const isToggle = (f: EntityGraphFieldFilter) => toggles.some((t) => sameFilter(t.filter, f))
  const isPreset = (f: EntityGraphFieldFilter) => presets.some((g) => g.presets.some((p) => sameFilter(p.filter, f)))
  const isFacet = (f: EntityGraphFieldFilter) => facetKeys.has(f.field_key) && FACET_OPERATORS.has(f.operator)
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
    setOpenState((cur) => ({ ...cur, [`${scope}:fields`]: true }))
  }

  const label = (f: EntityGraphFieldFilter) => {
    const field = findCatalogField(catalog, f.field_key)
    if (isFacet(f)) {
      const facet = facets.find((x) => x.fieldKey === f.field_key)
      const vals = Array.isArray(f.value) ? f.value.map(String) : []
      // a stacking facet says how its values combine: "all of" narrows, "any of" widens
      const how = facet?.match && vals.length > 1 ? (f.operator === 'is_all_of' ? ' all of' : ' any of') : ''
      return `${facet?.label ?? field?.label ?? f.field_key}${how}: ${vals.length > 2 ? `${vals.slice(0, 2).join(', ')} +${vals.length - 2}` : vals.join(', ')}`
    }
    const preset = presets.flatMap((g) => g.presets).find((p) => sameFilter(p.filter, f))
    if (preset) return preset.label
    const toggle = toggles.find((t) => sameFilter(t.filter, f))
    if (toggle) return toggle.label
    return describeFieldFilter(f, field)
  }

  /* group open/closed, remembered */
  const [openState, setOpenState] = useState<Record<string, boolean>>(() => readRailGroups(uid))
  useEffect(() => { writeRailGroups(uid, openState) }, [uid, openState])
  const groupActive = (keys: Set<string>) => filters.filter((f) => keys.has(f.field_key)).length
  const isOpen = (id: string, fallback: boolean) => openState[`${scope}:${id}`] ?? fallback
  const toggleGroup = (id: string, fallback: boolean) => setOpenState((cur) => ({ ...cur, [`${scope}:${id}`]: !(cur[`${scope}:${id}`] ?? fallback) }))

  if (collapsed) {
    return (
      <aside className="egdk-rail is-collapsed" aria-label="Filters (collapsed)">
        <button type="button" className="egdk-rail__strip" onClick={() => onCollapsedChange?.(false)} title="Show filters">
          <Icon name="filter" size={15} />
          {filters.length ? <span className="egdk-rail__strip-count">{filters.length}</span> : null}
          <span className="egdk-rail__strip-label">Filters</span>
        </button>
      </aside>
    )
  }

  const presetKeys = new Set(presets.flatMap((g) => g.presets.map((p) => p.filter.field_key)))
  return (
    <aside className="egdk-rail lc-scroll" aria-label="Filters">
      <header className="egdk-rail__head">
        <div className="egdk-rail__headline">
          <span className="egdk-rail__title">Filters</span>
          <span className="egdk-rail__hint">{filters.length ? `${filters.length} active` : 'None applied'}</span>
        </div>
        <div className="egdk-rail__headtools">
          {filters.length ? <button type="button" className="egdk-link" onClick={() => { onChange([]); setDraft(null) }}>Clear all</button> : null}
          {onCollapsedChange ? (
            <button type="button" className="egdk-rail__collapse" aria-label="Collapse filters" title="Collapse filters" onClick={() => onCollapsedChange(true)}>
              <Icon name="chevron-left" size={14} />
            </button>
          ) : null}
        </div>
      </header>

      {filters.length ? (
        <div className="egdk-rail__active" aria-label="Active filters">
          {filters.map((f, i) => (
            <LCChip key={`${f.field_key}:${i}`} value={label(f)} onRemove={() => onChange(filters.filter((_, j) => j !== i))} />
          ))}
        </div>
      ) : null}

      {presets.length ? (
        <RailGroup id="quick" title="Quick filters" icon="spark" open={isOpen('quick', true)} count={groupActive(presetKeys)} onToggle={() => toggleGroup('quick', true)}>
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
        </RailGroup>
      ) : null}

      {groups.map((group, gi) => {
        const keys = new Set([...group.facets.map((f) => f.fieldKey), ...(group.toggles ?? []).map((t) => t.filter.field_key)])
        const fallback = gi === 0
        return (
          <RailGroup key={group.id} id={group.id} title={group.label} open={isOpen(group.id, fallback)} count={groupActive(keys)} onToggle={() => toggleGroup(group.id, fallback)}>
            {group.facets.map((facet) => (
              <FacetSection key={`${scope}:${facet.dimension}`} tab={tab} facet={facet} filters={filters} onChange={onChange} />
            ))}
            {group.toggles?.length ? (
              <div className="egdk-presets__chips egdk-distress__toggles">
                {group.toggles.map((t) => {
                  const on = filters.some((f) => sameFilter(f, t.filter))
                  return (
                    <button key={t.key} type="button" aria-pressed={on} className={cx('egdk-preset', on && 'is-on')} onClick={() => onChange(on ? filters.filter((f) => !sameFilter(f, t.filter)) : [...filters.filter((f) => f.field_key !== t.filter.field_key), t.filter])}>
                      {on ? <Icon name="check" size={11} /> : null}{t.label}
                    </button>
                  )
                })}
              </div>
            ) : null}
            {group.facets.length > 1 || group.toggles?.length ? <p className="egdk-facet__foot">{group.facets.some((f) => f.match) ? 'Flags: all or any, as set · other lists any of · all lists together' : 'Any of within a list · all lists together'}</p> : null}
          </RailGroup>
        )
      })}

      <RailGroup
        id="fields"
        title="All fields"
        icon="list"
        open={isOpen('fields', !groups.length && !presets.length) || rows.length > 0}
        count={custom.length}
        aside={catalog ? <small>{catalog.total_fields}</small> : null}
        onToggle={() => toggleGroup('fields', !groups.length && !presets.length)}
      >
        {catalogLoading ? <LCSkeleton shape="lines" count={3} label="Loading the field catalog" /> : !catalog ? (
          <p className="egdk-none">{scope === 'organizations' ? 'Companies have no field filters — the title-entity list has no catalogued fields. Filter Owners or Properties, or search by name.' : 'This scope has no field filters.'}</p>
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
            ) : fieldQuery.trim() ? <p className="egdk-none">No field matches “{fieldQuery.trim()}”.</p> : (
              <CategoryBrowser catalog={catalog} onPick={addField} />
            )}
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
      </RailGroup>
    </aside>
  )
}

function RailGroup({ id, title, icon, open, count, aside, onToggle, children }: { id: string; title: string; icon?: string; open: boolean; count: number; aside?: ReactNode; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={cx('egdk-rgroup', open && 'is-open', count > 0 && 'is-active')} data-group={id}>
      <button type="button" className="egdk-rgroup__head" aria-expanded={open} onClick={onToggle}>
        {icon ? <Icon name={icon as never} size={12} className="egdk-rgroup__icon" /> : <span className="egdk-rgroup__dot" aria-hidden="true" />}
        <span className="egdk-rgroup__title">{title}</span>
        {count > 0 ? <span className="egdk-rgroup__count">{count}</span> : null}
        {aside}
        <Icon name="chevron-down" size={12} className="egdk-rgroup__chev" />
      </button>
      {open ? <div className="egdk-rgroup__body">{children}</div> : null}
    </section>
  )
}

function CategoryBrowser({ catalog, onPick }: { catalog: EntityGraphFilterCatalog; onPick: (field: EntityGraphFilterField) => void }) {
  const [openCat, setOpenCat] = useState<string | null>(null)
  return (
    <ul className="egdk-cats" aria-label="Fields by category">
      {catalog.groups.map((g) => (
        <li key={g.id} className={cx('egdk-cat', openCat === g.id && 'is-open')}>
          <button type="button" className="egdk-cat__head" aria-expanded={openCat === g.id} onClick={() => setOpenCat((c) => (c === g.id ? null : g.id))}>
            <span>{g.label}</span>
            <small>{g.fields.length}</small>
            <Icon name="chevron-down" size={11} />
          </button>
          {openCat === g.id ? (
            <ul className="egdk-fields">
              {g.fields.map((field) => (
                <li key={field.key}>
                  <button type="button" className="egdk-field" onClick={() => onPick(field)} title={field.description ?? field.caution ?? undefined}>
                    <span>{field.label}</span>
                    <small>{field.type === 'flags' ? 'list · whole tokens' : field.type}{field.data_coverage === 'empty' ? ' · holds no data' : ''}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
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
      {field.description ? <p className="egdk-edit__note">{field.description}</p> : null}
      {field.caution ? <p className="egdk-edit__warn">{field.caution}</p> : null}
      {field.data_coverage === 'empty' ? <p className="egdk-edit__warn">This column holds no data ({field.data_coverage_note}) — it can only return 0 records.</p> : null}
    </li>
  )
}

function FacetSection({ tab, facet, filters, onChange }: { tab: string; facet: Facet; filters: EntityGraphFieldFilter[]; onChange: (f: EntityGraphFieldFilter[]) => void }) {
  const selected = facetValues(filters, facet.fieldKey)
  // the mode chosen before any value is picked is remembered here; an active filter's operator wins
  const [chosenMatch, setChosenMatch] = useState<FacetMatch>(facet.match ?? 'any')
  const match: FacetMatch = facet.match ? facetMatch(filters, facet.fieldKey, chosenMatch) : 'any'
  const [open, setOpen] = useState(selected.length > 0)
  const [find, setFind] = useState('')
  const [attempt, setAttempt] = useState(0)
  // "all of": counts include the selection (each = the cohort if that value is added)
  const others = facetCountFilters(filters, facet.fieldKey, match)
  const sig = `${tab}|${facet.dimension}|${JSON.stringify(others)}|${attempt}`
  const [state, setState] = useState<{ sig: string; data: Composition | null; failed: boolean } | null>(null)
  const current = state?.sig === sig ? state : null
  // a facet that gains a selection from elsewhere (a preset, a saved view) opens
  const [seenSel, setSeenSel] = useState(selected.length)
  if (seenSel !== selected.length) {
    setSeenSel(selected.length)
    if (selected.length > 0 && !open) setOpen(true)
  }

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
          {facet.match ? (
            <LCSegmented label={`${facet.label}: match`} size="sm" value={match} onChange={(m) => { setChosenMatch(m); if (selected.length) onChange(setFacetMatch(filters, facet.fieldKey, m)) }}
              options={[{ value: 'all', label: 'Match all' }, { value: 'any', label: 'Match any' }]} />
          ) : null}
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
                      <button type="button" role="option" aria-selected={on} className={cx('egdk-bucket', on && 'is-on')} onClick={() => onChange(toggleFacetValue(filters, facet.fieldKey, b.key, match))} style={{ ['--w' as string]: `${Math.max(1, ((b.value ?? 0) / max) * 100)}%` }}>
                        <span className="egdk-bucket__check" aria-hidden="true">{on ? <Icon name="check" size={10} /> : null}</span>
                        <span className="egdk-bucket__label">{b.label}</span>
                        <span className="egdk-bucket__n">{fmtCount(b.value)}</span>
                        <span className="egdk-bucket__bar" aria-hidden="true" />
                      </button>
                    </li>
                  )
                })}
                {q && shown.length === 0 ? <li className="egdk-none">No {facet.label.toLowerCase()} matches “{find.trim()}”.</li> : null}
                {!q && valued.length === 0 ? <li className="egdk-none">No values in this cohort.</li> : null}
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
