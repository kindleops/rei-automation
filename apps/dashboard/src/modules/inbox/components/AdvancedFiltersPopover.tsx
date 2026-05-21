import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { InboxAdvancedFilters } from '../inbox-ui-helpers'
import { type InboxViewSelectValue, type InboxStageSelectValue, viewOptions } from '../inbox-ui-helpers'
import { sellerStageOptions } from '../status-visuals'
import type { AdvancedFilterOptions } from './InboxSidebar'

interface AdvancedFiltersPopoverProps {
  open: boolean
  stageFilter: InboxStageSelectValue
  setStageFilter: (filter: InboxStageSelectValue) => void
  viewFilter: InboxViewSelectValue
  setViewFilter: (filter: InboxViewSelectValue) => void
  advancedFilters: InboxAdvancedFilters
  onAdvancedFiltersChange: (patch: Partial<InboxAdvancedFilters>) => void
  advancedFilterOptions: AdvancedFilterOptions
  viewCounts: Record<string, number | string | null | undefined>
  onReset: () => void
  onClose: () => void
  onApply?: () => void
}

const numberInput = (value: number | undefined): string => (value === undefined ? '' : String(value))
const asNumber = (value: string): number | undefined => {
  if (!value.trim()) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

const selectOptions = (options: string[]) => (
  <>
    <option value="">Any</option>
    {options.map((option) => (
      <option key={option} value={option}>{option}</option>
    ))}
  </>
)

const FieldRow = ({ label, children, unwired }: { label: string; children: React.ReactNode; unwired?: boolean }) => (
  <label className={`nx-filter-field ${unwired ? 'is-unwired' : ''}`} title={unwired ? 'Not wired yet' : ''}>
    <span>{label}</span>
    <div className="nx-filter-field-input" style={{ pointerEvents: unwired ? 'none' : 'auto', opacity: unwired ? 0.5 : 1 }}>
      {children}
    </div>
  </label>
)

export const AdvancedFiltersPopover = ({
  open,
  stageFilter,
  setStageFilter,
  viewFilter,
  setViewFilter,
  advancedFilters,
  onAdvancedFiltersChange,
  advancedFilterOptions,
  viewCounts,
  onReset,
  onClose,
  onApply,
}: AdvancedFiltersPopoverProps) => {
  const [activeCategory, setActiveCategory] = useState<string>('Workflow')
  
  const patch = useCallback((next: Partial<InboxAdvancedFilters>) => {
    onAdvancedFiltersChange(next)
  }, [onAdvancedFiltersChange])

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  if (!open) return null

  // Categories mapping
  const categories = [
    { id: 'Workflow', icon: 'activity', count: (viewFilter !== 'all_conversations' ? 1 : 0) + (stageFilter !== 'all_stages' ? 1 : 0) },
    { id: 'Conversation', icon: 'message', count: [advancedFilters.latestIntent, advancedFilters.language].filter(Boolean).length },
    { id: 'Property', icon: 'home', count: [advancedFilters.propertyType, advancedFilters.bedsMin, advancedFilters.bathsMin].filter(Boolean).length },
    { id: 'Owner', icon: 'user', count: [advancedFilters.ownerType, advancedFilters.outOfStateOwner].filter(Boolean).length },
    { id: 'Financials', icon: 'dollar-sign', count: [advancedFilters.estimatedValueMin, advancedFilters.cashOfferMin].filter(Boolean).length },
    { id: 'Motivation / Distress', icon: 'alert', count: [advancedFilters.motivationMin].filter(Boolean).length },
    { id: 'AI Intelligence', icon: 'brain', count: [advancedFilters.aiScoreMin, advancedFilters.persona].filter(Boolean).length },
    { id: 'Campaign / Messaging', icon: 'send', count: [advancedFilters.assignedAgent].filter(Boolean).length },
    { id: 'Market / Routing', icon: 'map', count: [advancedFilters.market, advancedFilters.state, advancedFilters.zip].filter(Boolean).length },
    { id: 'Timeline', icon: 'clock', count: [advancedFilters.activityDateFrom, advancedFilters.activityDateTo].filter(Boolean).length },
    { id: 'Custom', icon: 'settings', count: 0 },
  ]

  return createPortal(
    <div className="nx-filter-overlay" role="presentation" onMouseDown={handleClose}>
      <section
        className="nx-cmd-filter-modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="nx-cmd-filter-modal__header">
          <div className="nx-cmd-filter-modal__titles">
            <strong>Command Filters</strong>
            <span>Build high-signal seller lists from live Supabase data.</span>
          </div>
          <button type="button" onClick={handleClose} aria-label="Close filters">
            <Icon name="close" />
          </button>
        </header>

        <div className="nx-cmd-filter-modal__body">
          <nav className="nx-cmd-filter-modal__nav">
            {categories.map(cat => (
              <button 
                key={cat.id} 
                className={`nx-cmd-filter-nav-item ${activeCategory === cat.id ? 'is-active' : ''}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                <div className="nx-cmd-filter-nav-left">
                  <Icon name={cat.icon as any} />
                  <span>{cat.id}</span>
                </div>
                {cat.count > 0 && <span className="nx-cmd-filter-badge">{cat.count}</span>}
              </button>
            ))}
          </nav>
          
          <div className="nx-cmd-filter-modal__content">
            {/* Active Chips Area */}
            <div className="nx-cmd-filter-chips">
              {viewFilter !== 'all_conversations' && (
                <span className="nx-cmd-chip">Inbox: {viewOptions.find(o => o.value === viewFilter)?.label || viewFilter} <button onClick={() => setViewFilter('all_conversations')}><Icon name="x"/></button></span>
              )}
              {stageFilter !== 'all_stages' && (
                <span className="nx-cmd-chip">Stage: {sellerStageOptions.find(o => o.value === stageFilter)?.label || stageFilter} <button onClick={() => setStageFilter('all_stages')}><Icon name="x"/></button></span>
              )}
              {advancedFilters.market && (
                <span className="nx-cmd-chip">Market: {advancedFilters.market} <button onClick={() => patch({ market: undefined })}><Icon name="x"/></button></span>
              )}
              {/* Could map over all active filters here eventually */}
              {(viewFilter !== 'all_conversations' || stageFilter !== 'all_stages' || Object.keys(advancedFilters).length > 0) && (
                <button className="nx-cmd-chip-clear" onClick={onReset}>Clear All</button>
              )}
            </div>

            <div className="nx-cmd-filter-scroll-area">
              {activeCategory === 'Workflow' && (
                <div className="nx-cmd-filter-section">
                  <h3>Workflow</h3>
                  <FieldRow label="Inbox Status">
                    <select value={viewFilter} onChange={(event) => setViewFilter(event.target.value as InboxViewSelectValue)}>
                      {viewOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label} ({viewCounts[option.value] ?? '—'})</option>
                      ))}
                    </select>
                  </FieldRow>
                  <FieldRow label="Seller Stage">
                    <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value as InboxStageSelectValue)}>
                      <option value="all_stages">Any Stage</option>
                      {sellerStageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </FieldRow>
                  <FieldRow label="Review Status" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="Lead Temperature" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="Queue Status" unwired><select><option>Any</option></select></FieldRow>
                </div>
              )}

              {activeCategory === 'Conversation' && (
                <div className="nx-cmd-filter-section">
                  <h3>Conversation</h3>
                  <FieldRow label="Language">
                    <select value={advancedFilters.language ?? ''} onChange={(event) => patch({ language: event.target.value || undefined })}>
                      {selectOptions(advancedFilterOptions.languages)}
                    </select>
                  </FieldRow>
                  <FieldRow label="Latest Intent" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="Last Message Direction" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="Has Seller Reply" unwired><select><option>Any</option></select></FieldRow>
                </div>
              )}

              {activeCategory === 'Property' && (
                <div className="nx-cmd-filter-section">
                  <h3>Property</h3>
                  <FieldRow label="Property Type">
                    <select value={advancedFilters.propertyType ?? ''} onChange={(event) => patch({ propertyType: event.target.value || undefined })}>
                      {selectOptions(advancedFilterOptions.propertyTypes)}
                    </select>
                  </FieldRow>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <FieldRow label="Beds Min"><input type="number" value={numberInput(advancedFilters.bedsMin)} onChange={(event) => patch({ bedsMin: asNumber(event.target.value) })} /></FieldRow>
                    <FieldRow label="Baths Min"><input type="number" value={numberInput(advancedFilters.bathsMin)} onChange={(event) => patch({ bathsMin: asNumber(event.target.value) })} /></FieldRow>
                  </div>
                  <FieldRow label="Property Tags" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="Property Condition" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="Occupancy" unwired><select><option>Any</option></select></FieldRow>
                </div>
              )}

              {activeCategory === 'Owner' && (
                <div className="nx-cmd-filter-section">
                  <h3>Owner</h3>
                  <FieldRow label="Owner Type">
                    <select value={advancedFilters.ownerType ?? ''} onChange={(event) => patch({ ownerType: event.target.value || undefined })}>
                      {selectOptions(advancedFilterOptions.ownerTypes)}
                    </select>
                  </FieldRow>
                  <FieldRow label="Out of State">
                    <select value={advancedFilters.outOfStateOwner ?? 'all'} onChange={(event) => patch({ outOfStateOwner: event.target.value as InboxAdvancedFilters['outOfStateOwner'] })}>
                      <option value="all">Any</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </FieldRow>
                  <FieldRow label="Owner Age Min"><input type="number" value={numberInput(advancedFilters.sellerAgeMin)} onChange={(event) => patch({ sellerAgeMin: asNumber(event.target.value) })} /></FieldRow>
                  <FieldRow label="Multiple Properties Owned" unwired><select><option>Any</option></select></FieldRow>
                </div>
              )}

              {activeCategory === 'Financials' && (
                <div className="nx-cmd-filter-section">
                  <h3>Financials</h3>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <FieldRow label="Est. Value Min"><input type="number" value={numberInput(advancedFilters.estimatedValueMin)} onChange={(event) => patch({ estimatedValueMin: asNumber(event.target.value) })} /></FieldRow>
                    <FieldRow label="Est. Value Max"><input type="number" value={numberInput(advancedFilters.estimatedValueMax)} onChange={(event) => patch({ estimatedValueMax: asNumber(event.target.value) })} /></FieldRow>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <FieldRow label="Cash Offer Min"><input type="number" value={numberInput(advancedFilters.cashOfferMin)} onChange={(event) => patch({ cashOfferMin: asNumber(event.target.value) })} /></FieldRow>
                    <FieldRow label="Cash Offer Max"><input type="number" value={numberInput(advancedFilters.cashOfferMax)} onChange={(event) => patch({ cashOfferMax: asNumber(event.target.value) })} /></FieldRow>
                  </div>
                  <FieldRow label="Quick Financial Toggles" unwired><div style={{ display: 'flex', gap: '8px' }}><button className="nx-tag">High Equity</button><button className="nx-tag">Underwater</button></div></FieldRow>
                </div>
              )}

              {activeCategory === 'Motivation / Distress' && (
                <div className="nx-cmd-filter-section">
                  <h3>Motivation / Distress</h3>
                  <FieldRow label="Motivation Score Min"><input type="number" value={numberInput(advancedFilters.motivationMin)} onChange={(event) => patch({ motivationMin: asNumber(event.target.value) })} /></FieldRow>
                  <FieldRow label="Seller Persona">
                    <select value={advancedFilters.persona ?? ''} onChange={(event) => patch({ persona: event.target.value || undefined })}>
                      {selectOptions(advancedFilterOptions.personas)}
                    </select>
                  </FieldRow>
                  <FieldRow label="Motivation Tags" unwired><select><option>Any</option></select></FieldRow>
                </div>
              )}

              {activeCategory === 'AI Intelligence' && (
                <div className="nx-cmd-filter-section">
                  <h3>AI Intelligence</h3>
                  <FieldRow label="AI Score Min"><input type="number" value={numberInput(advancedFilters.aiScoreMin)} onChange={(event) => patch({ aiScoreMin: asNumber(event.target.value) })} /></FieldRow>
                  <FieldRow label="AI Recommended Action" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="AI Risk Flag" unwired><select><option>Any</option></select></FieldRow>
                </div>
              )}

              {activeCategory === 'Campaign / Messaging' && (
                <div className="nx-cmd-filter-section">
                  <h3>Campaign / Messaging</h3>
                  <FieldRow label="Assigned Agent">
                    <select value={advancedFilters.assignedAgent ?? ''} onChange={(event) => patch({ assignedAgent: event.target.value || undefined })}>
                      {selectOptions(advancedFilterOptions.assignedAgents)}
                    </select>
                  </FieldRow>
                  <FieldRow label="Campaign Name" unwired><input placeholder="Search..." /></FieldRow>
                  <FieldRow label="Template Use Case" unwired><select><option>Any</option></select></FieldRow>
                  <FieldRow label="Suppression Reason" unwired><select><option>Any</option></select></FieldRow>
                </div>
              )}

              {activeCategory === 'Market / Routing' && (
                <div className="nx-cmd-filter-section">
                  <h3>Market / Routing</h3>
                  <FieldRow label="Market">
                    <select value={advancedFilters.market ?? ''} onChange={(event) => patch({ market: event.target.value || undefined })}>
                      {selectOptions(advancedFilterOptions.markets)}
                    </select>
                  </FieldRow>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <FieldRow label="State"><select value={advancedFilters.state ?? ''} onChange={(event) => patch({ state: event.target.value || undefined })}>{selectOptions(advancedFilterOptions.states)}</select></FieldRow>
                    <FieldRow label="Zip"><select value={advancedFilters.zip ?? ''} onChange={(event) => patch({ zip: event.target.value || undefined })}>{selectOptions(advancedFilterOptions.zips)}</select></FieldRow>
                  </div>
                  <FieldRow label="Best Contact Window"><input value={advancedFilters.bestContactWindow ?? ''} onChange={(event) => patch({ bestContactWindow: event.target.value || undefined })} placeholder="Morning, Evening..." /></FieldRow>
                </div>
              )}

              {activeCategory === 'Timeline' && (
                <div className="nx-cmd-filter-section">
                  <h3>Timeline</h3>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <FieldRow label="Activity From"><input type="date" value={advancedFilters.activityDateFrom ?? ''} onChange={(event) => patch({ activityDateFrom: event.target.value || undefined })} /></FieldRow>
                    <FieldRow label="Activity To"><input type="date" value={advancedFilters.activityDateTo ?? ''} onChange={(event) => patch({ activityDateTo: event.target.value || undefined })} /></FieldRow>
                  </div>
                  <FieldRow label="Days Since Last Contact" unwired><input type="number" /></FieldRow>
                  <FieldRow label="Touch Count Min" unwired><input type="number" /></FieldRow>
                </div>
              )}

              {activeCategory === 'Custom' && (
                <div className="nx-cmd-filter-section">
                  <h3>Custom Filters</h3>
                  <p style={{color: 'var(--nx-text-muted)', fontSize: '13px'}}>Custom property and thread tag filtering coming soon.</p>
                </div>
              )}

            </div>
          </div>
        </div>

        <footer className="nx-cmd-filter-modal__footer">
          <button type="button" onClick={onReset} className="nx-cmd-btn-secondary">Reset</button>
          <div className="nx-cmd-filter-modal__footer-actions">
            <button type="button" disabled title="Save View is not available yet" className="nx-cmd-btn-secondary">Save View</button>
            <button type="button" className="nx-cmd-btn-primary" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onApply?.(); handleClose(); }}>Apply Filters</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  )
}
