import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { InboxAdvancedFilters, InboxViewSelectValue, InboxStageSelectValue } from '../inbox-ui-helpers'
import { viewOptions } from '../inbox-ui-helpers'
import { sellerStageOptions } from '../status-visuals'
import type { AdvancedFilterOptions } from './InboxSidebar'

interface AdvancedFiltersPopoverProps {
  open: boolean
  stageFilter: InboxStageSelectValue
  setStageFilter: (filter: InboxStageSelectValue) => void
  viewFilter: InboxViewSelectValue
  setViewFilter: (filter: InboxViewSelectValue) => void
  advancedFilters: InboxAdvancedFilters
  onAdvancedFiltersChange: (filters: InboxAdvancedFilters) => void
  advancedFilterOptions: AdvancedFilterOptions
  viewCounts: Record<string, number | string | null | undefined>
  onReset: () => void
  onClose: () => void
  onApply?: () => void
}

interface LocalState {
  view: InboxViewSelectValue
  stage: InboxStageSelectValue
  advanced: InboxAdvancedFilters
}

interface SavedView {
  id: string
  name: string
  state: LocalState
}

type FilterTab = 'conversation' | 'property_owner' | 'deal_priority'

const SAVED_VIEWS_KEY = 'nx_inbox_saved_views'

const QUICK_SEGMENTS: Array<{ id: string; label: string; apply: (s: LocalState) => LocalState }> = [
  { id: 'new_replies', label: 'New Replies', apply: (s) => ({ ...s, view: 'new_replies' }) },
  { id: 'needs_review', label: 'Needs Review', apply: (s) => ({ ...s, view: 'needs_review' }) },
  { id: 'hot_leads', label: 'Hot Leads', apply: (s) => ({ ...s, view: 'hot_leads' }) },
  { id: 'cold_follow_up', label: 'Cold Follow-Ups', apply: (s) => ({ ...s, view: 'cold_no_response' }) },
  { id: 'high_equity', label: 'High Equity', apply: (s) => ({ ...s, advanced: { ...s.advanced, equityPercentMin: 40 } }) },
  { id: 'cash_offer_ready', label: 'Cash Offer Ready', apply: (s) => ({ ...s, advanced: { ...s.advanced, highEquity: true } }) },
  { id: 'bad_data', label: 'Bad Data', apply: (s) => ({ ...s, view: 'wrong_number' as InboxViewSelectValue }) },
  { id: 'suppressed', label: 'Suppressed', apply: (s) => ({ ...s, view: 'suppressed' }) },
]

const DEFAULT_ADVANCED: InboxAdvancedFilters = { outOfStateOwner: 'all' }

const num = (v: number | undefined) => (v === undefined ? '' : String(v))
const asNum = (v: string): number | undefined => { const n = Number(v); return v.trim() && Number.isFinite(n) ? n : undefined }

function loadSavedViews(): SavedView[] {
  try { return JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) ?? '[]') } catch { return [] }
}
function persistSavedViews(views: SavedView[]) {
  try { localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views)) } catch { /* ignore */ }
}

function buildActiveChips(
  state: LocalState,
  vCounts: Record<string, number | string | null | undefined>,
): Array<{ key: string; label: string; clear: () => LocalState }> {
  const chips: Array<{ key: string; label: string; clear: () => LocalState }> = []
  const af = state.advanced

  if (state.view !== 'all_conversations') {
    const label = viewOptions.find((o) => o.value === state.view)?.label ?? state.view
    const count = vCounts[state.view]
    chips.push({ key: 'view', label: `Inbox: ${label}${count != null ? ` (${count})` : ''}`, clear: () => ({ ...state, view: 'all_conversations' }) })
  }
  if (state.stage !== 'all_stages') {
    const label = sellerStageOptions.find((o) => o.value === state.stage)?.label ?? state.stage
    chips.push({ key: 'stage', label: `Stage: ${label}`, clear: () => ({ ...state, stage: 'all_stages' }) })
  }
  if (af.leadTemperature) chips.push({ key: 'temp', label: `Temp: ${af.leadTemperature}`, clear: () => ({ ...state, advanced: { ...af, leadTemperature: undefined } }) })
  if (af.lastMessageDirection) chips.push({ key: 'dir', label: `Dir: ${af.lastMessageDirection}`, clear: () => ({ ...state, advanced: { ...af, lastMessageDirection: undefined } }) })
  if (af.hasSellerReply) chips.push({ key: 'reply', label: `Has Reply: ${af.hasSellerReply}`, clear: () => ({ ...state, advanced: { ...af, hasSellerReply: undefined } }) })
  if (af.language) chips.push({ key: 'lang', label: `Lang: ${af.language}`, clear: () => ({ ...state, advanced: { ...af, language: undefined } }) })
  if (af.assignedAgent) chips.push({ key: 'agent', label: `Agent: ${af.assignedAgent}`, clear: () => ({ ...state, advanced: { ...af, assignedAgent: undefined } }) })
  if (af.deliveryStatus) chips.push({ key: 'delivery', label: `Delivery: ${af.deliveryStatus}`, clear: () => ({ ...state, advanced: { ...af, deliveryStatus: undefined } }) })
  if (af.market) chips.push({ key: 'market', label: `Market: ${af.market}`, clear: () => ({ ...state, advanced: { ...af, market: undefined } }) })
  if (af.state) chips.push({ key: 'state', label: `State: ${af.state}`, clear: () => ({ ...state, advanced: { ...af, state: undefined } }) })
  if (af.propertyType) chips.push({ key: 'ptype', label: `Type: ${af.propertyType}`, clear: () => ({ ...state, advanced: { ...af, propertyType: undefined } }) })
  if (af.ownerType) chips.push({ key: 'otype', label: `Owner: ${af.ownerType}`, clear: () => ({ ...state, advanced: { ...af, ownerType: undefined } }) })
  if (af.outOfStateOwner && af.outOfStateOwner !== 'all') chips.push({ key: 'oos', label: `OOS: ${af.outOfStateOwner}`, clear: () => ({ ...state, advanced: { ...af, outOfStateOwner: 'all' } }) })
  if (af.corporateMatch) chips.push({ key: 'corp', label: `Corp: ${af.corporateMatch}`, clear: () => ({ ...state, advanced: { ...af, corporateMatch: undefined } }) })
  if (af.bedsMin != null) chips.push({ key: 'beds', label: `Beds ≥ ${af.bedsMin}`, clear: () => ({ ...state, advanced: { ...af, bedsMin: undefined } }) })
  if (af.bathsMin != null) chips.push({ key: 'baths', label: `Baths ≥ ${af.bathsMin}`, clear: () => ({ ...state, advanced: { ...af, bathsMin: undefined } }) })
  if (af.occupancy) chips.push({ key: 'occ', label: `Occ: ${af.occupancy}`, clear: () => ({ ...state, advanced: { ...af, occupancy: undefined } }) })
  if (af.motivationMin != null) chips.push({ key: 'motiv', label: `Motivation ≥ ${af.motivationMin}`, clear: () => ({ ...state, advanced: { ...af, motivationMin: undefined } }) })
  if (af.finalAcquisitionScoreMin != null) chips.push({ key: 'acqheat', label: `Acq Heat ≥ ${af.finalAcquisitionScoreMin}`, clear: () => ({ ...state, advanced: { ...af, finalAcquisitionScoreMin: undefined } }) })
  if (af.equityPercentMin != null) chips.push({ key: 'equity', label: `Equity ≥ ${af.equityPercentMin}%`, clear: () => ({ ...state, advanced: { ...af, equityPercentMin: undefined } }) })
  if (af.estimatedValueMin != null) chips.push({ key: 'valmin', label: `Value ≥ $${af.estimatedValueMin.toLocaleString()}`, clear: () => ({ ...state, advanced: { ...af, estimatedValueMin: undefined } }) })
  if (af.estimatedValueMax != null) chips.push({ key: 'valmax', label: `Value ≤ $${af.estimatedValueMax.toLocaleString()}`, clear: () => ({ ...state, advanced: { ...af, estimatedValueMax: undefined } }) })
  if (af.cashOfferMin != null) chips.push({ key: 'offermin', label: `Offer ≥ $${af.cashOfferMin.toLocaleString()}`, clear: () => ({ ...state, advanced: { ...af, cashOfferMin: undefined } }) })
  if (af.cashOfferMax != null) chips.push({ key: 'offermax', label: `Offer ≤ $${af.cashOfferMax.toLocaleString()}`, clear: () => ({ ...state, advanced: { ...af, cashOfferMax: undefined } }) })
  if (af.buyerDemandScoreMin != null) chips.push({ key: 'demand', label: `Demand ≥ ${af.buyerDemandScoreMin}`, clear: () => ({ ...state, advanced: { ...af, buyerDemandScoreMin: undefined } }) })
  if (af.arvConfidenceMin != null) chips.push({ key: 'arv', label: `ARV Conf ≥ ${af.arvConfidenceMin}%`, clear: () => ({ ...state, advanced: { ...af, arvConfidenceMin: undefined } }) })
  if (af.highEquity) chips.push({ key: 'highequity', label: 'High Equity', clear: () => ({ ...state, advanced: { ...af, highEquity: undefined } }) })
  if (af.activityDateFrom) chips.push({ key: 'afrom', label: `From: ${af.activityDateFrom}`, clear: () => ({ ...state, advanced: { ...af, activityDateFrom: undefined } }) })
  if (af.activityDateTo) chips.push({ key: 'ato', label: `To: ${af.activityDateTo}`, clear: () => ({ ...state, advanced: { ...af, activityDateTo: undefined } }) })
  if (af.touchCountMin != null) chips.push({ key: 'touchmin', label: `Touches ≥ ${af.touchCountMin}`, clear: () => ({ ...state, advanced: { ...af, touchCountMin: undefined } }) })
  if (af.campaignName) chips.push({ key: 'campaign', label: `Campaign: ${af.campaignName}`, clear: () => ({ ...state, advanced: { ...af, campaignName: undefined } }) })
  if (af.suppressionReason) chips.push({ key: 'suppress', label: `Suppression: ${af.suppressionReason}`, clear: () => ({ ...state, advanced: { ...af, suppressionReason: undefined } }) })
  return chips
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
  const [local, setLocal] = useState<LocalState>({ view: viewFilter, stage: stageFilter, advanced: advancedFilters })
  const [activeTab, setActiveTab] = useState<FilterTab>('conversation')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [savedViews, setSavedViews] = useState<SavedView[]>(loadSavedViews)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [saveViewName, setSaveViewName] = useState('')
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (open) {
      setLocal({ view: viewFilter, stage: stageFilter, advanced: advancedFilters })
    }
  }, [open, viewFilter, stageFilter, advancedFilters])

  const patchAdv = useCallback((patch: Partial<InboxAdvancedFilters>) => {
    setLocal((s) => ({ ...s, advanced: { ...s.advanced, ...patch } }))
  }, [])

  const handleApply = useCallback(() => {
    setApplying(true)
    setViewFilter(local.view)
    setStageFilter(local.stage)
    onAdvancedFiltersChange(local.advanced)
    onApply?.()
    if (import.meta.env.DEV) {
      console.log('[InboxFilters] Applied:', {
        preset: null,
        conversation: {
          inbox_status: local.view,
          seller_stage: local.stage,
          temperature: local.advanced.leadTemperature,
          direction: local.advanced.lastMessageDirection,
          has_seller_reply: local.advanced.hasSellerReply,
          language: local.advanced.language,
          assigned_agent: local.advanced.assignedAgent,
          delivery_status: local.advanced.deliveryStatus,
        },
        property_owner: {
          market: local.advanced.market,
          state: local.advanced.state,
          property_type: local.advanced.propertyType,
          owner_type: local.advanced.ownerType,
          out_of_state_owner: local.advanced.outOfStateOwner,
          corporate_owner: local.advanced.corporateMatch,
          beds_min: local.advanced.bedsMin,
          baths_min: local.advanced.bathsMin,
          occupancy: local.advanced.occupancy,
        },
        deal_priority: {
          motivation_score_min: local.advanced.motivationMin,
          acquisition_heat_min: local.advanced.finalAcquisitionScoreMin,
          equity_percent_min: local.advanced.equityPercentMin,
          estimated_value_min: local.advanced.estimatedValueMin,
          estimated_value_max: local.advanced.estimatedValueMax,
          cash_offer_min: local.advanced.cashOfferMin,
          cash_offer_max: local.advanced.cashOfferMax,
          buyer_demand_min: local.advanced.buyerDemandScoreMin,
          arv_confidence_min: local.advanced.arvConfidenceMin,
          valuation_snapshot: local.advanced.valuationSnapshotExists,
        },
        advanced: {
          activity_from: local.advanced.activityDateFrom,
          activity_to: local.advanced.activityDateTo,
          days_since_last_contact: local.advanced.daysSinceLastContactMin,
          touch_count_min: local.advanced.touchCountMin,
          touch_count_max: local.advanced.touchCountMax,
          campaign_name: local.advanced.campaignName,
          template_use_case: local.advanced.templateUseCase,
          suppression_reason: local.advanced.suppressionReason,
          routing_market: local.advanced.selectedTextGridMarket,
          custom_tags: local.advanced.tagsInclude,
        },
      })
    }
    setTimeout(() => { setApplying(false); onClose() }, 120)
  }, [local, onAdvancedFiltersChange, onApply, onClose, setStageFilter, setViewFilter])

  const handleReset = useCallback(() => {
    const fresh = { view: 'priority' as InboxViewSelectValue, stage: 'all_stages' as InboxStageSelectValue, advanced: DEFAULT_ADVANCED }
    setLocal(fresh)
    onReset()
  }, [onReset])

  const handleSaveView = useCallback(() => {
    if (!saveViewName.trim()) return
    const view: SavedView = { id: Date.now().toString(), name: saveViewName.trim(), state: local }
    const next = [...savedViews, view]
    setSavedViews(next)
    persistSavedViews(next)
    setSaveViewName('')
    setSaveViewOpen(false)
  }, [local, saveViewName, savedViews])

  const handleDeleteSavedView = useCallback((id: string) => {
    const next = savedViews.filter((v) => v.id !== id)
    setSavedViews(next)
    persistSavedViews(next)
  }, [savedViews])

  const handleLoadSavedView = useCallback((view: SavedView) => {
    setLocal(view.state)
  }, [])

  const applySegment = useCallback((seg: typeof QUICK_SEGMENTS[0]) => {
    const next = seg.apply(local)
    setLocal(next)
  }, [local])

  const chips = buildActiveChips(local, viewCounts)
  const activeFilterCount = chips.length

  if (!open) return null

  const opts = advancedFilterOptions

  return createPortal(
    <div className="nx-filter-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="nx-icf-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Inbox Command Filters"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ── HEADER ── */}
        <header className="nx-icf-header">
          <div className="nx-icf-header-left">
            <strong>Inbox Command Filters</strong>
            <span>Build high-signal seller lists from live Supabase data.</span>
          </div>
          <div className="nx-icf-header-right">
            {activeFilterCount > 0 && (
              <span className="nx-icf-count-badge">{activeFilterCount} active</span>
            )}
            <button type="button" className="nx-icf-close" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        </header>

        {/* ── COMMAND BAR ── */}
        <div className="nx-icf-cmdbar">
          <Icon name="search" />
          <input
            className="nx-icf-cmdbar-input"
            type="text"
            placeholder='Show hot inbound replies from Phoenix with equity over 40%'
            readOnly
            title="AI filter parsing coming soon"
          />
          <span className="nx-icf-cmdbar-hint">AI</span>
        </div>

        {/* ── QUICK SEGMENTS ── */}
        <div className="nx-icf-segments">
          {QUICK_SEGMENTS.map((seg) => {
            const applied = seg.apply(local)
            const isActive = applied.view === local.view && JSON.stringify(applied.advanced) === JSON.stringify(local.advanced)
            return (
              <button
                key={seg.id}
                type="button"
                className={`nx-icf-segment${isActive ? ' is-active' : ''}`}
                onClick={() => applySegment(seg)}
              >
                {seg.label}
              </button>
            )
          })}
        </div>

        {/* ── ACTIVE FILTER CHIPS ── */}
        {chips.length > 0 && (
          <div className="nx-icf-chips">
            {chips.map((chip) => (
              <span key={chip.key} className="nx-icf-chip">
                {chip.label}
                <button type="button" onClick={() => setLocal(chip.clear())} aria-label={`Remove ${chip.label}`}>
                  <Icon name="x" />
                </button>
              </span>
            ))}
            <button type="button" className="nx-icf-chip-clear" onClick={handleReset}>Clear All</button>
          </div>
        )}

        {/* ── TABS ── */}
        <div className="nx-icf-tabs">
          {(['conversation', 'property_owner', 'deal_priority'] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={`nx-icf-tab${activeTab === tab ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'conversation' && 'Conversation'}
              {tab === 'property_owner' && 'Property & Owner'}
              {tab === 'deal_priority' && 'Deal Priority'}
            </button>
          ))}
        </div>

        {/* ── TAB CONTENT ── */}
        <div className="nx-icf-body">

          {activeTab === 'conversation' && (
            <div className="nx-icf-grid">
              <F label="Inbox Status">
                <Sel value={local.view} onChange={(v) => setLocal((s) => ({ ...s, view: v as InboxViewSelectValue }))}>
                  {viewOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}{viewCounts[o.value] != null ? ` (${viewCounts[o.value]})` : ''}
                    </option>
                  ))}
                </Sel>
              </F>
              <F label="Seller Stage">
                <Sel value={local.stage} onChange={(v) => setLocal((s) => ({ ...s, stage: v as InboxStageSelectValue }))}>
                  <option value="all_stages">Any Stage</option>
                  {sellerStageOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Sel>
              </F>
              <F label="Temperature">
                <Sel value={local.advanced.leadTemperature ?? ''} onChange={(v) => patchAdv({ leadTemperature: v || undefined })}>
                  <option value="">Any</option>
                  <option value="hot">Hot</option>
                  <option value="warm">Warm</option>
                  <option value="cold">Cold</option>
                </Sel>
              </F>
              <F label="Direction">
                <Sel value={local.advanced.lastMessageDirection ?? ''} onChange={(v) => patchAdv({ lastMessageDirection: v || undefined })}>
                  <option value="">Any</option>
                  <option value="inbound">Inbound</option>
                  <option value="outbound">Outbound</option>
                </Sel>
              </F>
              <F label="Has Seller Reply">
                <Sel value={local.advanced.hasSellerReply ?? ''} onChange={(v) => patchAdv({ hasSellerReply: (v as InboxAdvancedFilters['hasSellerReply']) || undefined })}>
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Sel>
              </F>
              <F label="Language">
                <Sel value={local.advanced.language ?? ''} onChange={(v) => patchAdv({ language: v || undefined })}>
                  <option value="">Any</option>
                  {opts.languages.map((l) => <option key={l} value={l}>{l}</option>)}
                </Sel>
              </F>
              <F label="Assigned Agent">
                <Sel value={local.advanced.assignedAgent ?? ''} onChange={(v) => patchAdv({ assignedAgent: v || undefined })}>
                  <option value="">Any</option>
                  {opts.assignedAgents.map((a) => <option key={a} value={a}>{a}</option>)}
                </Sel>
              </F>
              <F label="Delivery Status">
                <Sel value={local.advanced.deliveryStatus ?? ''} onChange={(v) => patchAdv({ deliveryStatus: v || undefined })}>
                  <option value="">Any</option>
                  <option value="delivered">Delivered</option>
                  <option value="failed">Failed</option>
                  <option value="pending">Pending</option>
                  <option value="undelivered">Undelivered</option>
                </Sel>
              </F>
            </div>
          )}

          {activeTab === 'property_owner' && (
            <div className="nx-icf-grid">
              <F label="Market">
                <Sel value={local.advanced.market ?? ''} onChange={(v) => patchAdv({ market: v || undefined })}>
                  <option value="">Any</option>
                  {opts.markets.map((m) => <option key={m} value={m}>{m}</option>)}
                </Sel>
              </F>
              <F label="State">
                <Sel value={local.advanced.state ?? ''} onChange={(v) => patchAdv({ state: v || undefined })}>
                  <option value="">Any</option>
                  {opts.states.map((s) => <option key={s} value={s}>{s}</option>)}
                </Sel>
              </F>
              <F label="Property Type">
                <Sel value={local.advanced.propertyType ?? ''} onChange={(v) => patchAdv({ propertyType: v || undefined })}>
                  <option value="">Any</option>
                  {opts.propertyTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                </Sel>
              </F>
              <F label="Owner Type">
                <Sel value={local.advanced.ownerType ?? ''} onChange={(v) => patchAdv({ ownerType: v || undefined })}>
                  <option value="">Any</option>
                  {opts.ownerTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                </Sel>
              </F>
              <F label="Out of State Owner">
                <Sel value={local.advanced.outOfStateOwner ?? 'all'} onChange={(v) => patchAdv({ outOfStateOwner: v as InboxAdvancedFilters['outOfStateOwner'] })}>
                  <option value="all">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Sel>
              </F>
              <F label="Corporate Owner">
                <Sel value={local.advanced.corporateMatch ?? ''} onChange={(v) => patchAdv({ corporateMatch: (v as InboxAdvancedFilters['corporateMatch']) || undefined })}>
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Sel>
              </F>
              <F label="Occupancy">
                <Sel value={local.advanced.occupancy ?? ''} onChange={(v) => patchAdv({ occupancy: v || undefined })}>
                  <option value="">Any</option>
                  {opts.occupancies.map((o) => <option key={o} value={o}>{o}</option>)}
                </Sel>
              </F>
              <F label="Beds Min">
                <Num value={local.advanced.bedsMin} onChange={(v) => patchAdv({ bedsMin: v })} placeholder="Any" />
              </F>
              <F label="Baths Min">
                <Num value={local.advanced.bathsMin} onChange={(v) => patchAdv({ bathsMin: v })} placeholder="Any" />
              </F>
            </div>
          )}

          {activeTab === 'deal_priority' && (
            <div className="nx-icf-grid">
              <F label="Motivation Score Min">
                <Num value={local.advanced.motivationMin} onChange={(v) => patchAdv({ motivationMin: v })} placeholder="0–100" />
              </F>
              <F label="Acquisition Heat Min">
                <Num value={local.advanced.finalAcquisitionScoreMin} onChange={(v) => patchAdv({ finalAcquisitionScoreMin: v })} placeholder="0–100" />
              </F>
              <F label="Equity % Min">
                <Num value={local.advanced.equityPercentMin} onChange={(v) => patchAdv({ equityPercentMin: v })} placeholder="e.g. 40" />
              </F>
              <F label="ARV Confidence Min">
                <Num value={local.advanced.arvConfidenceMin} onChange={(v) => patchAdv({ arvConfidenceMin: v })} placeholder="0–100" />
              </F>
              <F label="Est. Value Min">
                <Num value={local.advanced.estimatedValueMin} onChange={(v) => patchAdv({ estimatedValueMin: v })} placeholder="e.g. 100000" />
              </F>
              <F label="Est. Value Max">
                <Num value={local.advanced.estimatedValueMax} onChange={(v) => patchAdv({ estimatedValueMax: v })} placeholder="e.g. 500000" />
              </F>
              <F label="Cash Offer Min">
                <Num value={local.advanced.cashOfferMin} onChange={(v) => patchAdv({ cashOfferMin: v })} placeholder="e.g. 50000" />
              </F>
              <F label="Cash Offer Max">
                <Num value={local.advanced.cashOfferMax} onChange={(v) => patchAdv({ cashOfferMax: v })} placeholder="e.g. 300000" />
              </F>
              <F label="Buyer Demand Min">
                <Num value={local.advanced.buyerDemandScoreMin} onChange={(v) => patchAdv({ buyerDemandScoreMin: v })} placeholder="0–100" />
              </F>
              <F label="Snapshot Status">
                <Sel value={local.advanced.valuationSnapshotExists ?? ''} onChange={(v) => patchAdv({ valuationSnapshotExists: (v as InboxAdvancedFilters['valuationSnapshotExists']) || undefined })}>
                  <option value="">Any</option>
                  <option value="yes">Snapshot Exists</option>
                  <option value="no">No Snapshot</option>
                </Sel>
              </F>
              <div className="nx-icf-toggles">
                <button
                  type="button"
                  className={`nx-icf-toggle${local.advanced.highEquity ? ' is-on' : ''}`}
                  onClick={() => patchAdv({ highEquity: local.advanced.highEquity ? undefined : true })}
                >High Equity</button>
                <button
                  type="button"
                  className={`nx-icf-toggle${local.advanced.freeAndClear ? ' is-on' : ''}`}
                  onClick={() => patchAdv({ freeAndClear: local.advanced.freeAndClear ? undefined : true })}
                >Free &amp; Clear</button>
                <button
                  type="button"
                  className={`nx-icf-toggle${local.advanced.bigSpreadPotential ? ' is-on' : ''}`}
                  onClick={() => patchAdv({ bigSpreadPotential: local.advanced.bigSpreadPotential ? undefined : true })}
                >Big Spread</button>
              </div>
            </div>
          )}

          {/* ── ADVANCED ACCORDION ── */}
          <div className="nx-icf-advanced">
            <button
              type="button"
              className="nx-icf-advanced-toggle"
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
            >
              <span>Advanced</span>
              <Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} />
            </button>
            {advancedOpen && (
              <div className="nx-icf-advanced-body">
                <div className="nx-icf-grid nx-icf-grid--sm">
                  <F label="Activity From">
                    <input className="nx-icf-input" type="date" value={local.advanced.activityDateFrom ?? ''} onChange={(e) => patchAdv({ activityDateFrom: e.target.value || undefined })} />
                  </F>
                  <F label="Activity To">
                    <input className="nx-icf-input" type="date" value={local.advanced.activityDateTo ?? ''} onChange={(e) => patchAdv({ activityDateTo: e.target.value || undefined })} />
                  </F>
                  <F label="Days Since Last Contact">
                    <Num value={local.advanced.daysSinceLastContactMin} onChange={(v) => patchAdv({ daysSinceLastContactMin: v })} />
                  </F>
                  <F label="Touch Count Min">
                    <Num value={local.advanced.touchCountMin} onChange={(v) => patchAdv({ touchCountMin: v })} />
                  </F>
                  <F label="Touch Count Max">
                    <Num value={local.advanced.touchCountMax} onChange={(v) => patchAdv({ touchCountMax: v })} />
                  </F>
                  <F label="Campaign Name">
                    <input className="nx-icf-input" type="text" value={local.advanced.campaignName ?? ''} placeholder="Any" onChange={(e) => patchAdv({ campaignName: e.target.value || undefined })} />
                  </F>
                  <F label="Template Use Case">
                    <input className="nx-icf-input" type="text" value={local.advanced.templateUseCase ?? ''} placeholder="Any" onChange={(e) => patchAdv({ templateUseCase: e.target.value || undefined })} />
                  </F>
                  <F label="Suppression Reason">
                    <input className="nx-icf-input" type="text" value={local.advanced.suppressionReason ?? ''} placeholder="Any" onChange={(e) => patchAdv({ suppressionReason: e.target.value || undefined })} />
                  </F>
                  <F label="Routing Market">
                    <input className="nx-icf-input" type="text" value={local.advanced.selectedTextGridMarket ?? ''} placeholder="Any" onChange={(e) => patchAdv({ selectedTextGridMarket: e.target.value || undefined })} />
                  </F>
                  <F label="Custom Tags (comma-sep)">
                    <input
                      className="nx-icf-input"
                      type="text"
                      value={(local.advanced.tagsInclude ?? []).join(', ')}
                      placeholder="tag1, tag2"
                      onChange={(e) => {
                        const tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean)
                        patchAdv({ tagsInclude: tags.length ? tags : undefined })
                      }}
                    />
                  </F>
                </div>
              </div>
            )}
          </div>

          {/* ── SAVED VIEWS ── */}
          {savedViews.length > 0 && (
            <div className="nx-icf-saved-views">
              <span className="nx-icf-saved-label">Saved Views</span>
              <div className="nx-icf-saved-list">
                {savedViews.map((sv) => (
                  <div key={sv.id} className="nx-icf-saved-item">
                    <button type="button" className="nx-icf-saved-load" onClick={() => handleLoadSavedView(sv)}>
                      {sv.name}
                    </button>
                    <button type="button" className="nx-icf-saved-del" onClick={() => handleDeleteSavedView(sv.id)} aria-label={`Delete ${sv.name}`}>
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* ── FOOTER ── */}
        <footer className="nx-icf-footer">
          <button type="button" className="nx-icf-btn-ghost" onClick={handleReset}>Reset</button>
          <div className="nx-icf-footer-right">
            {saveViewOpen ? (
              <div className="nx-icf-save-row">
                <input
                  className="nx-icf-input nx-icf-save-input"
                  type="text"
                  placeholder="View name..."
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
            <button
              type="button"
              className="nx-icf-btn-primary"
              onClick={handleApply}
              disabled={applying}
            >
              {applying ? 'Applying…' : `Apply Filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}`}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
