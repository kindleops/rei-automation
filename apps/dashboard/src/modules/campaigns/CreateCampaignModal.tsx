import { useState, useEffect } from 'react'
import type { CreateCampaignPayload } from './campaigns.types'
import { createCampaign } from './campaigns.adapter'
import { emitNotification } from '../../shared/NotificationToast'
import { 
  getCampaignFilterOptions, 
  previewCampaignTargets, 
  buildCampaignTargets, 
  queueCampaignBatch,
  type CampaignFilterOptionsResponse,
  type PreviewTargetsResponse
} from '../../lib/api/backendClient'

interface CreateCampaignModalProps {
  onClose: () => void
  onSuccess: (newCampaignId: string) => void
}

const DEFAULT_PAYLOAD: CreateCampaignPayload = {
  name: '',
  description: '',
  status: 'draft',
  campaign_type: 'outbound_sms',
  template_use_case: 'cold_outreach',
  stage_code: 'first_touch',
  target_filters: {
    states: [],
    markets: [],
    counties: [],
    cities: [],
    zip_codes: [],
    zip_clusters: [],
    timezones: [],
    sender_coverage_required: true,
    healthy_senders_only: true,

    owner_types: [],
    exclude_banks: true,
    exclude_government: true,
    exclude_hedge_funds: true,
    likely_owner_required: true,
    family_associated_allowed: true,
    primary_decision_maker_required: false,

    tags_include_any: [],
    tags_include_all: [],
    tags_exclude: [],
    
    min_motivation_layers: null,
    min_final_acquisition_score: null,
    min_structured_motivation_score: null,
    min_deal_strength_score: null,
    min_tag_distress_score: null,
    min_equity_percent: null,
    equity_amount_min: null,
    equity_amount_max: null,
    estimated_value_min: null,
    estimated_value_max: null,
    cash_offer_min: null,
    cash_offer_max: null,
    repair_cost_min: null,
    repair_cost_max: null,
    year_built_min: null,
    year_built_max: null,
    effective_year_built_min: null,
    effective_year_built_max: null,
    sqft_min: null,
    sqft_max: null,
    lot_size_min: null,
    lot_size_max: null,
    beds_min: null,
    beds_max: null,
    baths_min: null,
    baths_max: null,
    units_min: null,
    units_max: null,
    building_condition: '',
    building_quality: '',
    rehab_level: '',
    property_type: '',
    property_class: '',
    market_status: '',
    mls_status: '',

    sms_eligible_required: true,
    valid_e164_required: true,
    wireless_only: false,
    min_phone_score: null,
    active_12mo_only: false,
    exclude_opt_outs: true,
    exclude_wrong_numbers: true,
    exclude_blacklist_pairs: true,
    exclude_not_interested: true,
    exclude_no_reply: false,
    exclude_active_queue: true,
    dedupe_same_phone: true,
    dedupe_same_owner: true,
    exclude_contacted_days: 30,
    exclude_delivered_days: null,
    never_contacted_only: false,
    require_linked_property: true,
    require_linked_master_owner: true,
    require_campaign_target_row: true,
    require_seller_first_name: true,

    language: 'English',
    agent_family: 'standard',
    agent_persona: 'nexus',
    template_category: 'cold_outreach',
    message_tone: 'friendly',
    gender_variant: 'neutral',
    market_specific_required: false,
    language_matched_required: true,
    fallback_template_allowed: true,

    send_window_policy: 'local_timezone',
    custom_window_start: '09:00:00',
    custom_window_end: '20:00:00',
    interval_seconds: 15,
    daily_cap: null,
    total_cap: null,
    auto_send_enabled: true,
    routing_safe_only: true,
    start_paused: false,
    pause_on_optout_rate: null,
    pause_on_failure_rate: null
  }
}

// UI Models
interface VisualFilter {
  id: string
  category: string
  field: string
  operator: string
  value: any
}

// Available Fields map
const FIELDS_BY_CATEGORY: Record<string, { label: string, key: keyof CreateCampaignPayload['target_filters'], type: 'multi' | 'numeric' | 'boolean' }[]> = {
  'Geography': [
    { label: 'States', key: 'states', type: 'multi' },
    { label: 'Markets', key: 'markets', type: 'multi' },
    { label: 'Counties', key: 'counties', type: 'multi' },
    { label: 'Cities', key: 'cities', type: 'multi' },
    { label: 'ZIP Codes', key: 'zip_codes', type: 'multi' },
  ],
  'Property Tags': [
    { label: 'Include ANY Tags', key: 'tags_include_any', type: 'multi' },
    { label: 'Include ALL Tags', key: 'tags_include_all', type: 'multi' },
    { label: 'Exclude Tags', key: 'tags_exclude', type: 'multi' },
    { label: 'Min Motivation Layers', key: 'min_motivation_layers', type: 'numeric' },
  ],
  'Property Type / Asset': [
    { label: 'Property Type', key: 'property_type', type: 'multi' },
    { label: 'Property Class', key: 'property_class', type: 'multi' },
    { label: 'Units Count (Min)', key: 'units_min', type: 'numeric' },
    { label: 'Bedrooms (Min)', key: 'beds_min', type: 'numeric' },
    { label: 'Bathrooms (Min)', key: 'baths_min', type: 'numeric' },
    { label: 'Square Feet (Min)', key: 'sqft_min', type: 'numeric' },
    { label: 'Year Built (Max)', key: 'year_built_max', type: 'numeric' },
  ],
  'Equity / Value': [
    { label: 'Equity % (Min)', key: 'min_equity_percent', type: 'numeric' },
    { label: 'Estimated Value (Max)', key: 'estimated_value_max', type: 'numeric' },
    { label: 'Cash Offer (Max)', key: 'cash_offer_max', type: 'numeric' },
  ],
  'Distress': [
    { label: 'Min Acquisition Score', key: 'min_final_acquisition_score', type: 'numeric' },
  ],
  'Ownership': [
    { label: 'Owner Types', key: 'owner_types', type: 'multi' },
    { label: 'Exclude Banks', key: 'exclude_banks', type: 'boolean' },
    { label: 'Exclude Government', key: 'exclude_government', type: 'boolean' },
    { label: 'Exclude Hedge Funds', key: 'exclude_hedge_funds', type: 'boolean' },
  ]
}

const MULTI_OPERATORS = ['Is any of', 'Is all of']
const NUMERIC_OPERATORS = ['Greater than or equal', 'Less than or equal', 'Equal to']
const BOOLEAN_OPERATORS = ['Is true', 'Is false']

export const CreateCampaignModal = ({ onClose, onSuccess }: CreateCampaignModalProps) => {
  const [step, setStep] = useState(1) // 1: Mission, 2: Geography, 3: Filters, 4: Schedule, 5: Review
  const [payload, setPayload] = useState<CreateCampaignPayload>(JSON.parse(JSON.stringify(DEFAULT_PAYLOAD)))
  const [options, setOptions] = useState<CampaignFilterOptionsResponse | null>(null)
  
  const [activeFilters, setActiveFilters] = useState<VisualFilter[]>([])
  
  // UI States for Add Filter Row
  const [addingCategory, setAddingCategory] = useState<string | null>(null)
  const [draftField, setDraftField] = useState<string>('')
  const [draftOperator, setDraftOperator] = useState<string>('')
  const [draftValue, setDraftValue] = useState<any>('')

  // Preview & Engine States
  const [preview, setPreview] = useState<PreviewTargetsResponse | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [isLoadingOptions, setIsLoadingOptions] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isBuilding, setIsBuilding] = useState(false)
  const [isQueuing, setIsQueuing] = useState(false)
  const [campaignId, setCampaignId] = useState<string | null>(null)

  // Initialization
  useEffect(() => {
    getCampaignFilterOptions().then(res => {
      if (res.ok && res.data) setOptions(res.data)
      setIsLoadingOptions(false)
    }).catch(err => {
      console.error(err)
      setIsLoadingOptions(false)
    })
  }, [])

  // Debounced Preview
  useEffect(() => {
    const handler = setTimeout(() => {
      setIsPreviewLoading(true)
      previewCampaignTargets(payload.target_filters).then(res => {
        if (res.ok && res.data) {
          setPreview(res.data)
        }
        setIsPreviewLoading(false)
      }).catch(err => {
        console.error(err)
        setIsPreviewLoading(false)
      })
    }, 600)
    return () => clearTimeout(handler)
  }, [payload.target_filters])

  const updateRoot = (key: keyof CreateCampaignPayload, val: any) => {
    setPayload(prev => ({ ...prev, [key]: val }))
  }
  
  const updateFilterPayload = (key: keyof CreateCampaignPayload['target_filters'], val: any) => {
    setPayload(prev => ({
      ...prev,
      target_filters: { ...prev.target_filters, [key]: val }
    }))
  }

  const handleApplyDraftFilter = () => {
    if (!draftField || !draftOperator || draftValue === '' || draftValue === undefined || draftValue?.length === 0) return

    const fieldDef = FIELDS_BY_CATEGORY[addingCategory || '']?.find(f => f.key === draftField)
    if (!fieldDef) return

    const newFilter: VisualFilter = {
      id: Math.random().toString(36).substring(7),
      category: addingCategory!,
      field: draftField,
      operator: draftOperator,
      value: draftValue
    }

    setActiveFilters(prev => [...prev, newFilter])
    updateFilterPayload(draftField as keyof CreateCampaignPayload['target_filters'], draftValue)

    setAddingCategory(null)
    setDraftField('')
    setDraftOperator('')
    setDraftValue('')
  }

  const handleRemoveFilter = (f: VisualFilter) => {
    setActiveFilters(prev => prev.filter(x => x.id !== f.id))
    // Reset underlying payload
    const fieldDef = FIELDS_BY_CATEGORY[f.category]?.find(x => x.key === f.field)
    if (!fieldDef) return
    let defaultVal: any = null
    if (fieldDef.type === 'multi') defaultVal = []
    if (fieldDef.type === 'boolean') defaultVal = true // Some default to true in DEFAULT_PAYLOAD
    updateFilterPayload(f.field as keyof CreateCampaignPayload['target_filters'], defaultVal)
  }

  const handleCreateCampaign = async () => {
    try {
      setIsSaving(true)
      const newCampaignId = await createCampaign(payload)
      setCampaignId(newCampaignId)
      emitNotification({ title: 'Campaign Draft Created', detail: 'Settings have been securely saved.', severity: 'success' })
      setStep(6) // Virtual step: build
    } catch (e) {
      emitNotification({ title: 'Creation Failed', detail: String(e), severity: 'critical' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleBuildTargets = async () => {
    if (!campaignId) return
    try {
      setIsBuilding(true)
      const res = await buildCampaignTargets(campaignId)
      if (res.ok) {
        emitNotification({ title: 'Targets Built', detail: `Successfully built ${res.data.built_count} targets.`, severity: 'success' })
        setStep(7) // Move to activation step/virtual step
      } else {
        throw new Error(res.error)
      }
    } catch (e) {
      emitNotification({ title: 'Build Failed', detail: String(e), severity: 'critical' })
    } finally {
      setIsBuilding(false)
    }
  }

  const handleQueueBatch = async () => {
    if (!campaignId) return
    try {
      setIsQueuing(true)
      const res = await queueCampaignBatch(campaignId, 100, payload.target_filters.interval_seconds)
      if (res.ok) {
        emitNotification({ title: 'Batch Queued', detail: `Successfully queued ${res.data.queued_count} targets.`, severity: 'success' })
        onSuccess(campaignId) // Exit modal
      } else {
        throw new Error(res.error)
      }
    } catch (e) {
      emitNotification({ title: 'Queue Failed', detail: String(e), severity: 'critical' })
    } finally {
      setIsQueuing(false)
    }
  }

  if (isLoadingOptions) {
    return <div className="cmp-studio-overlay"><div className="cmp-studio"><div style={{padding:40}}>Loading Studio...</div></div></div>
  }

  return (
    <div className="cmp-studio-overlay">
      <div className="cmp-studio">
        
        {/* Left: Wizard */}
        <div className="cmp-studio-workspace">
          <div className="cmp-studio-header">
            <div className="cmp-studio-title">Campaign Targeting Studio</div>
            <button className="cmp-studio-close" onClick={onClose}>✕</button>
          </div>

          <div className="cmp-studio-nav">
            {['Campaign Mission', 'Geography', 'Property Filters', 'Schedule', 'Review & Launch'].map((label, idx) => {
              const s = idx + 1
              return (
                <div key={s} className={`cmp-studio-nav-item ${step === s ? 'is-active' : ''}`} onClick={() => setStep(s)}>
                  <div className="cmp-studio-nav-num">{s}</div>
                  <div className="cmp-studio-nav-label">{label}</div>
                </div>
              )
            })}
          </div>

          <div className="cmp-studio-content">
            
            {/* GLOBAL ACTIVE FILTERS */}
            {activeFilters.length > 0 && (
              <div className="cmp-active-filters-bar" style={{ padding: '12px 24px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={{fontSize: 10, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase'}}>Active Filters:</span>
                {activeFilters.map(f => (
                  <div key={f.id} className="cmp-filter-chip" style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.1)', padding: '4px 10px', borderRadius: 4, fontSize: 11 }}>
                    <span>{FIELDS_BY_CATEGORY[f.category]?.find(x => x.key === f.field)?.label} {f.operator} {Array.isArray(f.value) ? f.value.join(', ') : String(f.value)}</span>
                    <button style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 0 }} onClick={() => handleRemoveFilter(f)}>✕</button>
                  </div>
                ))}
                <button className="cmp-btn-secondary" style={{ marginLeft: 'auto', fontSize: 10, padding: '4px 8px' }} onClick={() => { setActiveFilters([]); setPayload(JSON.parse(JSON.stringify(DEFAULT_PAYLOAD))) }}>Clear All</button>
              </div>
            )}

            <div style={{ padding: '32px' }}>
              {step === 1 && (
                <div className="nx-control-group">
                  <div className="cmp-form-grid">
                    <label className="cmp-form-field">
                      <span>Campaign Name</span>
                      <div style={{display:'flex', gap: 8}}>
                        <input type="text" value={payload.name} onChange={e => updateRoot('name', e.target.value)} placeholder="e.g. Q3 Dallas Probate" />
                        <button className="cmp-btn-secondary" onClick={() => updateRoot('name', `Campaign ${new Date().toISOString().split('T')[0]}`)}>Auto</button>
                      </div>
                    </label>
                    <label className="cmp-form-field">
                      <span>Scenario / Objective</span>
                      <select value={payload.template_use_case} onChange={e => updateRoot('template_use_case', e.target.value)}>
                        <option value="cold_outreach">Cold Outreach Outbound</option>
                        <option value="follow_up_outreach">Follow Up Sequence</option>
                        <option value="foreclosure_notice">Foreclosure Notice</option>
                        <option value="probate_outreach">Probate Outreach</option>
                      </select>
                    </label>
                    <label className="cmp-form-field cmp-form-field--full">
                      <span>Description (Optional)</span>
                      <textarea value={payload.description} onChange={e => updateRoot('description', e.target.value)} rows={3} />
                    </label>
                  </div>
                </div>
              )}

              {(step === 2 || step === 3) && (
                <div>
                  {(step === 2 ? ['Geography'] : ['Property Tags', 'Property Type / Asset', 'Equity / Value', 'Distress', 'Ownership']).map(cat => (
                    <div key={cat} className="nx-control-group" style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <span className="nx-control-label" style={{margin:0, fontSize: 14}}>{cat}</span>
                        <button className="cmp-btn-secondary" style={{fontSize: 10, padding: '4px 8px'}} onClick={() => setAddingCategory(addingCategory === cat ? null : cat)}>
                          {addingCategory === cat ? 'Cancel' : '+ Add Filter'}
                        </button>
                      </div>
                      
                      {addingCategory === cat && (
                        <div className="cmp-inline-filter-row" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 6 }}>
                          <select style={{ flex: 1 }} value={draftField} onChange={e => {
                            setDraftField(e.target.value)
                            const type = FIELDS_BY_CATEGORY[cat]?.find(f => f.key === e.target.value)?.type
                            if (type === 'multi') setDraftOperator('Is any of')
                            else if (type === 'numeric') setDraftOperator('Greater than or equal')
                            else if (type === 'boolean') setDraftOperator('Is true')
                            setDraftValue(type === 'multi' ? [] : type === 'boolean' ? true : '')
                          }}>
                            <option value="" disabled>Select Field</option>
                            {FIELDS_BY_CATEGORY[cat]?.map(f => (
                              <option key={f.key} value={f.key}>{f.label}</option>
                            ))}
                          </select>
                          
                          <select style={{ flex: 1 }} value={draftOperator} onChange={e => setDraftOperator(e.target.value)}>
                            {draftField && (() => {
                              const type = FIELDS_BY_CATEGORY[cat]?.find(f => f.key === draftField)?.type
                              if (type === 'multi') return MULTI_OPERATORS.map(o => <option key={o} value={o}>{o}</option>)
                              if (type === 'numeric') return NUMERIC_OPERATORS.map(o => <option key={o} value={o}>{o}</option>)
                              if (type === 'boolean') return BOOLEAN_OPERATORS.map(o => <option key={o} value={o}>{o}</option>)
                            })()}
                          </select>

                          {/* Value Control */}
                          <div style={{ flex: 2 }}>
                            {draftField && (() => {
                              const type = FIELDS_BY_CATEGORY[cat]?.find(f => f.key === draftField)?.type
                              if (type === 'multi') {
                                const optList = options?.[draftField as keyof CampaignFilterOptionsResponse] as any[]
                                return (
                                  <select multiple size={3} style={{ width: '100%' }} value={draftValue || []} onChange={e => setDraftValue(Array.from(e.target.selectedOptions, option => option.value))}>
                                    {optList?.map(o => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
                                  </select>
                                )
                              }
                              if (type === 'numeric') {
                                return <input type="number" style={{ width: '100%' }} placeholder="Enter number..." value={draftValue} onChange={e => setDraftValue(e.target.value ? Number(e.target.value) : '')} />
                              }
                              if (type === 'boolean') {
                                return (
                                  <select style={{ width: '100%' }} value={String(draftValue)} onChange={e => setDraftValue(e.target.value === 'true')}>
                                    <option value="true">True</option>
                                    <option value="false">False</option>
                                  </select>
                                )
                              }
                            })()}
                          </div>

                          <button className="cmp-btn-primary" style={{padding: '8px 16px', alignSelf: 'flex-start'}} onClick={handleApplyDraftFilter}>Apply</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {step === 4 && (
                <div className="nx-control-group">
                  <span className="nx-control-label">Schedule & Limits</span>
                  <div className="cmp-form-grid">
                    <div className="cmp-form-field">
                      <span>Send Window Policy</span>
                      <select value={payload.target_filters.send_window_policy} onChange={e => updateFilterPayload('send_window_policy', e.target.value)}>
                        <option value="national_et_to_pt">National (8am ET - 9pm PT)</option>
                        <option value="local_timezone">Local Market Time (9am - 8pm)</option>
                        <option value="custom">Custom Hours</option>
                      </select>
                    </div>
                    <div className="cmp-form-field">
                      <span>Send Interval</span>
                      <select value={payload.target_filters.interval_seconds} onChange={e => updateFilterPayload('interval_seconds', parseInt(e.target.value))}>
                        <option value="10">10 Seconds (Aggressive)</option>
                        <option value="15">15 Seconds (Standard)</option>
                        <option value="30">30 Seconds (Safe)</option>
                        <option value="60">60 Seconds (Conservative)</option>
                      </select>
                    </div>
                    <div className="cmp-form-field">
                      <span>Daily Cap</span>
                      <input type="number" value={payload.target_filters.daily_cap || ''} onChange={e => updateFilterPayload('daily_cap', parseInt(e.target.value) || null)} placeholder="Unlimited" />
                    </div>
                    <div className="cmp-form-field">
                      <span>Total Cap</span>
                      <input type="number" value={payload.target_filters.total_cap || ''} onChange={e => updateFilterPayload('total_cap', parseInt(e.target.value) || null)} placeholder="Unlimited" />
                    </div>
                  </div>
                </div>
              )}

              {step === 5 && (
                <div className="nx-control-group" style={{ textAlign: 'center', padding: '40px 0' }}>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: 24 }}>Ready to Build</h3>
                  <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: 24, fontSize: 13 }}>
                    Review your projection metrics in the right panel.<br/>
                    Clicking "Create Campaign" will save your configuration.
                  </p>
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                    <button className="cmp-btn-secondary" onClick={() => setStep(1)}>Back</button>
                    <button className="cmp-btn-primary" onClick={handleCreateCampaign} disabled={isSaving}>
                      {isSaving ? 'Saving...' : 'Create Campaign'}
                    </button>
                  </div>
                </div>
              )}

              {step === 6 && (
                <div className="nx-control-group" style={{ textAlign: 'center', padding: '40px 0' }}>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: 24, color: 'var(--success)' }}>Campaign Saved</h3>
                  <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: 24, fontSize: 13 }}>
                    The campaign configuration is locked in. Now we need to process properties and materialize the <code>sms_campaign_targets</code> list.
                  </p>
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                    <button className="cmp-btn-primary" onClick={handleBuildTargets} disabled={isBuilding}>
                      {isBuilding ? 'Processing Targets...' : 'Build Targets'}
                    </button>
                  </div>
                </div>
              )}

              {step === 7 && (
                <div className="nx-control-group" style={{ textAlign: 'center', padding: '40px 0' }}>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: 24, color: 'var(--accent)' }}>Targets Ready</h3>
                  <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: 24, fontSize: 13 }}>
                    Targets have been built. To begin dispatching messages immediately, queue the initial batch.
                  </p>
                  <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                    <button className="cmp-btn-secondary" onClick={() => onSuccess(campaignId!)}>Exit to Dashboard</button>
                    <button className="cmp-btn-primary" onClick={handleQueueBatch} disabled={isQueuing}>
                      {isQueuing ? 'Queuing Batch...' : 'Queue Initial Batch'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          
          <div className="cmp-studio-footer">
            <button className="cmp-btn-secondary" onClick={() => step > 1 ? setStep(step - 1) : onClose()}>
              {step === 1 ? 'Cancel' : 'Previous'}
            </button>
            {step < 5 && (
              <button className="cmp-btn-primary" onClick={() => setStep(step + 1)}>
                Next Step
              </button>
            )}
          </div>
        </div>

        {/* Right: Summary */}
        <div className="cmp-studio-summary">
          <div className="cmp-summary-header">
            <div className="cmp-summary-title">Live Projection</div>
            {isPreviewLoading ? (
              <div className="cmp-summary-status is-loading">Computing...</div>
            ) : preview ? (
              <div className="cmp-summary-status is-ready">Connected</div>
            ) : (
              <div className="cmp-summary-status">Standby</div>
            )}
          </div>
          
          <div className="cmp-summary-body">
            <div className="cmp-summary-metrics-grid">
              <div className="cmp-summary-metric">
                <div className="cmp-summary-metric-label">Properties</div>
                <div className="cmp-summary-metric-value">{preview?.total_matching_properties?.toLocaleString() || 0}</div>
              </div>
              <div className="cmp-summary-metric">
                <div className="cmp-summary-metric-label">Suppressed</div>
                <div className="cmp-summary-metric-value is-warning">{preview?.suppressed_count?.toLocaleString() || 0}</div>
              </div>
              <div className="cmp-summary-metric">
                <div className="cmp-summary-metric-label">Clean Targets</div>
                <div className="cmp-summary-metric-value is-success">{preview?.clean_ready_targets?.toLocaleString() || 0}</div>
              </div>
            </div>

            <div className="cmp-summary-readiness">
              <div className="cmp-summary-metric-label" style={{ fontSize: 12 }}>Readiness Score</div>
              <div className={`cmp-summary-metric-value ${(preview?.readiness_score || 0) > 80 ? 'is-accent' : (preview?.readiness_score || 0) > 50 ? 'is-warning' : 'is-danger'}`}>
                {preview?.readiness_score || 0}/100
              </div>
            </div>

            <div className="nx-control-group" style={{marginTop: 24, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 24}}>
              <span className="nx-control-label">Automatic System Enforcement</span>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="cmp-system-card" style={{ display: 'flex', gap: 12, padding: 16, background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div className="cmp-system-card-icon" style={{ fontSize: 24 }}>🛡️</div>
                  <div>
                    <strong style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Automatic Guardrails</strong>
                    <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>Suppression engine active. Valid E.164 required. Opt-outs and wrong numbers excluded.</p>
                  </div>
                </div>
                
                <div className="cmp-system-card" style={{ display: 'flex', gap: 12, padding: 16, background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div className="cmp-system-card-icon" style={{ fontSize: 24 }}>📡</div>
                  <div>
                    <strong style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Automatic Routing</strong>
                    <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>TextGrid routing matrix enabled. Unsafe numbers blocked dynamically.</p>
                  </div>
                </div>
                
                <div className="cmp-system-card" style={{ display: 'flex', gap: 12, padding: 16, background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div className="cmp-system-card-icon" style={{ fontSize: 24 }}>💬</div>
                  <div>
                    <strong style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Automatic Messaging</strong>
                    <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>Agent persona, tone, and language mapped automatically based on campaign objective.</p>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  )
}
