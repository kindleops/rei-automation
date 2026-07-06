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
  fetchInboxFilterOptions,
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
import { createMapFilterToken, previewMapFilter } from '../master-filters/api'
import type { MapFilterBounds } from '../master-filters/types'
import { CANONICAL_PROPERTY_BASELINE } from '../master-filters/constants'
import type { MapStatusValue } from '../../../domain/map/inbox-to-map-filter-expression'
import '../../../modules/inbox/inbox-polish.css'
import '../map-advanced-filters.css'

export interface MapAdvancedFiltersModalProps {
  open: boolean
  bounds?: MapFilterBounds | null
  onClose: () => void
  onApply: (payload: {
    token: string | null
    activeRuleCount: number
    matchingProperties: number
  }) => void
  onClear: () => void
}

type FlagMode = 'any' | 'all' | 'exclude'

const GROUP_ICONS: Record<string, string> = {
  map_status: '🗺️',
  conversation: '📥', property: '🏠', financials: '💰', condition: '🔧',
  distress: '⚠️', prospect: '👤', owner: '💼', phone: '📱', email: '✉️',
}

const MAP_STATUS_GROUP: FilterCatalogGroup = {
  id: 'map_status',
  label: 'Map Status',
  icon: 'map',
}

const INITIAL_GROUPS: FilterCatalogGroup[] = [MAP_STATUS_GROUP, ...INBOX_FILTER_CATALOG.groups]

const num = (v: number | undefined) => (v === undefined ? '' : String(v))
const asNum = (v: string): number | undefined => { const n = Number(v); return v.trim() && Number.isFinite(n) ? n : undefined }

export function MapAdvancedFiltersModal({
  open,
  bounds = null,
  onClose,
  onApply,
  onClear,
}: MapAdvancedFiltersModalProps) {
  const [groups, setGroups] = useState<FilterCatalogGroup[]>(INITIAL_GROUPS)
  const [fields, setFields] = useState<FilterCatalogField[]>(INBOX_FILTER_CATALOG.fields)
  const [activeGroup, setActiveGroup] = useState('map_status')
  const [local, setLocal] = useState<InboxAdvancedFilters>(DEFAULT_ADVANCED_FILTERS)
  const [mapStatus, setMapStatus] = useState<MapStatusValue>('all')
  const [search, setSearch] = useState('')
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [optionsCache, setOptionsCache] = useState<Record<string, FilterOption[]>>({})
  const [savedViews, setSavedViews] = useState<SavedInboxView[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [applying, setApplying] = useState(false)
  const [propertyFlagMode, setPropertyFlagMode] = useState<FlagMode>('any')
  const [personFlagMode, setPersonFlagMode] = useState<FlagMode>('any')
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    setLocal(DEFAULT_ADVANCED_FILTERS)
    setMapStatus('all')
    setSearch('')
    setPreviewError(null)
    setActiveGroup('map_status')
    setGroups([MAP_STATUS_GROUP, ...INBOX_FILTER_CATALOG.groups])
    setFields(INBOX_FILTER_CATALOG.fields)
    void fetchInboxFilterCatalog().then((cat) => {
      if ((cat?.fields?.length ?? 0) >= INBOX_FILTER_FIELD_COUNT) {
        setGroups([MAP_STATUS_GROUP, ...(cat.groups ?? INBOX_FILTER_CATALOG.groups)])
        setFields(cat.fields)
      }
    }).catch(() => {})
    void fetchInboxSavedViews().then(setSavedViews).catch(() => {})
  }, [open])

  const inboxFilters = useMemo(() => serializeInboxFiltersForMap(local), [local])

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
      void previewMapFilter(previewPayload, bounds)
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
  }, [open, previewPayload, bounds])

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
    if (optionsCache[key]) return optionsCache[key]
    const opts = await fetchInboxFilterOptions(key, { advanced: inboxFilters, filter: 'all' })
    setOptionsCache((c) => ({ ...c, [key]: opts }))
    return opts
  }, [optionsCache, inboxFilters])

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
      if (!hasActiveFilters) {
        onApply({ token: null, activeRuleCount: 0, matchingProperties: CANONICAL_PROPERTY_BASELINE })
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
      })
      onClose()
    } finally {
      setApplying(false)
    }
  }, [activeCount, canApply, hasActiveFilters, onApply, onClose, previewCount, previewPayload])

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
      return (
        <SelectField key={field.key} label={field.label} value={(local[key] as string) ?? ''} onChange={(v) => patch({ [key]: v || undefined } as Partial<InboxAdvancedFilters>)} loadOptions={() => loadOptions(field)} cached={optionsCache[field.optionsKey || field.key]} />
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
              {fields.length > 0 ? ` · ${fields.length} filters` : ` · ${INBOX_FILTER_FIELD_COUNT} filters`}
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
                  <button key={v.id} type="button" className="nx-ifm-saved-item" onClick={() => setLocal(v.filter_json as InboxAdvancedFilters)}>
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

function SelectField({ label, value, onChange, loadOptions, cached }: {
  label: string; value: string; onChange: (v: string) => void
  loadOptions: () => Promise<FilterOption[]>; cached?: FilterOption[]
}) {
  const [opts, setOpts] = useState<FilterOption[]>(cached ?? [])
  useEffect(() => {
    if (cached?.length) { setOpts(cached); return }
    void loadOptions().then(setOpts).catch(() => {})
  }, [cached, loadOptions])
  return (
    <label className="nx-ifm-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
      </select>
    </label>
  )
}

function FlagPicker({ selected, onChange, loadOptions }: {
  selected: string[]
  onChange: (flags: string[]) => void; loadOptions: () => Promise<FilterOption[]>
}) {
  const [opts, setOpts] = useState<FilterOption[]>([])
  const [q, setQ] = useState('')
  useEffect(() => { void loadOptions().then(setOpts).catch(() => {}) }, [loadOptions])
  const filtered = opts.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()))
  const toggle = (flag: string) => {
    onChange(selected.includes(flag) ? selected.filter((f) => f !== flag) : [...selected, flag])
  }
  return (
    <div className="nx-ifm-flag-picker">
      <input type="text" placeholder="Search flags…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="nx-ifm-flag-list">
        {filtered.map((o) => (
          <button key={o.value} type="button" className={`nx-ifm-flag-chip${selected.includes(o.value) ? ' is-selected' : ''}`} onClick={() => toggle(o.value)}>
            {o.label} <em>{o.count}</em>
          </button>
        ))}
      </div>
    </div>
  )
}