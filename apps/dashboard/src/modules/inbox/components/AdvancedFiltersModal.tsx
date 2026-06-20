import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { InboxAdvancedFilters, InboxViewSelectValue, InboxStageSelectValue } from '../inbox-ui-helpers'
import {
  buildAdvancedFilterChips,
  clearAllAdvancedFilters,
  countActiveAdvancedFilters,
  serializeAdvancedFiltersForServer,
} from '../../../domain/inbox/inbox-advanced-filter-engine'
import {
  fetchInboxFilterCatalog,
  fetchInboxFilterOptions,
  fetchInboxFilterPreview,
  fetchInboxSavedViews,
  saveInboxView,
  type FilterCatalogField,
  type FilterCatalogGroup,
  type FilterOption,
  type SavedInboxView,
} from '../../../domain/inbox/inbox-filter-api'

interface AdvancedFiltersModalProps {
  open: boolean
  stageFilter: InboxStageSelectValue
  viewFilter: InboxViewSelectValue
  inboxBucket: string
  advancedFilters: InboxAdvancedFilters
  onAdvancedFiltersChange: (filters: InboxAdvancedFilters) => void
  onReset: () => void
  onClose: () => void
  onApply: (payload: {
    view: InboxViewSelectValue
    stage: InboxStageSelectValue
    advanced: InboxAdvancedFilters
  }) => void
}

type FlagMode = 'any' | 'all' | 'exclude'

const GROUP_ICONS: Record<string, string> = {
  conversation: '📥', property: '🏠', financials: '💰', condition: '🔧',
  distress: '⚠️', prospect: '👤', owner: '💼', phone: '📱', email: '✉️',
}

const num = (v: number | undefined) => (v === undefined ? '' : String(v))
const asNum = (v: string): number | undefined => { const n = Number(v); return v.trim() && Number.isFinite(n) ? n : undefined }

export const AdvancedFiltersModal = ({
  open,
  stageFilter,
  viewFilter,
  inboxBucket,
  advancedFilters,
  onAdvancedFiltersChange,
  onReset,
  onClose,
  onApply,
}: AdvancedFiltersModalProps) => {
  const [groups, setGroups] = useState<FilterCatalogGroup[]>([])
  const [fields, setFields] = useState<FilterCatalogField[]>([])
  const [activeGroup, setActiveGroup] = useState('conversation')
  const [local, setLocal] = useState(advancedFilters)
  const [localStage, setLocalStage] = useState(stageFilter)
  const [search, setSearch] = useState('')
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [optionsCache, setOptionsCache] = useState<Record<string, FilterOption[]>>({})
  const [savedViews, setSavedViews] = useState<SavedInboxView[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [propertyFlagMode, setPropertyFlagMode] = useState<FlagMode>('any')
  const [personFlagMode, setPersonFlagMode] = useState<FlagMode>('any')
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    setLocal(advancedFilters)
    setLocalStage(stageFilter)
    setSearch('')
    void fetchInboxFilterCatalog().then((cat) => {
      setGroups(cat?.groups ?? [])
      setFields(cat?.fields ?? [])
    }).catch(() => {})
    void fetchInboxSavedViews().then(setSavedViews).catch(() => {})
  }, [open, advancedFilters, stageFilter])

  const serialized = useMemo(
    () => serializeAdvancedFiltersForServer(local, { stage: localStage, view: viewFilter }),
    [local, localStage, viewFilter],
  )

  useEffect(() => {
    if (!open) return
    if (previewTimer.current) clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => {
      setPreviewLoading(true)
      void fetchInboxFilterPreview({ ...serialized, filter: inboxBucket })
        .then(setPreviewCount)
        .catch(() => setPreviewCount(null))
        .finally(() => setPreviewLoading(false))
    }, 300)
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current) }
  }, [open, serialized, inboxBucket])

  const patch = useCallback((p: Partial<InboxAdvancedFilters>) => {
    setLocal((c) => ({ ...c, ...p }))
  }, [])

  const activeCount = useMemo(() => countActiveAdvancedFilters(local), [local])
  const chips = useMemo(() => buildAdvancedFilterChips(local, { stage: localStage, view: viewFilter }), [local, localStage, viewFilter])

  const groupFields = useMemo(() => {
    const q = search.trim().toLowerCase()
    return fields.filter((f) => f.group === activeGroup && (!q || f.label.toLowerCase().includes(q)))
  }, [fields, activeGroup, search])

  const loadOptions = useCallback(async (field: FilterCatalogField) => {
    const key = field.optionsKey || field.key
    if (optionsCache[key]) return optionsCache[key]
    const opts = await fetchInboxFilterOptions(key, { advanced: serialized, filter: inboxBucket })
    setOptionsCache((c) => ({ ...c, [key]: opts }))
    return opts
  }, [optionsCache, serialized, inboxBucket])

  const handleClearAll = useCallback(() => {
    const fresh = clearAllAdvancedFilters()
    setLocal(fresh)
    setLocalStage('all_stages')
    onAdvancedFiltersChange(fresh)
    onReset()
  }, [onAdvancedFiltersChange, onReset])

  const handleApply = useCallback(() => {
    onAdvancedFiltersChange(local)
    onApply({ view: viewFilter, stage: localStage, advanced: local })
    onClose()
  }, [local, localStage, onAdvancedFiltersChange, onApply, onClose, viewFilter])

  const handleSave = useCallback(async () => {
    if (!saveName.trim()) return
    const view = await saveInboxView({ name: saveName.trim(), filter_json: serialized })
    if (view) setSavedViews((v) => [...v, view])
    setSaveName('')
    setSaveOpen(false)
  }, [saveName, serialized])

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
          <FlagPicker fieldKey={field.key} mode={mode} selected={selected ?? []} onChange={(flags) => {
            if (mode === 'exclude') patch({ [`${isProperty ? 'property' : 'person'}FlagsExclude`]: flags } as Partial<InboxAdvancedFilters>)
            else patch({ [selectedKey]: flags } as Partial<InboxAdvancedFilters>)
          }} loadOptions={() => loadOptions(field)} />
        </div>
      )
    }

    if (field.type === 'numberRange') {
      const minKey = `${field.key}Min` as keyof InboxAdvancedFilters
      const maxKey = `${field.key.replace(/Min$/, '')}Max` as keyof InboxAdvancedFilters
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
      const fromKey = field.key as keyof InboxAdvancedFilters
      const toKey = field.key.replace(/From$/, 'To') as keyof InboxAdvancedFilters
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

  return createPortal(
    <div className="nx-ifm-overlay" role="presentation" onMouseDown={onClose}>
      <section className="nx-ifm-modal" role="dialog" aria-modal="true" aria-label="Advanced Inbox Filters" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nx-ifm-liquid-edge" aria-hidden="true" />

        <header className="nx-ifm-header">
          <div>
            <strong>Advanced Filters</strong>
            <span>{previewLoading ? 'Counting…' : `${(previewCount ?? 0).toLocaleString()} matching threads`}</span>
          </div>
          <div className="nx-ifm-header-actions">
            {activeCount > 0 && <span className="nx-ifm-badge">{activeCount}</span>}
            <button type="button" className="nx-ifm-close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
          </div>
        </header>

        <div className="nx-ifm-body">
          <nav className="nx-ifm-rail">
            {groups.map((g) => {
              const count = fields.filter((f) => f.group === g.id && countActiveAdvancedFilters(local) > 0).length
              return (
                <button key={g.id} type="button" className={`nx-ifm-rail-item${activeGroup === g.id ? ' is-active' : ''}`} onClick={() => setActiveGroup(g.id)}>
                  <span className="nx-ifm-rail-icon">{GROUP_ICONS[g.id] ?? '•'}</span>
                  <span>{g.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="nx-ifm-main">
            <div className="nx-ifm-search">
              <Icon name="search" />
              <input type="text" placeholder="Search filters in this group…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="nx-ifm-fields">{groupFields.map(renderField)}</div>
          </div>

          <aside className="nx-ifm-active">
            <h4>Active Filters</h4>
            {chips.length === 0 ? <p className="nx-ifm-empty">No filters applied</p> : (
              <div className="nx-ifm-chips">
                {chips.map((chip) => (
                  <span key={chip.key} className="nx-ifm-chip">
                    {chip.label}
                    <button type="button" onClick={() => setLocal(chip.clear(local))} aria-label={`Remove ${chip.label}`}><Icon name="x" /></button>
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
              <button type="button" className="nx-ifm-btn-secondary" onClick={() => setSaveOpen(true)}>Save View</button>
            )}
            <button type="button" className="nx-ifm-btn-primary" onClick={handleApply}>Apply{activeCount > 0 ? ` (${activeCount})` : ''}</button>
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

function FlagPicker({ fieldKey, mode, selected, onChange, loadOptions }: {
  fieldKey: string; mode: FlagMode; selected: string[]
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