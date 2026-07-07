import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  clearAllAdvancedFilters,
  DEFAULT_ADVANCED_FILTERS,
} from '../../../domain/inbox/inbox-advanced-filter-engine'
import {
  buildCatalogFilterChips,
  countActiveCatalogFilters,
  resolveCatalogRangeKeys,
  serializeInboxFiltersForMap,
} from '../../../domain/inbox/inbox-filter-catalog-runtime'
import {
  fetchInboxFilterCatalog,
  fetchInboxSavedViews,
  saveInboxView,
  type FilterCatalogField,
  type FilterCatalogGroup,
  type FilterOption,
  type SavedInboxView,
} from '../../../domain/inbox/inbox-filter-api'
import { INBOX_FILTER_CATALOG, INBOX_FILTER_FIELD_COUNT } from '../../../domain/inbox/inbox-filter-catalog-client'
import type { InboxAdvancedFilters } from '../../../modules/inbox/inbox-ui-helpers'
import { Icon } from '../../../shared/icons'
import { createMapFilterToken, fetchMapFilterOptions, previewMapFilter } from '../master-filters/api'
import { CANONICAL_PROPERTY_BASELINE } from '../master-filters/constants'
import type { MapStatusValue } from '../../../domain/map/inbox-to-map-filter-expression'
import {
  isMapExcludedFilterGroup,
  isMapExcludedFilterKey,
  stripMapExcludedFilters,
} from '../../../domain/map/map-filter-field-exclusions'
import {
  formatCatalogSelectSummary,
  normalizeCatalogSelectValue,
} from '../../../domain/inbox/catalog-select-value'
import {
  mergeMapFilterDraft,
  type MapAppliedFilterDraft,
} from '../../../domain/map/map-filter-draft'
import '../../../modules/inbox/inbox-polish.css'
import '../map-advanced-filters.css'

export interface MapAdvancedFiltersModalProps {
  open: boolean
  /** Previously applied filters — restored when reopening the modal. */
  initialDraft?: MapAppliedFilterDraft | null
  onClose: () => void
  onApply: (payload: {
    token: string | null
    activeRuleCount: number
    matchingProperties: number
    draft: MapAppliedFilterDraft
  }) => void
  onClear: () => void
}

type FlagMode = 'any' | 'all' | 'exclude'

const GROUP_ICONS: Record<string, string> = {
  map_status: '🗺️',
  property: '🏠', financials: '💰', condition: '🔧',
  distress: '⚠️', prospect: '👤', owner: '💼', phone: '📱', email: '✉️',
}

const MAP_STATUS_GROUP: FilterCatalogGroup = {
  id: 'map_status',
  label: 'Map Status',
  icon: 'map',
}

const INITIAL_GROUPS: FilterCatalogGroup[] = [MAP_STATUS_GROUP, ...filterMapCatalogGroups(INBOX_FILTER_CATALOG.groups)]

function filterMapCatalogGroups(catalogGroups: FilterCatalogGroup[]) {
  return catalogGroups.filter((group) => !isMapExcludedFilterGroup(group.id))
}

function filterMapCatalogFields(catalogFields: FilterCatalogField[]) {
  return catalogFields.filter((field) => !isMapExcludedFilterKey(field.key))
}

const num = (v: number | undefined) => (v === undefined ? '' : String(v))
const asNum = (v: string): number | undefined => { const n = Number(v); return v.trim() && Number.isFinite(n) ? n : undefined }

export function MapAdvancedFiltersModal({
  open,
  initialDraft = null,
  onClose,
  onApply,
  onClear,
}: MapAdvancedFiltersModalProps) {
  const [groups, setGroups] = useState<FilterCatalogGroup[]>(INITIAL_GROUPS)
  const [fields, setFields] = useState<FilterCatalogField[]>(filterMapCatalogFields(INBOX_FILTER_CATALOG.fields))
  const [activeGroup, setActiveGroup] = useState('map_status')
  const [local, setLocal] = useState<InboxAdvancedFilters>(DEFAULT_ADVANCED_FILTERS)
  const [mapStatus, setMapStatus] = useState<MapStatusValue>('all')
  const [search, setSearch] = useState('')
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const optionsCacheRef = useRef<Record<string, FilterOption[]>>({})
  const optionsInflightRef = useRef<Record<string, Promise<FilterOption[]>>>({})
  const [optionsVersion, setOptionsVersion] = useState(0)
  const [savedViews, setSavedViews] = useState<SavedInboxView[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [applying, setApplying] = useState(false)
  const [propertyFlagMode, setPropertyFlagMode] = useState<FlagMode>('any')
  const [personFlagMode, setPersonFlagMode] = useState<FlagMode>('any')
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialDraftRef = useRef(initialDraft)
  initialDraftRef.current = initialDraft

  useEffect(() => {
    if (!open) return
    const draft = initialDraftRef.current
    setLocal(mergeMapFilterDraft(draft?.filters))
    setMapStatus(draft?.mapStatus ?? 'all')
    setSearch('')
    setPreviewError(null)
    setActiveGroup('map_status')
    setGroups([MAP_STATUS_GROUP, ...filterMapCatalogGroups(INBOX_FILTER_CATALOG.groups)])
    setFields(filterMapCatalogFields(INBOX_FILTER_CATALOG.fields))
    optionsCacheRef.current = {}
    optionsInflightRef.current = {}
    setOptionsVersion((v) => v + 1)
    void fetchInboxFilterCatalog().then((cat) => {
      if ((cat?.fields?.length ?? 0) >= INBOX_FILTER_FIELD_COUNT) {
        setGroups([MAP_STATUS_GROUP, ...filterMapCatalogGroups(cat.groups ?? INBOX_FILTER_CATALOG.groups)])
        setFields(filterMapCatalogFields(cat.fields))
      }
    }).catch(() => {})
    void fetchInboxSavedViews().then(setSavedViews).catch(() => {})
  }, [open])

  const inboxFilters = useMemo(
    () => stripMapExcludedFilters(serializeInboxFiltersForMap(local)),
    [local],
  )

  const previewPayload = useMemo(
    () => ({ inboxFilters, mapStatus }),
    [inboxFilters, mapStatus],
  )

  const hasActiveFilters = useMemo(
    () => countActiveCatalogFilters(local) > 0 || mapStatus !== 'all',
    [local, mapStatus],
  )

  useEffect(() => {
    if (!open) return
    if (previewTimer.current) clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => {
      setPreviewLoading(true)
      setPreviewError(null)
      void previewMapFilter(previewPayload)
        .then((result) => {
          if (!result.ok) {
            setPreviewError(result.message || result.error)
            setPreviewCount(null)
            return
          }
          setPreviewCount(result.data.counts.matchingProperties)
        })
        .catch(() => {
          setPreviewError('Unable to calculate matching properties')
          setPreviewCount(null)
        })
        .finally(() => setPreviewLoading(false))
    }, 350)
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current) }
  }, [open, previewPayload])

  const patch = useCallback((p: Partial<InboxAdvancedFilters>) => {
    setLocal((c) => ({ ...c, ...p }))
  }, [])

  const activeCount = useMemo(() => {
    let count = countActiveCatalogFilters(local)
    if (mapStatus !== 'all') count += 1
    return count
  }, [local, mapStatus])

  const chips = useMemo(() => {
    const base = buildCatalogFilterChips(local)
    if (mapStatus !== 'all') {
      const label = mapStatus === 'uncontacted' ? 'Uncontacted' : 'Contacted'
      return [
        {
          key: 'mapStatus',
          label: `Map Status: ${label}`,
          clear: (current: InboxAdvancedFilters) => current,
        },
        ...base,
      ]
    }
    return base
  }, [local, mapStatus])

  const groupFields = useMemo(() => {
    if (activeGroup === 'map_status') return []
    const q = search.trim().toLowerCase()
    return fields.filter((f) => f.group === activeGroup && (!q || f.label.toLowerCase().includes(q)))
  }, [fields, activeGroup, search])

  const loadOptions = useCallback(async (field: FilterCatalogField) => {
    const key = field.optionsKey || field.key
    const cached = optionsCacheRef.current[key]
    if (cached?.length) return cached
    if (key in optionsInflightRef.current) return optionsInflightRef.current[key]

    const request = fetchMapFilterOptions(key, { advanced: inboxFilters })
      .then((result) => {
        if (!result.ok) throw new Error(result.message || result.error || 'filter_options_failed')
        const opts = result.data ?? []
        optionsCacheRef.current[key] = opts
        setOptionsVersion((v) => v + 1)
        return opts
      })
      .finally(() => {
        delete optionsInflightRef.current[key]
      })

    optionsInflightRef.current[key] = request
    return request
  }, [inboxFilters])

  useEffect(() => {
    if (!open || activeGroup === 'map_status') return
    const preload = groupFields
      .filter((f) => f.type === 'select' || f.type === 'flags')
      .slice(0, 8)
    for (const field of preload) {
      void loadOptions(field).catch(() => {})
    }
  }, [open, activeGroup, groupFields, loadOptions])

  const handleClearAll = useCallback(() => {
    const fresh = clearAllAdvancedFilters()
    setLocal(fresh)
    setMapStatus('all')
    onClear()
  }, [onClear])

  const canApply = !applying && (!hasActiveFilters || !previewLoading)

  const handleApply = useCallback(async () => {
    if (!canApply) return
    setApplying(true)
    try {
      const draft = { filters: { ...local }, mapStatus }
      if (!hasActiveFilters) {
        onApply({
          token: null,
          activeRuleCount: 0,
          matchingProperties: CANONICAL_PROPERTY_BASELINE,
          draft,
        })
        onClose()
        return
      }
      const tokenResult = await createMapFilterToken(previewPayload)
      if (!tokenResult.ok) {
        setPreviewError(tokenResult.message || tokenResult.error)
        return
      }
      onApply({
        token: tokenResult.data.filterToken,
        activeRuleCount: activeCount,
        matchingProperties: previewCount ?? CANONICAL_PROPERTY_BASELINE,
        draft,
      })
      onClose()
    } finally {
      setApplying(false)
    }
  }, [activeCount, canApply, hasActiveFilters, local, mapStatus, onApply, onClose, previewCount, previewPayload])

  const handleSave = useCallback(async () => {
    if (!saveName.trim()) return
    const view = await saveInboxView({ name: saveName.trim(), filter_json: inboxFilters })
    if (view) setSavedViews((v) => [...v, view])
    setSaveName('')
    setSaveOpen(false)
  }, [inboxFilters, saveName])

  const headerCountLabel = useMemo(() => {
    if (previewLoading) return 'Updating matching properties…'
    if (previewError && hasActiveFilters) return 'Unable to calculate matching properties'
    if (previewCount != null) return `${previewCount.toLocaleString()} matching properties`
    if (!hasActiveFilters) return `${CANONICAL_PROPERTY_BASELINE.toLocaleString()} matching properties`
    return '—'
  }, [hasActiveFilters, previewCount, previewError, previewLoading])

  const renderField = (field: FilterCatalogField) => {
    const key = field.key as keyof InboxAdvancedFilters

    if (field.type === 'flags') {
      const isProperty = field.key === 'propertyFlags'
      const mode = isProperty ? propertyFlagMode : personFlagMode
      const setMode = isProperty ? setPropertyFlagMode : setPersonFlagMode
      const selectedKey = isProperty ? 'propertyFlagsAny' : 'personFlagsAny'
      const selected = (local as Record<string, unknown>)[selectedKey] as string[] | undefined
      return (
        <div key={field.key} className="nx-ifm-flag-block">
          <div className="nx-ifm-flag-modes">
            {(['any', 'all', 'exclude'] as FlagMode[]).map((m) => (
              <button key={m} type="button" className={`nx-ifm-flag-mode${mode === m ? ' is-active' : ''}`} onClick={() => setMode(m)}>
                {m === 'any' ? 'Match Any' : m === 'all' ? 'Match All' : 'Exclude'}
              </button>
            ))}
          </div>
          <FlagPicker selected={selected ?? []} onChange={(flags) => {
            if (mode === 'exclude') patch({ [`${isProperty ? 'property' : 'person'}FlagsExclude`]: flags } as Partial<InboxAdvancedFilters>)
            else patch({ [selectedKey]: flags } as Partial<InboxAdvancedFilters>)
          }} loadOptions={() => loadOptions(field)} />
        </div>
      )
    }

    if (field.type === 'numberRange') {
      const { minKey, maxKey } = resolveCatalogRangeKeys(field)
      if (!minKey || !maxKey) return null
      return (
        <label key={field.key} className="nx-ifm-field">
          <span>{field.label}</span>
          <div className="nx-ifm-range">
            <input type="number" placeholder="Min" value={num(local[minKey] as number)} onChange={(e) => patch({ [minKey]: asNum(e.target.value) } as Partial<InboxAdvancedFilters>)} />
            <span>–</span>
            <input type="number" placeholder="Max" value={num(local[maxKey] as number)} onChange={(e) => patch({ [maxKey]: asNum(e.target.value) } as Partial<InboxAdvancedFilters>)} />
          </div>
        </label>
      )
    }

    if (field.type === 'dateRange') {
      const { fromKey, toKey } = resolveCatalogRangeKeys(field)
      if (!fromKey || !toKey) return null
      return (
        <label key={field.key} className="nx-ifm-field">
          <span>{field.label}</span>
          <div className="nx-ifm-range">
            <input type="date" value={(local[fromKey] as string) ?? ''} onChange={(e) => patch({ [fromKey]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)} />
            <span>–</span>
            <input type="date" value={(local[toKey] as string) ?? ''} onChange={(e) => patch({ [toKey]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)} />
          </div>
        </label>
      )
    }

    if (field.type === 'tri') {
      const val = local[key]
      const str = val === true || val === 'yes' ? 'yes' : val === false || val === 'no' ? 'no' : ''
      return (
        <label key={field.key} className="nx-ifm-field">
          <span>{field.label}</span>
          <select value={str} onChange={(e) => patch({ [key]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)}>
            <option value="">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      )
    }

    if (field.type === 'select') {
      const selected = normalizeCatalogSelectValue((local as Record<string, unknown>)[field.key])
      return (
        <MultiSelectField
          key={`${field.key}-${optionsVersion}`}
          label={field.label}
          selected={selected}
          onChange={(values) => patch({
            [key]: values.length ? (values.length === 1 ? values[0] : values) : undefined,
          } as Partial<InboxAdvancedFilters>)}
          loadOptions={() => loadOptions(field)}
          cached={optionsCacheRef.current[field.optionsKey || field.key]}
        />
      )
    }

    if (field.type === 'text') {
      return (
        <label key={field.key} className="nx-ifm-field">
          <span>{field.label}</span>
          <input type="text" value={(local[key] as string) ?? ''} placeholder="Contains…" onChange={(e) => patch({ [key]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)} />
        </label>
      )
    }

    return null
  }

  if (!open) return null

  const applyLabel = applying
    ? 'Applying…'
    : previewLoading && hasActiveFilters
      ? 'Refreshing…'
      : previewCount != null && hasActiveFilters
        ? `Apply · ${previewCount.toLocaleString()} Properties`
        : 'Apply'

  return createPortal(
    <div className="nx-ifm-overlay nx-ifm-overlay--map" role="presentation" onMouseDown={onClose}>
      <section className="nx-ifm-modal nx-ifm-modal--map" role="dialog" aria-modal="true" aria-label="Advanced Map Filters" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nx-ifm-liquid-edge" aria-hidden="true" />

        <header className="nx-ifm-header">
          <div>
            <strong>Advanced Filters</strong>
            <span className={previewError && hasActiveFilters ? 'is-error' : undefined}>
              {headerCountLabel}
              {fields.length > 0 ? ` · ${fields.length} filters` : ` · ${filterMapCatalogFields(INBOX_FILTER_CATALOG.fields).length} filters`}
            </span>
          </div>
          <div className="nx-ifm-header-actions">
            {activeCount > 0 && <span className="nx-ifm-badge">{activeCount}</span>}
            <button type="button" className="nx-ifm-close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
          </div>
        </header>

        <div className="nx-ifm-body">
          <nav className="nx-ifm-rail">
            {groups.map((g) => (
              <button key={g.id} type="button" className={`nx-ifm-rail-item${activeGroup === g.id ? ' is-active' : ''}`} onClick={() => setActiveGroup(g.id)}>
                <span className="nx-ifm-rail-icon">{GROUP_ICONS[g.id] ?? '•'}</span>
                <span>{g.label}</span>
              </button>
            ))}
          </nav>

          <div className="nx-ifm-main">
            <div className="nx-ifm-search">
              <svg className="nx-ifm-search-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              </svg>
              <input type="text" className="nx-ifm-search-input" placeholder="Search filters in this group…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="nx-ifm-fields">
              {activeGroup === 'map_status' ? (
                <label className="nx-ifm-field">
                  <span>Property Universe</span>
                  <select value={mapStatus} onChange={(e) => setMapStatus(e.target.value as MapStatusValue)}>
                    <option value="all">All Properties</option>
                    <option value="uncontacted">Uncontacted</option>
                    <option value="contacted">Contacted</option>
                  </select>
                </label>
              ) : groupFields.map(renderField)}
            </div>
          </div>

          <aside className="nx-ifm-active">
            <h4>Active Filters</h4>
            {chips.length === 0 ? <p className="nx-ifm-empty">No filters applied</p> : (
              <div className="nx-ifm-chips">
                {chips.map((chip) => (
                  <span key={chip.key} className="nx-ifm-chip">
                    {chip.label}
                    <button type="button" onClick={() => {
                      if (chip.key === 'mapStatus') setMapStatus('all')
                      else setLocal(chip.clear(local))
                    }} aria-label={`Remove ${chip.label}`}><Icon name="x" /></button>
                  </span>
                ))}
              </div>
            )}
            {savedViews.length > 0 && (
              <div className="nx-ifm-saved">
                <h5>Saved Views</h5>
                {savedViews.filter((v) => !v.is_system).map((v) => (
                  <button key={v.id} type="button" className="nx-ifm-saved-item" onClick={() => setLocal(stripMapExcludedFilters(v.filter_json) as InboxAdvancedFilters)}>
                    {v.name}
                  </button>
                ))}
              </div>
            )}
          </aside>
        </div>

        <footer className="nx-ifm-footer">
          <button type="button" className="nx-ifm-btn-ghost" onClick={handleClearAll}>Clear All</button>
          <div className="nx-ifm-footer-right">
            {saveOpen ? (
              <>
                <input className="nx-ifm-save-input" value={saveName} placeholder="View name…" onChange={(e) => setSaveName(e.target.value)} autoFocus />
                <button type="button" className="nx-ifm-btn-secondary" onClick={() => void handleSave()} disabled={!saveName.trim()}>Save</button>
                <button type="button" className="nx-ifm-btn-ghost" onClick={() => setSaveOpen(false)}>Cancel</button>
              </>
            ) : (
              <button type="button" className="nx-ifm-btn-secondary" onClick={() => setSaveOpen(true)} disabled={!hasActiveFilters || previewCount == null}>Save View</button>
            )}
            <button type="button" className="nx-ifm-btn-primary" onClick={() => void handleApply()} disabled={!canApply}>{applyLabel}</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

function MultiSelectField({ label, selected, onChange, loadOptions, cached }: {
  label: string
  selected: string[]
  onChange: (values: string[]) => void
  loadOptions: () => Promise<FilterOption[]>
  cached?: FilterOption[]
}) {
  const loadRef = useRef(loadOptions)
  loadRef.current = loadOptions
  const [opts, setOpts] = useState<FilterOption[]>(cached ?? [])
  const [loading, setLoading] = useState(!cached?.length)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    if (cached?.length) {
      setOpts(cached)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void loadRef.current()
      .then((next) => {
        if (cancelled) return
        setOpts(next)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setOpts([])
        setLoading(false)
        setError(err instanceof Error ? err.message : 'Unable to load options')
      })
    return () => { cancelled = true }
  }, [cached])

  const filtered = opts.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()))
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }
  const summary = formatCatalogSelectSummary(selected)

  return (
    <div className="nx-ifm-field nx-ifm-field--multi">
      <span>
        {label}
        {loading ? ' · Loading…' : error ? ' · Unavailable' : selected.length ? ` · ${summary}` : ''}
      </span>
      <input
        type="text"
        className="nx-ifm-multi-search"
        placeholder={loading ? 'Loading options…' : error ? 'Unavailable' : 'Search options…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={loading && !opts.length}
      />
      <div className="nx-ifm-multi-list">
        {loading && filtered.length === 0 && <p className="nx-ifm-empty">Loading options…</p>}
        {!loading && error && filtered.length === 0 && <p className="nx-ifm-empty">Unable to load options</p>}
        {!loading && !error && filtered.length === 0 && <p className="nx-ifm-empty">No options match</p>}
        {filtered.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`nx-ifm-flag-chip${selected.includes(o.value) ? ' is-selected' : ''}`}
            onClick={() => toggle(o.value)}
          >
            {o.label} <em>{o.count.toLocaleString()}</em>
          </button>
        ))}
      </div>
    </div>
  )
}

function FlagPicker({ selected, onChange, loadOptions }: {
  selected: string[]
  onChange: (flags: string[]) => void; loadOptions: () => Promise<FilterOption[]>
}) {
  const loadRef = useRef(loadOptions)
  loadRef.current = loadOptions
  const [opts, setOpts] = useState<FilterOption[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void loadRef.current()
      .then((next) => {
        if (cancelled) return
        setOpts(next)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setOpts([])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])
  const filtered = opts.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()))
  const toggle = (flag: string) => {
    onChange(selected.includes(flag) ? selected.filter((f) => f !== flag) : [...selected, flag])
  }
  return (
    <div className="nx-ifm-flag-picker">
      <input type="text" placeholder={loading ? 'Loading flags…' : 'Search flags…'} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="nx-ifm-flag-list">
        {loading && filtered.length === 0 && <p className="nx-ifm-empty">Loading flag options…</p>}
        {!loading && filtered.length === 0 && <p className="nx-ifm-empty">No flags available</p>}
        {filtered.map((o) => (
          <button key={o.value} type="button" className={`nx-ifm-flag-chip${selected.includes(o.value) ? ' is-selected' : ''}`} onClick={() => toggle(o.value)}>
            {o.label} <em>{o.count}</em>
          </button>
        ))}
      </div>
    </div>
  )
}