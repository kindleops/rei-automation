import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { InboxAdvancedFilters, InboxViewSelectValue, InboxStageSelectValue } from '../inbox-ui-helpers'
import { viewOptions } from '../inbox-ui-helpers'
import { sellerStageOptions } from '../status-visuals'
import type { AdvancedFilterOptions } from './InboxSidebar'
import {
  ADVANCED_FILTER_FIELDS,
  buildAdvancedFilterChips,
  clearAllAdvancedFilters,
  countActiveAdvancedFilters,
  type AdvancedFilterFieldSpec,
  type AdvancedFilterGroupId,
} from '../../../domain/inbox/inbox-advanced-filter-engine'

interface AdvancedFiltersPopoverProps {
  open: boolean
  stageFilter: InboxStageSelectValue
  viewFilter: InboxViewSelectValue
  advancedFilters: InboxAdvancedFilters
  onAdvancedFiltersChange: (filters: InboxAdvancedFilters) => void
  advancedFilterOptions: AdvancedFilterOptions
  viewCounts: Record<string, number | string | null | undefined>
  resultCount: number
  onReset: () => void
  onClose: () => void
  onApply: (payload: {
    view: InboxViewSelectValue
    stage: InboxStageSelectValue
    advanced: InboxAdvancedFilters
  }) => void
}

const SAVED_VIEWS_KEY = 'nx_inbox_saved_views'

const GROUP_META: Array<{ id: AdvancedFilterGroupId; label: string }> = [
  { id: 'property', label: 'Property' },
  { id: 'owner', label: 'Owner' },
  { id: 'prospect', label: 'Prospect' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'phone', label: 'Phone & Delivery' },
]

interface SavedView {
  id: string
  name: string
  state: { view: InboxViewSelectValue; stage: InboxStageSelectValue; advanced: InboxAdvancedFilters }
}

const num = (v: number | undefined) => (v === undefined ? '' : String(v))
const asNum = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() && Number.isFinite(n) ? n : undefined
}

function loadSavedViews(): SavedView[] {
  try { return JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) ?? '[]') } catch { return [] }
}
function persistSavedViews(views: SavedView[]) {
  try { localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views)) } catch { /* ignore */ }
}

const Sel = ({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) => (
  <select className="nx-icf-input" value={value} onChange={(e) => onChange(e.target.value)}>
    {children}
  </select>
)

const Num = ({ value, onChange, placeholder }: { value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string }) => (
  <input className="nx-icf-input" type="number" value={num(value)} placeholder={placeholder ?? '—'} onChange={(e) => onChange(asNum(e.target.value))} />
)

const F = ({ label, children, half }: { label: string; children: React.ReactNode; half?: boolean }) => (
  <div className={`nx-icf-field${half ? ' is-half' : ''}`}>
    <span className="nx-icf-label">{label}</span>
    {children}
  </div>
)

export const AdvancedFiltersPopover = ({
  open,
  stageFilter,
  viewFilter,
  advancedFilters,
  onAdvancedFiltersChange,
  advancedFilterOptions,
  viewCounts,
  resultCount,
  onReset,
  onClose,
  onApply,
}: AdvancedFiltersPopoverProps) => {
  const [localView, setLocalView] = useState(viewFilter)
  const [localStage, setLocalStage] = useState(stageFilter)
  const [localAdvanced, setLocalAdvanced] = useState(advancedFilters)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<AdvancedFilterGroupId, boolean>>({
    property: false,
    owner: true,
    prospect: true,
    conversation: true,
    phone: true,
  })
  const [savedViews, setSavedViews] = useState<SavedView[]>(loadSavedViews)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [saveViewName, setSaveViewName] = useState('')
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (open) {
      setLocalView(viewFilter)
      setLocalStage(stageFilter)
      setLocalAdvanced(advancedFilters)
      setSearch('')
    }
  }, [open, viewFilter, stageFilter, advancedFilters])

  const patchAdv = useCallback((patch: Partial<InboxAdvancedFilters>) => {
    setLocalAdvanced((current) => ({ ...current, ...patch }))
  }, [])

  const optionBuckets = useMemo(() => ({
    markets: advancedFilterOptions.markets,
    states: advancedFilterOptions.states,
    cities: advancedFilterOptions.cities ?? [],
    zips: advancedFilterOptions.zips,
    propertyTypes: advancedFilterOptions.propertyTypes,
    ownerTypes: advancedFilterOptions.ownerTypes,
    languages: advancedFilterOptions.languages,
    stages: sellerStageOptions.map((o) => o.value),
    deliveryStatuses: advancedFilterOptions.deliveryStatuses ?? ['delivered', 'failed', 'pending', 'undelivered'],
    propertyConditions: advancedFilterOptions.propertyConditions ?? [],
    distressFlags: advancedFilterOptions.distressFlags ?? [],
  }), [advancedFilterOptions])

  const filteredFields = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return ADVANCED_FILTER_FIELDS
    return ADVANCED_FILTER_FIELDS.filter((field) => field.label.toLowerCase().includes(q))
  }, [search])

  const activeCount = useMemo(
    () => countActiveAdvancedFilters(localAdvanced) + (localView !== 'all_conversations' ? 1 : 0) + (localStage !== 'all_stages' ? 1 : 0),
    [localAdvanced, localStage, localView],
  )

  const chips = useMemo(
    () => buildAdvancedFilterChips(localAdvanced, { stage: localStage, view: localView }),
    [localAdvanced, localStage, localView],
  )

  const handleApply = useCallback(() => {
    setApplying(true)
    onAdvancedFiltersChange(localAdvanced)
    onApply({ view: localView, stage: localStage, advanced: localAdvanced })
    setTimeout(() => { setApplying(false); onClose() }, 120)
  }, [localAdvanced, localStage, localView, onAdvancedFiltersChange, onApply, onClose])

  const handleClearAll = useCallback(() => {
    const fresh = clearAllAdvancedFilters()
    setLocalView('all_conversations')
    setLocalStage('all_stages')
    setLocalAdvanced(fresh)
    onAdvancedFiltersChange(fresh)
    onReset()
  }, [onAdvancedFiltersChange, onReset])

  const handleSaveView = useCallback(() => {
    if (!saveViewName.trim()) return
    const view: SavedView = {
      id: Date.now().toString(),
      name: saveViewName.trim(),
      state: { view: localView, stage: localStage, advanced: localAdvanced },
    }
    const next = [...savedViews, view]
    setSavedViews(next)
    persistSavedViews(next)
    setSaveViewName('')
    setSaveViewOpen(false)
  }, [localAdvanced, localStage, localView, saveViewName, savedViews])

  const renderField = (field: AdvancedFilterFieldSpec) => {
    if (field.id === 'ownerName') {
      return (
        <F key={field.id} label={field.label}>
          <input className="nx-icf-input" type="text" value={localAdvanced.ownerNameSearch ?? ''} placeholder="Contains…" onChange={(e) => patchAdv({ ownerNameSearch: e.target.value || undefined })} />
        </F>
      )
    }
    if (field.id === 'phoneNumber') {
      return (
        <F key={field.id} label={field.label}>
          <input className="nx-icf-input" type="text" value={localAdvanced.phoneNumberSearch ?? ''} placeholder="Contains…" onChange={(e) => patchAdv({ phoneNumberSearch: e.target.value || undefined })} />
        </F>
      )
    }
    if (field.id === 'addressSearch') {
      return (
        <F key={field.id} label={field.label}>
          <input className="nx-icf-input" type="text" value={localAdvanced.addressSearch ?? ''} placeholder="Address, owner, phone…" onChange={(e) => patchAdv({ addressSearch: e.target.value || undefined })} />
        </F>
      )
    }

    if (field.kind === 'numberRange') {
      const minKey = field.minKey!
      const maxKey = field.maxKey!
      return (
        <F key={field.id} label={field.label} half>
          <div className="nx-icf-range">
            <Num value={localAdvanced[minKey] as number | undefined} onChange={(v) => patchAdv({ [minKey]: v } as Partial<InboxAdvancedFilters>)} placeholder="Min" />
            <span>–</span>
            <Num value={localAdvanced[maxKey] as number | undefined} onChange={(v) => patchAdv({ [maxKey]: v } as Partial<InboxAdvancedFilters>)} placeholder="Max" />
          </div>
        </F>
      )
    }

    if (field.kind === 'dateRange') {
      const minKey = field.minKey!
      const maxKey = field.maxKey!
      return (
        <F key={field.id} label={field.label} half>
          <div className="nx-icf-range">
            <input className="nx-icf-input" type="date" value={(localAdvanced[minKey] as string) ?? ''} onChange={(e) => patchAdv({ [minKey]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)} />
            <span>–</span>
            <input className="nx-icf-input" type="date" value={(localAdvanced[maxKey] as string) ?? ''} onChange={(e) => patchAdv({ [maxKey]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)} />
          </div>
        </F>
      )
    }

    if (field.kind === 'number') {
      const key = field.minKey ?? field.id
      return (
        <F key={field.id} label={field.label} half>
          <Num value={localAdvanced[key as keyof InboxAdvancedFilters] as number | undefined} onChange={(v) => patchAdv({ [key]: v } as Partial<InboxAdvancedFilters>)} />
        </F>
      )
    }

    if (field.kind === 'tri') {
      const key = field.id as keyof InboxAdvancedFilters
      const value = (localAdvanced[key] as string) ?? (key === 'outOfStateOwner' ? 'all' : '')
      return (
        <F key={field.id} label={field.label} half>
          <Sel value={value} onChange={(v) => patchAdv({ [key]: (v || (key === 'outOfStateOwner' ? 'all' : undefined)) } as Partial<InboxAdvancedFilters>)}>
            <option value={key === 'outOfStateOwner' ? 'all' : ''}>Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Sel>
        </F>
      )
    }

    if (field.kind === 'toggle') {
      const key = field.id as keyof InboxAdvancedFilters
      const on = Boolean(localAdvanced[key])
      return (
        <button
          key={field.id}
          type="button"
          className={`nx-icf-toggle${on ? ' is-on' : ''}`}
          onClick={() => patchAdv({ [key]: on ? undefined : true } as Partial<InboxAdvancedFilters>)}
        >
          {field.label}
        </button>
      )
    }

    if (field.kind === 'select' && field.optionsKey) {
      const key = field.id as keyof InboxAdvancedFilters
      const options = optionBuckets[field.optionsKey] ?? []
      return (
        <F key={field.id} label={field.label} half>
          <Sel value={(localAdvanced[key] as string) ?? ''} onChange={(v) => patchAdv({ [key]: v || undefined } as Partial<InboxAdvancedFilters>)}>
            <option value="">Any</option>
            {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </Sel>
        </F>
      )
    }

    if (field.kind === 'text') {
      const key = field.id as keyof InboxAdvancedFilters
      return (
        <F key={field.id} label={field.label} half>
          <input className="nx-icf-input" type="text" value={(localAdvanced[key] as string) ?? ''} placeholder="Contains…" onChange={(e) => patchAdv({ [key]: e.target.value || undefined } as Partial<InboxAdvancedFilters>)} />
        </F>
      )
    }

    if (field.id === 'leadTemperature') {
      return (
        <F key={field.id} label={field.label} half>
          <Sel value={localAdvanced.leadTemperature ?? ''} onChange={(v) => patchAdv({ leadTemperature: v || undefined })}>
            <option value="">Any</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </Sel>
        </F>
      )
    }

    if (field.id === 'lastMessageDirection') {
      return (
        <F key={field.id} label={field.label} half>
          <Sel value={localAdvanced.lastMessageDirection ?? ''} onChange={(v) => patchAdv({ lastMessageDirection: v || undefined })}>
            <option value="">Any</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </Sel>
        </F>
      )
    }

    return null
  }

  if (!open) return null

  return createPortal(
    <div className="nx-filter-overlay nx-filter-overlay--slide" role="presentation" onMouseDown={onClose}>
      <section
        className="nx-icf-modal nx-icf-slideover"
        role="dialog"
        aria-modal="true"
        aria-label="Advanced Inbox Filters"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="nx-icf-header">
          <div className="nx-icf-header-left">
            <strong>Advanced Filters</strong>
            <span>{resultCount.toLocaleString()} matching threads</span>
          </div>
          <div className="nx-icf-header-right">
            {activeCount > 0 && <span className="nx-icf-count-badge">{activeCount} active</span>}
            <button type="button" className="nx-icf-close" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="nx-icf-cmdbar">
          <Icon name="search" />
          <input
            className="nx-icf-cmdbar-input"
            type="text"
            placeholder="Search filter names…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="nx-icf-grid nx-icf-grid--sm" style={{ padding: '12px 20px', borderBottom: '1px solid var(--nx-border-subtle)' }}>
          <F label="Inbox Category" half>
            <Sel value={localView} onChange={(v) => setLocalView(v as InboxViewSelectValue)}>
              {viewOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}{viewCounts[o.value] != null ? ` (${viewCounts[o.value]})` : ''}
                </option>
              ))}
            </Sel>
          </F>
          <F label="Stage" half>
            <Sel value={localStage} onChange={(v) => setLocalStage(v as InboxStageSelectValue)}>
              <option value="all_stages">Any Stage</option>
              {sellerStageOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Sel>
          </F>
        </div>

        {chips.length > 0 && (
          <div className="nx-icf-chips">
            {chips.map((chip) => (
              <span key={chip.key} className="nx-icf-chip">
                {chip.label}
                <button type="button" onClick={() => setLocalAdvanced(chip.clear(localAdvanced))} aria-label={`Remove ${chip.label}`}>
                  <Icon name="x" />
                </button>
              </span>
            ))}
            <button type="button" className="nx-icf-chip-clear" onClick={handleClearAll}>Clear All</button>
          </div>
        )}

        <div className="nx-icf-body nx-icf-body--groups">
          {GROUP_META.map((group) => {
            const fields = filteredFields.filter((f) => f.group === group.id)
            if (fields.length === 0) return null
            const isCollapsed = collapsed[group.id]
            return (
              <div key={group.id} className="nx-icf-group">
                <button
                  type="button"
                  className="nx-icf-group-toggle"
                  onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !c[group.id] }))}
                  aria-expanded={!isCollapsed}
                >
                  <span>{group.label}</span>
                  <Icon name={isCollapsed ? 'chevron-down' : 'chevron-up'} />
                </button>
                {!isCollapsed && (
                  <div className="nx-icf-grid nx-icf-grid--sm">
                    {group.id === 'property' && (
                      <F label="Address Search" half>
                        <input className="nx-icf-input" type="text" value={localAdvanced.addressSearch ?? ''} placeholder="Owner, phone, address…" onChange={(e) => patchAdv({ addressSearch: e.target.value || undefined })} />
                      </F>
                    )}
                    {fields.map(renderField)}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {savedViews.length > 0 && (
          <div className="nx-icf-saved-views">
            <span className="nx-icf-saved-label">Saved Views</span>
            <div className="nx-icf-saved-list">
              {savedViews.map((sv) => (
                <div key={sv.id} className="nx-icf-saved-item">
                  <button type="button" className="nx-icf-saved-load" onClick={() => {
                    setLocalView(sv.state.view)
                    setLocalStage(sv.state.stage)
                    setLocalAdvanced(sv.state.advanced)
                  }}>
                    {sv.name}
                  </button>
                  <button type="button" className="nx-icf-saved-del" onClick={() => {
                    const next = savedViews.filter((v) => v.id !== sv.id)
                    setSavedViews(next)
                    persistSavedViews(next)
                  }} aria-label={`Delete ${sv.name}`}>
                    <Icon name="x" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <footer className="nx-icf-footer">
          <button type="button" className="nx-icf-btn-ghost" onClick={handleClearAll}>Clear All</button>
          <div className="nx-icf-footer-right">
            {saveViewOpen ? (
              <div className="nx-icf-save-row">
                <input
                  className="nx-icf-input nx-icf-save-input"
                  type="text"
                  placeholder="View name…"
                  value={saveViewName}
                  autoFocus
                  onChange={(e) => setSaveViewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveView(); if (e.key === 'Escape') setSaveViewOpen(false) }}
                />
                <button type="button" className="nx-icf-btn-secondary" onClick={handleSaveView} disabled={!saveViewName.trim()}>Save</button>
                <button type="button" className="nx-icf-btn-ghost" onClick={() => setSaveViewOpen(false)}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="nx-icf-btn-secondary" onClick={() => setSaveViewOpen(true)}>Save View</button>
            )}
            <button type="button" className="nx-icf-btn-primary" onClick={handleApply} disabled={applying}>
              {applying ? 'Applying…' : `Apply${activeCount > 0 ? ` (${activeCount})` : ''}`}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  )
}