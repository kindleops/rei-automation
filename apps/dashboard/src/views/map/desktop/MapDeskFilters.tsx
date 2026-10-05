/**
 * FILTERS — the desk's intelligence inspector (not a modal).
 *
 * Docks LEFT inside the Map pane, beside the tool rail; the map stays live and
 * the property card can stay open on the right. It works the same filter engine
 * the phone sheet does:
 *
 *   MATCHING NOW   the existing count API (/map/filters/preview): properties,
 *                  owners and phones matching the draft, as a share of the live
 *                  property universe when that count is known — never of a
 *                  hard-coded baseline.
 *   by market      the map's own filtered market aggregates (/ops/map, national),
 *                  read once the cohort is on the map (Preview or Apply).
 *   Preview        puts the cohort on the map with the inspector still open.
 *   Apply          keeps it and collapses the inspector to a capsule.
 *   Close          without applying: the map returns to what was applied.
 *
 * Nothing here writes business data: no saved views are created from the Map
 * (the phone sheet's "Save View" is not offered on the desk). Showing a cohort
 * on the map uses the existing filter token, as the phone's Apply always has.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clearAllAdvancedFilters, DEFAULT_ADVANCED_FILTERS } from '../../../domain/inbox/inbox-advanced-filter-engine'
import {
  buildCatalogFilterChips,
  countActiveCatalogFilters,
  resolveCatalogRangeKeys,
  serializeInboxFiltersForMap,
} from '../../../domain/inbox/inbox-filter-catalog-runtime'
import {
  fetchInboxFilterCatalog,
  fetchInboxSavedViews,
  type FilterCatalogField,
  type FilterCatalogGroup,
  type FilterOption,
  type SavedInboxView,
} from '../../../domain/inbox/inbox-filter-api'
import { INBOX_FILTER_CATALOG, INBOX_FILTER_FIELD_COUNT } from '../../../domain/inbox/inbox-filter-catalog-client'
import { normalizeCatalogSelectValue } from '../../../domain/inbox/catalog-select-value'
import type { InboxAdvancedFilters } from '../../../modules/inbox/inbox-ui-helpers'
import type { MapStatusValue } from '../../../domain/map/inbox-to-map-filter-expression'
import { isMapExcludedFilterGroup, isMapExcludedFilterKey, stripMapExcludedFilters } from '../../../domain/map/map-filter-field-exclusions'
import { mergeMapFilterDraft, type MapAppliedFilterDraft } from '../../../domain/map/map-filter-draft'
import { fetchMapProperties } from '../../../lib/api/backendClient'
import { Icon } from '../../../shared/icons'
import { createMapFilterToken, fetchMapFilterOptions, previewMapFilter } from '../master-filters/api'
import { usePropertyUniverseCount } from '../master-filters/usePropertyUniverseCount'
import { FlagPicker, MultiSelectField } from '../components/MapAdvancedFiltersModal'
import { useMapOverlayTarget } from '../map-overlay-host'
import { fmtCount, shareOfUniverse, topMarkets, type MarketShare } from './map-desk-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const num = (v: unknown) => (v === undefined || v === null ? '' : String(v))
const asNum = (v: string): number | undefined => { const n = Number(v); return v.trim() && Number.isFinite(n) ? n : undefined }

type FlagMode = 'any' | 'all' | 'exclude'
const FLAG_KEYS: Record<'property' | 'person', Record<FlagMode, keyof InboxAdvancedFilters>> = {
  property: { any: 'propertyFlagsAny', all: 'propertyFlagsAll', exclude: 'propertyFlagsExclude' } as Record<FlagMode, keyof InboxAdvancedFilters>,
  person: { any: 'personFlagsAny', all: 'personFlagsAll', exclude: 'personFlagsExclude' } as Record<FlagMode, keyof InboxAdvancedFilters>,
}

const mapGroups = (g: FilterCatalogGroup[]) => g.filter((x) => !isMapExcludedFilterGroup(x.id))
const mapFields = (f: FilterCatalogField[]) => f.filter((x) => !isMapExcludedFilterKey(x.key))

/** owners / phones are null when the server could not compute them — shown as "—", never 0. */
type Counts = { properties: number; owners: number | null; phones: number | null }
type CountState = { status: 'idle' | 'loading' | 'ready' | 'error'; counts: Counts | null; error: string | null }
type MarketState = { status: 'idle' | 'loading' | 'ready' | 'error'; rows: MarketShare[]; total: number; markets: number; key: string | null }

/** Server error codes → one honest sentence. */
function countError(code: string | null | undefined): string {
  const c = String(code || '').toLowerCase()
  if (c.includes('database_url_missing')) return 'The filter count service has no database connection here'
  if (c.includes('system_control_disabled')) return 'Live dashboard reads are switched off'
  if (c.includes('timeout')) return 'The count took too long and was stopped'
  if (c.includes('abort')) return 'Count cancelled'
  return `The filter count service didn’t answer${c ? ` (${c})` : ''}`
}

export interface MapDeskFiltersProps {
  open: boolean
  initialDraft: MapAppliedFilterDraft | null
  /** What is applied on the map right now (for the header, and its by-market split). */
  appliedToken: string | null
  appliedRules: number
  appliedMatching: number | null
  /** A cohort is on the map but not applied yet. */
  previewing: boolean
  onClose: () => void
  onPreview: (token: string, rules: number, matching: number | null) => void
  onApply: (payload: { token: string | null; activeRuleCount: number; matchingProperties: number | null; draft: MapAppliedFilterDraft }) => void
  onClear: () => void
}

export function MapDeskFilters({ open, initialDraft, appliedToken, appliedRules, appliedMatching, previewing, onClose, onPreview, onApply, onClear }: MapDeskFiltersProps) {
  const host = useMapOverlayTarget()
  const [groups, setGroups] = useState<FilterCatalogGroup[]>(() => mapGroups(INBOX_FILTER_CATALOG.groups))
  const [fields, setFields] = useState<FilterCatalogField[]>(() => mapFields(INBOX_FILTER_CATALOG.fields))
  const [local, setLocal] = useState<InboxAdvancedFilters>(DEFAULT_ADVANCED_FILTERS)
  const [mapStatus, setMapStatus] = useState<MapStatusValue>('all')
  const [query, setQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const [flagModes, setFlagModes] = useState<{ property: FlagMode; person: FlagMode }>({ property: 'any', person: 'any' })
  const [savedViews, setSavedViews] = useState<SavedInboxView[]>([])
  const [count, setCount] = useState<CountState>({ status: 'idle', counts: null, error: null })
  const [markets, setMarkets] = useState<MarketState>({ status: 'idle', rows: [], total: 0, markets: 0, key: null })
  const [working, setWorking] = useState<'idle' | 'previewing' | 'applying'>('idle')
  const [actionError, setActionError] = useState<string | null>(null)
  const [previewedKey, setPreviewedKey] = useState<string | null>(null)
  const previewedTokenRef = useRef<{ key: string; token: string } | null>(null)
  const optionsCache = useRef<Record<string, FilterOption[]>>({})
  const optionsInflight = useRef<Record<string, Promise<FilterOption[]>>>({})
  const [optionsVersion, setOptionsVersion] = useState(0)
  const universe = usePropertyUniverseCount()
  const initialRef = useRef(initialDraft)
  initialRef.current = initialDraft
  const appliedTokenRef = useRef(appliedToken)
  appliedTokenRef.current = appliedToken

  // ── by market: the map's own filtered market aggregates (one GET), once the cohort is on the map ──
  const marketSeq = useRef(0)
  const loadMarkets = useCallback((token: string, key: string) => {
    const id = ++marketSeq.current
    setMarkets({ status: 'loading', rows: [], total: 0, markets: 0, key })
    void fetchMapProperties({ lat_min: -90, lat_max: 90, lng_min: -180, lng_max: 180, zoom: 4, filter: token })
      .then((res) => {
        if (id !== marketSeq.current) return
        if (!res.ok || !res.data?.data?.features) { setMarkets({ status: 'error', rows: [], total: 0, markets: 0, key }); return }
        setMarkets({ status: 'ready', ...topMarkets(res.data.data.features, 5), key })
      })
      .catch(() => { if (id === marketSeq.current) setMarkets({ status: 'error', rows: [], total: 0, markets: 0, key }) })
  }, [])

  // ── open: restore the applied draft; the catalog + saved views are reads ──
  useEffect(() => {
    if (!open) return
    const draft = initialRef.current
    const restored = mergeMapFilterDraft(draft?.filters)
    setLocal(restored)
    setMapStatus(draft?.mapStatus ?? 'all')
    setQuery('')
    setActionError(null)
    setWorking('idle')
    setPreviewedKey(null)
    previewedTokenRef.current = null
    marketSeq.current += 1
    setMarkets({ status: 'idle', rows: [], total: 0, markets: 0, key: null })
    // An applied cohort is already on the map: it needs no new token to show, and
    // its by-market split is read once, now.
    const restoredStatus = draft?.mapStatus ?? 'all'
    const restoredActive = countActiveCatalogFilters(restored) + (restoredStatus !== 'all' ? 1 : 0) > 0
    if (restoredActive && appliedTokenRef.current) {
      const key = JSON.stringify({ inboxFilters: stripMapExcludedFilters(serializeInboxFiltersForMap(restored)), mapStatus: restoredStatus })
      previewedTokenRef.current = { key, token: appliedTokenRef.current }
      setPreviewedKey(key)
      loadMarkets(appliedTokenRef.current, key)
    }
    optionsCache.current = {}
    optionsInflight.current = {}
    setOptionsVersion((v) => v + 1)
    // Groups that already hold a filter open by default; the rest stay folded —
    // an open group reads its option lists, so nothing is read until asked for.
    const active = new Set(buildCatalogFilterChips(restored).map((c) => c.key))
    setOpenGroups(new Set(mapFields(INBOX_FILTER_CATALOG.fields).filter((f) => active.has(f.key)).map((f) => f.group)))
    const ac = new AbortController()
    void fetchInboxFilterCatalog(ac.signal).then((cat) => {
      if (ac.signal.aborted) return
      if ((cat?.fields?.length ?? 0) >= INBOX_FILTER_FIELD_COUNT) {
        setGroups(mapGroups(cat.groups ?? INBOX_FILTER_CATALOG.groups))
        setFields(mapFields(cat.fields))
      }
    }).catch(() => { /* the bundled catalog stays */ })
    void fetchInboxSavedViews(ac.signal).then((v) => { if (!ac.signal.aborted) setSavedViews(v.filter((x) => !x.is_system)) }).catch(() => {})
    return () => ac.abort()
  }, [open, loadMarkets])

  // Escape closes (one subscription; the latest onClose through a ref).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const inboxFilters = useMemo(() => stripMapExcludedFilters(serializeInboxFiltersForMap(local)), [local])
  const payload = useMemo(() => ({ inboxFilters, mapStatus }), [inboxFilters, mapStatus])
  const payloadKey = useMemo(() => JSON.stringify(payload), [payload])
  const activeCount = countActiveCatalogFilters(local) + (mapStatus !== 'all' ? 1 : 0)
  const hasActive = activeCount > 0
  const chips = useMemo(() => buildCatalogFilterChips(local), [local])

  // ── MATCHING NOW: the existing count API, debounced; nothing to count = no call ──
  useEffect(() => {
    if (!open) return undefined
    if (!hasActive) { setCount({ status: 'idle', counts: null, error: null }); return undefined }
    const ac = new AbortController()
    setCount((c) => ({ ...c, status: 'loading', error: null }))
    const t = window.setTimeout(() => {
      void previewMapFilter(payload)
        .then((res) => {
          if (ac.signal.aborted) return
          if (!res.ok) { setCount({ status: 'error', counts: null, error: countError(res.error || res.message) }); return }
          const c = res.data.counts
          setCount({ status: 'ready', counts: { properties: c.matchingProperties, owners: c.matchingMasterOwners ?? null, phones: c.matchingPhones ?? null }, error: null })
        })
        .catch(() => { if (!ac.signal.aborted) setCount({ status: 'error', counts: null, error: countError(null) }) })
    }, 420)
    return () => { ac.abort(); window.clearTimeout(t) }
  }, [open, hasActive, payload])

  const tokenFor = useCallback(async (): Promise<string | null> => {
    if (previewedTokenRef.current?.key === payloadKey) return previewedTokenRef.current.token
    const res = await createMapFilterToken(payload)
    if (!res.ok) { setActionError(`Couldn’t put this filter on the map (${res.error || 'token_failed'})`); return null }
    previewedTokenRef.current = { key: payloadKey, token: res.data.filterToken }
    return res.data.filterToken
  }, [payload, payloadKey])

  const matchingNow = count.status === 'ready' ? count.counts?.properties ?? null : null

  const preview = useCallback(async () => {
    if (!hasActive || working !== 'idle') return
    setWorking('previewing')
    setActionError(null)
    try {
      const token = await tokenFor()
      if (!token) return
      onPreview(token, activeCount, matchingNow)
      setPreviewedKey(payloadKey)
      loadMarkets(token, payloadKey)
    } finally {
      setWorking('idle')
    }
  }, [hasActive, working, tokenFor, onPreview, activeCount, matchingNow, payloadKey, loadMarkets])

  const apply = useCallback(async () => {
    if (working !== 'idle') return
    const draft: MapAppliedFilterDraft = { filters: { ...local }, mapStatus }
    if (!hasActive) {
      onApply({ token: null, activeRuleCount: 0, matchingProperties: null, draft })
      onClose()
      return
    }
    setWorking('applying')
    setActionError(null)
    try {
      const token = await tokenFor()
      if (!token) return
      onApply({ token, activeRuleCount: activeCount, matchingProperties: matchingNow, draft })
      onClose()
    } finally {
      setWorking('idle')
    }
  }, [working, local, mapStatus, hasActive, tokenFor, onApply, onClose, activeCount, matchingNow])

  const clearAll = useCallback(() => {
    setLocal(clearAllAdvancedFilters())
    setMapStatus('all')
    setPreviewedKey(null)
    previewedTokenRef.current = null
    setMarkets({ status: 'idle', rows: [], total: 0, markets: 0, key: null })
    setActionError(null)
    onClear()
  }, [onClear])

  const patch = useCallback((p: Partial<InboxAdvancedFilters>) => setLocal((c) => ({ ...c, ...p })), [])

  const loadOptions = useCallback(async (field: FilterCatalogField) => {
    const key = field.optionsKey || field.key
    const cached = optionsCache.current[key]
    if (cached?.length) return cached
    if (key in optionsInflight.current) return optionsInflight.current[key]
    const request = fetchMapFilterOptions(key, { advanced: inboxFilters })
      .then((res) => {
        if (!res.ok) throw new Error(res.message || res.error || 'filter_options_failed')
        optionsCache.current[key] = res.data ?? []
        setOptionsVersion((v) => v + 1)
        return res.data ?? []
      })
      .finally(() => { delete optionsInflight.current[key] })
    optionsInflight.current[key] = request
    return request
  }, [inboxFilters])

  const activeByGroup = useMemo(() => {
    const keys = new Set(chips.map((c) => c.key))
    const out: Record<string, number> = {}
    for (const f of fields) if (keys.has(f.key)) out[f.group] = (out[f.group] ?? 0) + 1
    return out
  }, [chips, fields])

  const q = query.trim().toLowerCase()
  const searchHits = useMemo(() => (q ? fields.filter((f) => f.label.toLowerCase().includes(q) || f.group.toLowerCase().includes(q)) : []), [fields, q])
  const groupLabel = useCallback((id: string) => groups.find((g) => g.id === id)?.label ?? id, [groups])

  if (!open || !host) return null

  const renderField = (field: FilterCatalogField) => {
    const key = field.key as keyof InboxAdvancedFilters
    if (field.type === 'flags') {
      const kind: 'property' | 'person' = field.key === 'propertyFlags' ? 'property' : 'person'
      const mode = flagModes[kind]
      const target = FLAG_KEYS[kind][mode]
      const selected = ((local as Record<string, unknown>)[target as string] as string[] | undefined) ?? []
      return (
        <div key={field.key} className="mxd-field is-flags">
          <span className="mxd-field__label">{field.label}</span>
          <div className="mxd-seg is-sm" role="tablist" aria-label={`${field.label} match`}>
            {(['any', 'all', 'exclude'] as FlagMode[]).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={cls('mxd-seg__tab', mode === m && 'is-on')} onClick={() => setFlagModes((s) => ({ ...s, [kind]: m }))}>
                {m === 'any' ? 'Any' : m === 'all' ? 'All' : 'Exclude'}
              </button>
            ))}
          </div>
          <FlagPicker key={`${field.key}-${mode}`} selected={selected} onChange={(flags) => patch({ [target]: flags.length ? flags : undefined } as Partial<InboxAdvancedFilters>)} loadOptions={() => loadOptions(field)} />
        </div>
      )
    }
    if (field.type === 'numberRange' || field.type === 'dateRange') {
      const keys = resolveCatalogRangeKeys(field)
      const lo = (field.type === 'numberRange' ? keys.minKey : keys.fromKey) as keyof InboxAdvancedFilters | undefined
      const hi = (field.type === 'numberRange' ? keys.maxKey : keys.toKey) as keyof InboxAdvancedFilters | undefined
      if (!lo || !hi) return null
      const isDate = field.type === 'dateRange'
      return (
        <label key={field.key} className="mxd-field">
          <span className="mxd-field__label">{field.label}</span>
          <span className="mxd-range">
            <input type={isDate ? 'date' : 'number'} placeholder={isDate ? undefined : 'Min'} value={num(local[lo])} onChange={(e) => patch({ [lo]: isDate ? e.target.value || undefined : asNum(e.target.value) } as Partial<InboxAdvancedFilters>)} aria-label={`${field.label} ${isDate ? 'from' : 'minimum'}`} />
            <i aria-hidden="true">–</i>
            <input type={isDate ? 'date' : 'number'} placeholder={isDate ? undefined : 'Max'} value={num(local[hi])} onChange={(e) => patch({ [hi]: isDate ? e.target.value || undefined : asNum(e.target.value) } as Partial<InboxAdvancedFilters>)} aria-label={`${field.label} ${isDate ? 'to' : 'maximum'}`} />
          </span>
        </label>
      )
    }
    if (field.type === 'tri') {
      const v = local[key]
      const cur = v === true || v === 'yes' ? 'yes' : v === false || v === 'no' ? 'no' : ''
      return (
        <div key={field.key} className="mxd-field is-inline">
          <span className="mxd-field__label">{field.label}</span>
          <div className="mxd-seg is-sm" role="radiogroup" aria-label={field.label}>
            {([['', 'Any'], ['yes', 'Yes'], ['no', 'No']] as const).map(([val, label]) => (
              <button key={label} type="button" role="radio" aria-checked={cur === val} className={cls('mxd-seg__tab', cur === val && 'is-on')} onClick={() => patch({ [key]: val || undefined } as Partial<InboxAdvancedFilters>)}>{label}</button>
            ))}
          </div>
        </div>
      )
    }
    if (field.type === 'select') {
      const selected = normalizeCatalogSelectValue((local as Record<string, unknown>)[field.key])
      return (
        <div key={`${field.key}-${optionsVersion}`} className="mxd-field is-multi">
          <MultiSelectField
            label={field.label}
            selected={selected}
            onChange={(values) => patch({ [key]: values.length ? (values.length === 1 ? values[0] : values) : undefined } as Partial<InboxAdvancedFilters>)}
            loadOptions={() => loadOptions(field)}
            cached={optionsCache.current[field.optionsKey || field.key]}
          />
        </div>
      )
    }
    if (field.type === 'text') {
      return (
        <label key={field.key} className="mxd-field">
          <span className="mxd-field__label">{field.label}</span>
          <input type="text" className="mxd-input" value={(local[key] as string) ?? ''} placeholder="Contains…" onChange={(e) => patch({ [key]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)} />
        </label>
      )
    }
    return null
  }

  const universeLabel = fmtCount(universe)
  const shownCount = hasActive ? (count.counts?.properties ?? null) : universe
  const share = hasActive ? shareOfUniverse(count.counts?.properties ?? null, universe) : null
  const marketsCurrent = markets.key === payloadKey && hasActive
  const onMap = previewedKey === payloadKey && hasActive
  const dirtyVsApplied = previewing || !onMap

  const cohort = (
    <section className={cls('mxd-cohort', count.status === 'loading' && 'is-loading')} aria-live="polite" data-cohort-state={hasActive ? count.status : 'universe'}>
      <div className="mxd-cohort__eyebrow">
        <span className={cls('mxd-dot', hasActive ? (count.status === 'ready' ? 'is-on' : count.status === 'error' ? 'is-bad' : 'is-wait') : 'is-idle')} aria-hidden="true" />
        {hasActive ? 'Matching now' : 'Property universe'}
        {onMap ? <em className="mxd-tag is-accent">{previewing ? 'Previewing on map' : 'On the map'}</em> : null}
      </div>
      <div className="mxd-cohort__figure">
        <strong className={cls(shownCount === null && 'is-unknown')}>{shownCount === null ? '—' : fmtCount(shownCount)}</strong>
        <span>{hasActive ? (count.status === 'loading' ? 'counting…' : 'properties') : 'properties'}</span>
      </div>
      {hasActive ? (
        count.status === 'error' ? <p className="mxd-cohort__note is-bad">{count.error}</p>
          : count.counts ? (
            <p className="mxd-spec">
              {share ? <span>{share} of {universeLabel}</span> : <span>Universe count unavailable</span>}
              <span>{fmtCount(count.counts.owners) ?? '—'} owners</span>
              <span>{fmtCount(count.counts.phones) ?? '—'} phones</span>
            </p>
          ) : <p className="mxd-spec"><span>Counting the matching properties…</span></p>
      ) : (
        <p className="mxd-spec">{universeLabel ? <span>Every property · add filters to narrow the cohort</span> : <span>Universe count unavailable right now</span>}</p>
      )}
      {hasActive ? (
        <div className="mxd-markets">
          <div className="mxd-markets__head"><span>By market</span>{marketsCurrent && markets.status === 'ready' && markets.markets > markets.rows.length ? <em>top {markets.rows.length} of {markets.markets}</em> : null}</div>
          {marketsCurrent && markets.status === 'ready' && markets.rows.length ? (
            <ol className="mxd-markets__list">
              {markets.rows.map((m) => (
                <li key={m.market}>
                  <span className="mxd-markets__name" title={m.market}>{m.market}</span>
                  <span className="mxd-markets__bar" aria-hidden="true"><i style={{ width: `${Math.max(3, Math.round(m.share * 100))}%` }} /></span>
                  <span className="mxd-markets__n">{fmtCount(m.n)}</span>
                </li>
              ))}
            </ol>
          ) : marketsCurrent && markets.status === 'loading' ? (
            <p className="mxd-markets__note">Reading the split from the map…</p>
          ) : marketsCurrent && markets.status === 'ready' ? (
            <p className="mxd-markets__note">No market carries this cohort.</p>
          ) : marketsCurrent && markets.status === 'error' ? (
            <p className="mxd-markets__note is-bad">The market split didn’t load.</p>
          ) : (
            <p className="mxd-markets__note">Preview on map to split this cohort by market.</p>
          )}
        </div>
      ) : null}
    </section>
  )

  return createPortal(
    <section className="mxd-insp is-left mxd-filters" role="dialog" aria-modal="false" aria-label="Filters" data-map-inspector="filters">
      <header className="mxd-insp__head">
        <span className="mxd-insp__glyph" aria-hidden="true"><Icon name="filter" size={15} /></span>
        <div className="mxd-insp__title">
          <h2>Filters</h2>
          <p>{appliedRules > 0 && !previewing ? `${appliedRules} applied${appliedMatching != null ? ` · ${fmtCount(appliedMatching)} properties` : ''}` : `${fields.length} fields across the property universe`}</p>
        </div>
        <button type="button" className="mxd-icon-btn" aria-label="Close filters" onClick={onClose} data-map-sheet-close><Icon name="close" size={14} /></button>
      </header>

      <div className="mxd-insp__body">
        {cohort}

        <div className="mxd-block">
          <div className="mxd-block__head"><h3>Property universe</h3></div>
          <div className="mxd-seg" role="radiogroup" aria-label="Property universe">
            {([['all', 'All'], ['uncontacted', 'Uncontacted'], ['contacted', 'Contacted']] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={mapStatus === v} className={cls('mxd-seg__tab', mapStatus === v && 'is-on')} onClick={() => setMapStatus(v)}>{label}</button>
            ))}
          </div>
        </div>

        <label className="mxd-search">
          <Icon name="search" size={14} />
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${fields.length} fields`} aria-label="Search filters" />
          {query ? <button type="button" className="mxd-search__clear" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={11} /></button> : null}
        </label>

        {chips.length > 0 || mapStatus !== 'all' ? (
          <div className="mxd-chips" aria-label="Active filters">
            {mapStatus !== 'all' ? (
              <span className="mxd-chip">{mapStatus === 'uncontacted' ? 'Uncontacted' : 'Contacted'}<button type="button" aria-label="Remove universe filter" onClick={() => setMapStatus('all')}><Icon name="x" size={10} /></button></span>
            ) : null}
            {chips.map((c) => (
              <span key={c.key} className="mxd-chip">{c.label}<button type="button" aria-label={`Remove ${c.label}`} onClick={() => setLocal(c.clear(local))}><Icon name="x" size={10} /></button></span>
            ))}
          </div>
        ) : null}

        {q ? (
          <div className="mxd-group is-open is-search">
            <div className="mxd-group__head is-static"><span>{searchHits.length ? `${searchHits.length} matching field${searchHits.length === 1 ? '' : 's'}` : `No field matches “${query.trim()}”`}</span></div>
            <div className="mxd-group__fields">
              {searchHits.slice(0, 24).map((f) => (
                <div key={f.key} className="mxd-hit">
                  <span className="mxd-hit__group">{groupLabel(f.group)}</span>
                  {renderField(f)}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mxd-groups">
            {groups.map((g) => {
              const isOpen = openGroups.has(g.id)
              const inGroup = fields.filter((f) => f.group === g.id)
              if (!inGroup.length) return null
              const n = activeByGroup[g.id] ?? 0
              return (
                <section key={g.id} className={cls('mxd-group', isOpen && 'is-open')}>
                  <button
                    type="button"
                    className="mxd-group__head"
                    aria-expanded={isOpen}
                    onClick={() => setOpenGroups((s) => { const next = new Set(s); if (next.has(g.id)) next.delete(g.id); else next.add(g.id); return next })}
                  >
                    <span>{g.label}</span>
                    <em>{n ? `${n} active` : `${inGroup.length}`}</em>
                    <Icon name="chevron-down" size={13} />
                  </button>
                  {isOpen ? <div className="mxd-group__fields">{inGroup.map(renderField)}</div> : null}
                </section>
              )
            })}
          </div>
        )}

        {savedViews.length > 0 ? (
          <div className="mxd-block">
            <div className="mxd-block__head"><h3>Saved views</h3><em>load only</em></div>
            <div className="mxd-chips is-views">
              {savedViews.slice(0, 12).map((v) => (
                <button key={v.id} type="button" className="mxd-chip is-button" onClick={() => setLocal(mergeMapFilterDraft(stripMapExcludedFilters(v.filter_json)))}>{v.name}</button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <footer className="mxd-insp__foot">
        {actionError ? <p className="mxd-insp__error" role="alert">{actionError}</p> : null}
        <div className="mxd-insp__actions">
          <button type="button" className="mxd-btn is-ghost" onClick={clearAll} disabled={!hasActive && appliedRules === 0}>Clear</button>
          <span className="mxd-grow" />
          <button type="button" className="mxd-btn" onClick={() => void preview()} disabled={!hasActive || working !== 'idle' || (onMap && !dirtyVsApplied)} data-filter-action="preview">
            {working === 'previewing' ? 'Previewing…' : onMap ? 'On the map' : 'Preview on map'}
          </button>
          <button type="button" className="mxd-btn is-primary" onClick={() => void apply()} disabled={working !== 'idle'} data-filter-action="apply">
            {working === 'applying' ? 'Applying…' : hasActive && matchingNow !== null ? `Apply · ${fmtCount(matchingNow)}` : 'Apply'}
          </button>
        </div>
      </footer>
    </section>,
    host,
  )
}
