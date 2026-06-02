import { useState, useEffect, useCallback, useMemo } from 'react'
import { getSupabaseClient } from '../../lib/supabaseClient'
import {
  fetchQueueModel,
  approveQueueItem,
  holdQueueItem,
  rescheduleQueueItem,
  retryQueueItem,
  cancelQueueItem,
  retryRoutingForItem,
  type QueueModel,
  type QueueItem,
} from '../../lib/data/queueData'
import type { QueueItemStatus } from './queue.types'
import { Icon } from '../../shared/icons'
import { formatRelativeTime } from '../../shared/formatters'
import { emitNotification } from '../../shared/NotificationToast'
import './queue-premium.css'

// ── Types & Helpers ────────────────────────────────────────────────────────

type ViewMode = 'today' | 'week' | 'month' | 'list' | 'approval' | 'failed'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

// ── Components ────────────────────────────────────────────────────────────

/**
 * Status Badge for Queue Items
 */
const StatusBadge = ({ status }: { status: QueueItemStatus }) => {
  const labels: Record<string, string> = {
    ready: 'Ready',
    scheduled: 'Scheduled',
    approval: 'Pending Approval',
    failed: 'Failed',
    sent: 'Sent',
    delivered: 'Delivered',
    retry: 'Retrying',
    held: 'On Hold',
    paused_invalid_queue_row: 'Routing Blocked',
  }

  return (
    <span className={cls('nx-badge', `nx-badge--${status}`)}>
      {labels[status] || status}
    </span>
  )
}

/**
 * Risk Tag
 */
const RiskTag = ({ level }: { level: 'low' | 'medium' | 'high' }) => (
  <span className={cls('nx-risk-tag', `is-${level}`)}>
    {level} RISK
  </span>
)

/**
 * Queue Card for Grid/List views
 */
const OperationalRow = ({
  item, 
  isSelected, 
  onClick 
}: { 
  item: QueueItem, 
  isSelected: boolean, 
  onClick: () => void 
}) => (
  <div 
    className={cls('nx-operational-row', isSelected && 'is-selected')}
    onClick={onClick}
  >
    <div className="nx-op-cell is-seller">
      <span className="nx-seller-name">{item.sellerName}</span>
      <span className="nx-seller-address">{item.propertyAddress}</span>
      <span className="nx-op-campaign-meta">campaign_id: {item.campaignId || '—'}</span>
      <span className="nx-op-campaign-meta">campaign_target_id: {item.campaignTargetId || '—'}</span>
      <div className="nx-op-hover-intel">
        <span className={cls('nx-temp-dot', `is-${item.sellerTemperature}`)} />
        <small>{item.sellerTemperature.toUpperCase()}</small>
        {item.memoryStatus !== 'none' && (
          <>
            <span className="nx-intel-divider" />
            <Icon name="brain" className="nx-intel-icon" />
            <small>Memory Active</small>
          </>
        )}
      </div>
    </div>
    
    <div className="nx-op-cell is-status">
      <StatusBadge status={item.status} />
      <span className="nx-op-stage">{item.currentStage}</span>
    </div>

    <div className="nx-op-cell is-action">
      <span className="nx-next-action">{item.nextBestAction || 'Automated Outreach'}</span>
      {item.urgencyScore > 75 && <RiskTag level="high" />}
    </div>

    <div className="nx-op-cell is-timing">
      <span className="nx-timing-val">{formatRelativeTime(item.scheduledForLocal)}</span>
      <span className="nx-timing-sub">{item.market}</span>
    </div>

    <div className="nx-op-cell is-ai">
      <div className="nx-ai-bar">
        <div className="nx-ai-fill" style={{ width: `${item.aiConfidence}%`, background: item.aiConfidence > 85 ? 'var(--success)' : 'var(--warning)' }} />
      </div>
      <span className="nx-ai-val">{item.aiConfidence}%</span>
    </div>

    <div className="nx-op-cell is-agent">
      <span className="nx-agent-name">{item.agent}</span>
    </div>
  </div>
)


/**
 * Intelligence Row
 */
const IntelRow = ({ label, value, icon, className }: { label: string; value: string | number; icon?: string; className?: string }) => (
  <div className={cls('nx-queue-inspector-row', className)}>
    <span className="nx-queue-inspector-label">
      {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
      {label}
    </span>
    <span className="nx-queue-inspector-value">{value || '—'}</span>
  </div>
)

/**
 * Collapsible Inspector Card
 */
const CollapsibleInspectorCard = ({ 
  title, 
  icon, 
  children, 
  className,
  defaultExpanded = true 
}: { 
  title: string; 
  icon: any; 
  children: React.ReactNode; 
  className?: string;
  defaultExpanded?: boolean 
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <section className={cls('nx-inspector-card', !expanded && 'is-collapsed', className)}>
      <button type="button" className="nx-inspector-card__header" onClick={() => setExpanded(!expanded)}>
        <Icon name={icon} />
        <strong>{title}</strong>
        <Icon name="chevron-down" className={cls('nx-inspector-card__chevron', expanded && 'is-rotated')} />
      </button>
      {expanded && <div className="nx-inspector-card__body">{children}</div>}
    </section>
  )
}

/**
 * Intelligence Inspector Panel
 */
const TacticalIntelligenceStack = ({
  item, 
  onAction,
  viewMode
}: { 
  item: QueueItem | null, 
  onAction: (action: string, id: string) => void,
  viewMode: string
}) => {
  const [showMetadata, setShowMetadata] = useState(false)

  if (!item) {
    return (
      <aside className="nx-queue-inspector is-empty">
        <div className="nx-empty-state">
          <Icon name="radar" style={{ width: 48, height: 48, opacity: 0.2, marginBottom: 16 }} />
          <p>Awaiting operational target</p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="nx-queue-inspector">
      <header className="nx-queue-inspector-header">
        <div className="nx-inspector-title">
          <h2>Tactical Intelligence</h2>
          <StatusBadge status={item.status} />
        </div>
        <button className="nx-inspector-close" onClick={() => onAction('deselect', item.id)}>
          <Icon name="close" />
        </button>
      </header>

      <div className="nx-queue-inspector-body">
        {/* Dynamic Context Block based on View */}
        {viewMode === 'approval' && (
          <CollapsibleInspectorCard title="AI Review Rationale" icon="shield">
            <div className="nx-inspector-grid">
              <IntelRow label="Reason" value={item.approvalReason || 'Requires human review'} className="is-warning" />
              <IntelRow label="Confidence" value={`${item.aiConfidence}%`} />
              <IntelRow label="Risk Assessment" value={item.riskLevel.toUpperCase()} className={`is-risk-${item.riskLevel}`} />
            </div>
            {item.priorThreadSummary && (
              <div className="nx-approval-message-preview" style={{ marginTop: '12px' }}>
                <Icon name="file-text" />
                <p><strong>Memory:</strong> {item.priorThreadSummary}</p>
              </div>
            )}
          </CollapsibleInspectorCard>
        )}

        {viewMode === 'failed' && (
          <CollapsibleInspectorCard title="Diagnostics & Recovery" icon="alert" className="is-error">
            <div className="nx-error-box" style={{ marginBottom: 12 }}>
              <strong>{item.failureGroup || 'System Failure'} - {item.failureReason || 'Unknown'}</strong>
              <p>Attempt {item.retryCount} of {item.maxRetries}</p>
            </div>
            <div className="nx-inspector-grid">
              <IntelRow label="Retry Eligible" value={item.retryEligible ? 'Yes' : 'No'} className={item.retryEligible ? 'is-success' : 'is-error'} />
              <IntelRow label="Action Required" value={item.retryEligible ? 'Retry Sequence' : 'Human Intervention'} />
            </div>
          </CollapsibleInspectorCard>
        )}

        {/* Global Core Execution Details */}
        <CollapsibleInspectorCard title="Execution Details" icon="radar">
          <div className="nx-inspector-grid">
            <IntelRow label="campaign_id" value={item.campaignId || '—'} />
            <IntelRow label="campaign_target_id" value={item.campaignTargetId || '—'} />
            <IntelRow label="Scheduled" value={new Date(item.scheduledForLocal).toLocaleString()} />
            <IntelRow label="Priority" value={item.priority.toUpperCase()} className={cls(item.priority === 'P0' && 'is-urgent')} />
            <IntelRow label="Stage" value={item.currentStage} />
            <IntelRow label="Market" value={item.market} />
            <IntelRow label="Next Action" value={item.nextBestAction || 'Automated Outreach'} />
          </div>
        </CollapsibleInspectorCard>

        {/* Seller Telemetry */}
        <CollapsibleInspectorCard title="Seller Telemetry" icon="user">
          <div className="nx-inspector-grid">
            <IntelRow label="Seller" value={item.sellerName} />
            <IntelRow label="Temperature" value={item.sellerTemperature.toUpperCase()} className={`is-temp-${item.sellerTemperature}`} />
            <IntelRow label="Urgency" value={`${item.urgencyScore}/100`} />
            <IntelRow label="Intent" value={item.extractedIntent || 'Discovering'} />
            <IntelRow label="Memory" value={item.memoryStatus.toUpperCase()} />
          </div>
        </CollapsibleInspectorCard>

        <CollapsibleInspectorCard title="Payload Signal" icon="file-text" defaultExpanded={viewMode === 'approval'}>
          <div className="nx-inspector-message-preview">
            <div className="nx-msg-meta">
              <span>{item.templateName}</span>
              <span>{item.useCase}</span>
            </div>
            <p>{item.messageText}</p>
          </div>
        </CollapsibleInspectorCard>

        <div className="nx-inspector-advanced">
          <button 
            className="nx-inspector-toggle-json"
            onClick={() => setShowMetadata(!showMetadata)}
          >
            <Icon name="grid" />
            {showMetadata ? 'Hide Metadata' : 'View Raw Signal'}
          </button>
          
          {showMetadata && (
            <pre className="nx-inspector-json">
              {JSON.stringify(item, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="nx-queue-inspector-actions">
        {item.status === 'approval' && (
          <button className="nx-btn nx-btn--primary" onClick={() => onAction('approve', item.id)}>
            <Icon name="check" /> Approve
          </button>
        )}
        {(item.status === 'ready' || item.status === 'scheduled') && (
          <button className="nx-btn nx-btn--secondary" onClick={() => onAction('hold', item.id)}>
            <Icon name="shield" /> Hold
          </button>
        )}
        {item.status === 'failed' && item.retryEligible && (
          <button className="nx-btn nx-btn--primary" onClick={() => onAction('retry', item.id)}>
            <Icon name="zap" /> Retry Sequence
          </button>
        )}
        <button className="nx-btn nx-btn--secondary" onClick={() => onAction('reschedule', item.id)}>
          <Icon name="calendar" /> Reschedule
        </button>
        <button className="nx-btn nx-btn--danger" onClick={() => onAction('cancel', item.id)}>
          <Icon name="close" /> Suppress
        </button>
      </div>
    </aside>
  )
}


// ── Main Page Component ────────────────────────────────────────────────────
interface QueuePageProps {
  data?: QueueModel
}

export const QueuePage = ({ data: initialData }: QueuePageProps = {}) => {
  const [loading, setLoading] = useState(!initialData)
  const [model, setModel] = useState<QueueModel | null>(initialData || null)
  const [viewMode, setViewMode] = useState<ViewMode>('today')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<QueueItemStatus | 'all'>('all')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)

  const refreshData = useCallback(async () => {
    try {
      const data = await fetchQueueModel()
      setModel(data)
    } catch (err) {
      console.error('Failed to fetch queue data', err)
      emitNotification({
        title: 'Queue Load Failed',
        detail: err instanceof Error ? err.message : 'Database sync error',
        severity: 'critical'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshData()

    const supabase = getSupabaseClient()
    const channel = supabase
      .channel('queue-live-updates')
      .on(
        'postgres_changes',
        { event: '*', table: 'send_queue', schema: 'public' },
        () => {
          refreshData()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [refreshData])

  // Keyboard navigation for view switching
  useEffect(() => {
    const handleKeys = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      
      const modes: ViewMode[] = ['today', 'week', 'month', 'list', 'approval', 'failed']
      const key = parseInt(e.key)
      if (key >= 1 && key <= 6) {
        setViewMode(modes[key - 1])
      }
    }
    window.addEventListener('keydown', handleKeys)
    return () => window.removeEventListener('keydown', handleKeys)
  }, [])

  const handleAction = async (action: string, id: string) => {
    const item = model?.items.find((i: QueueItem) => i.id === id)
    if (!item) return

    if (action === 'deselect') {
      setSelectedItemId(null)
      setMobileInspectorOpen(false)
      return
    }

    // Optimistic UI mapping
    let successMessage = ''
    let resultPromise: Promise<any> | null = null

    switch (action) {
      case 'approve':
        successMessage = `Approved send to ${item.sellerName}`
        resultPromise = approveQueueItem(item)
        break
      case 'hold':
        successMessage = `Held item for ${item.sellerName}`
        resultPromise = holdQueueItem(item)
        break
      case 'cancel':
        successMessage = `Cancelled item for ${item.sellerName}`
        resultPromise = cancelQueueItem(item)
        break
      case 'retry':
        successMessage = `Retrying send to ${item.sellerName}`
        resultPromise = retryQueueItem(item)
        break
      case 'retry-routing':
        successMessage = `Retrying routing for ${item.sellerName}`
        resultPromise = retryRoutingForItem(item)
        break
      case 'reschedule':
        // Simplified for now - in production would open a date picker
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        successMessage = `Rescheduled to ${tomorrow.toLocaleDateString()}`
        resultPromise = rescheduleQueueItem(item, tomorrow.toISOString())
        break
    }

    if (resultPromise) {
      try {
        const res = await resultPromise
        if (res.ok) {
          emitNotification({
            title: 'Action Successful',
            detail: successMessage,
            severity: 'success',
            sound: 'notification'
          })
          refreshData()
        } else {
          throw new Error(res.errorMessage || 'Unknown error')
        }
      } catch (err) {
        emitNotification({
          title: 'Action Failed',
          detail: err instanceof Error ? err.message : 'Database update failed',
          severity: 'critical',
          sound: 'alert-triggered'
        })
      }
    }
  }

  const selectedItem = model?.items.find((i: QueueItem) => i.id === selectedItemId) || null

  const handleSelectItem = useCallback((id: string) => {
    setSelectedItemId(id)
    if (window.matchMedia('(max-width: 768px)').matches) {
      setMobileInspectorOpen(true)
      setMobileSidebarOpen(false)
    }
  }, [])

  const filteredItems = (model?.items || []).filter((item: QueueItem) => {
    if (statusFilter !== 'all' && item.status !== statusFilter) return false
    
    // Additional view-specific filtering
    if (viewMode === 'approval') return item.status === 'approval'
    if (viewMode === 'failed') return item.status === 'failed'
    
    return true
  })

  // Group items for Week view (Campaign Clusters)
  const weekClusters = useMemo(() => {
    if (viewMode !== 'week') return []
    const groups = new Map<string, QueueItem[]>()

    filteredItems.forEach(item => {
      // Group by Market + Temperature + Stage
      const key = `${item.market}|${item.sellerTemperature}|${item.currentStage}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(item)
    })

    return Array.from(groups.entries()).map(([key, items]) => {
      const [market, temp, stage] = key.split('|')
      return { market, temp, stage, items }
    }).sort((a, b) => b.items.length - a.items.length)
  }, [filteredItems, viewMode])

  // Group items for Failed view
  const failedGroups = useMemo(() => {
    if (viewMode !== 'failed') return []
    const groups = new Map<string, QueueItem[]>()

    filteredItems.forEach(item => {
      const key = item.failureGroup || 'Unknown'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(item)
    })

    return Array.from(groups.entries()).map(([group, items]) => ({
      group,
      items
    })).sort((a, b) => b.items.length - a.items.length)
  }, [filteredItems, viewMode])

  // Group items for Today view
  const timeBuckets = [
    { label: 'Past Due / Overdue', filter: (i: QueueItem) => new Date(i.scheduledForLocal) < new Date() && (i.status === 'ready' || i.status === 'retry') },
    { label: 'Upcoming (Next 4h)', filter: (i: QueueItem) => {
      const diff = new Date(i.scheduledForLocal).getTime() - new Date().getTime()
      return diff > 0 && diff < 4 * 3600 * 1000
    }},
    { label: 'Later Today', filter: (i: QueueItem) => {
      const diff = new Date(i.scheduledForLocal).getTime() - new Date().getTime()
      return diff >= 4 * 3600 * 1000 && new Date(i.scheduledForLocal).toDateString() === new Date().toDateString()
    }}
  ]

  if (loading) {
    return (
      <div className="nx-premium-queue is-loading">
        <div className="nx-loading-spinner" />
        <p>Syncing operations queue...</p>
      </div>
    )
  }

  return (
    <div className="nx-premium-queue">
      <header className="nx-queue-topbar">
        <div className="nx-queue-topbar__title">
          <h1>Operations Queue</h1>
          <div className="nx-view-switcher">
            {(['today', 'week', 'month', 'list', 'approval', 'failed'] as ViewMode[]).map(mode => (
              <button 
                key={mode}
                className={cls('nx-view-btn', viewMode === mode && 'is-active')}
                onClick={() => setViewMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className="nx-queue-topbar__actions">
          <div className="nx-queue-stat">
            <small>READY</small>
            <b>{model?.readyCount || 0}</b>
          </div>
          <div className="nx-queue-stat is-warning">
            <small>PENDING</small>
            <b>{model?.approvalCount || 0}</b>
          </div>
          <div className="nx-queue-stat is-danger">
            <small>FAILED</small>
            <b>{model?.failedCount || 0}</b>
          </div>
          <button className="nx-btn nx-btn--secondary nx-mobile-panel-toggle" onClick={() => setMobileSidebarOpen(v => !v)}>
            <Icon name="filter" /> Filters
          </button>
          <button className="nx-btn nx-btn--secondary" onClick={refreshData}>
            <Icon name="radar" /> Refresh
          </button>
        </div>
      </header>

      <div className={cls('nx-queue-shell', mobileSidebarOpen && 'm-sidebar-open', mobileInspectorOpen && 'm-inspector-open')}
        onClick={(e) => {
          if ((e.target as HTMLElement).classList.contains('nx-queue-shell')) {
            setMobileSidebarOpen(false)
            setMobileInspectorOpen(false)
          }
        }}
      >
        <aside className="nx-queue-sidebar">
          <div className="nx-queue-sidebar-section">
            <span className="nx-queue-sidebar-label">Active Capacity</span>
            <div className="nx-queue-capacity">
              <div className="nx-queue-capacity-item">
                <span className="nx-queue-capacity-label">Sent Today</span>
                <span className="nx-queue-capacity-value">{model?.sentTodayCount || 0}</span>
              </div>
              <div className="nx-queue-capacity-item">
                <span className="nx-queue-capacity-label">Daily Limit</span>
                <span className="nx-queue-capacity-value">1,200</span>
              </div>
              <div className="nx-queue-capacity-progress">
                <div 
                  className="nx-queue-capacity-bar" 
                  style={{ width: `${Math.min(((model?.sentTodayCount || 0) / 1200) * 100, 100)}%` }} 
                />
              </div>
            </div>
          </div>

          <div className="nx-queue-sidebar-section">
            <span className="nx-queue-sidebar-label">Status Filters</span>
            {(['all', 'ready', 'scheduled', 'approval', 'held', 'failed'] as const).map(s => (
              <button 
                key={s}
                className={cls('nx-queue-bucket-btn', statusFilter === s && 'is-active')}
                onClick={() => setStatusFilter(s)}
              >
                <span className="nx-bucket-name">{s === 'all' ? 'All Items' : s.charAt(0).toUpperCase() + s.slice(1)}</span>
                <span className="nx-queue-bucket-count">
                  {s === 'all' ? model?.items.length : (model as any)[`${s}Count`] || 0}
                </span>
              </button>
            ))}
          </div>

          <div className="nx-queue-sidebar-section is-spacer" />

          <div className="nx-queue-sidebar-section">
            <div className="nx-sidebar-footer">
              <div className="nx-engine-info" style={{ marginBottom: '12px', fontSize: '11px', opacity: 0.8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>Send Engine:</span>
                  <span style={{ color: 'var(--success)' }}>{model?.sendEngine}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Mode:</span>
                  <span className={cls('nx-engine-mode', model?.engineMode === 'proxy' ? 'is-proxy' : 'is-limited')} style={{ 
                    color: model?.engineMode === 'proxy' ? 'var(--success)' : 'var(--warning)',
                    textTransform: 'uppercase',
                    fontWeight: 'bold'
                  }}>
                    {model?.engineMode}
                  </span>
                </div>
              </div>
              <div className="nx-pressure-gauge">
                <div className={cls('nx-gauge-dot', `is-pressure-${model?.apiPressureLevel || 'low'}`)} />
                <span>API Pressure: {model?.apiPressureLevel.toUpperCase()}</span>
              </div>
            </div>
          </div>
        </aside>

        <main className="nx-queue-main">
          <div className="nx-queue-scroll-area">
            {viewMode === 'today' && (
              <div className="nx-today-view" data-testid="queue-today-view">
                {timeBuckets.map(bucket => {
                  const items = filteredItems.filter(bucket.filter)
                  if (items.length === 0) return null
                  return (
                    <div key={bucket.label} className="nx-queue-group">
                      <div className="nx-queue-group-header">
                        <h3>{bucket.label}</h3>
                        <span className="nx-queue-group-count">{items.length}</span>
                      </div>
                      <div className="nx-operational-stack">
                        {/* Table Header for Today View Rows */}
                        <div className="nx-operational-row is-header">
                          <div className="nx-op-cell is-seller">Seller & Property</div>
                          <div className="nx-op-cell is-status">Stage</div>
                          <div className="nx-op-cell is-action">Next Action</div>
                          <div className="nx-op-cell is-timing">Timing & Market</div>
                          <div className="nx-op-cell is-ai">AI Confidence</div>
                          <div className="nx-op-cell is-agent">Agent</div>
                        </div>
                        {items.map((item: QueueItem) => (
                          <OperationalRow
                            key={item.id} 
                            item={item} 
                            isSelected={selectedItemId === item.id}
                            onClick={() => handleSelectItem(item.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })}
                {filteredItems.length === 0 && (
                  <div className="nx-queue-empty">
                    <p>No items scheduled for today.</p>
                  </div>
                )}
              </div>
            )}

            {viewMode === 'list' && (
              <div className="nx-list-view" data-testid="queue-list-view">
                <div className="nx-queue-table-container">
                  <table className="nx-queue-table is-dense">
                    <thead>
                      <tr>
                        <th>Seller / Property</th>
                        <th>Campaign Metadata</th>
                        <th style={{ width: '25%' }}>Message Preview</th>
                        <th>Status</th>
                        <th>Scheduled</th>
                        <th>Market</th>
                        <th>Agent</th>
                        <th>Stage</th>
                        <th>Temp</th>
                        <th>Risk</th>
                        <th className="nx-table-actions-th">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((item: QueueItem) => (
                        <tr 
                          key={item.id} 
                          className={cls(selectedItemId === item.id && 'is-selected')}
                          onClick={() => handleSelectItem(item.id)}
                        >
                          <td>
                            <div className="nx-cell-owner">
                              <strong>{item.sellerName}</strong>
                              <small>{item.propertyAddress}</small>
                            </div>
                          </td>
                          <td>
                            <div className="nx-cell-owner nx-cell-owner--metadata">
                              <small>campaign_id: {item.campaignId || '—'}</small>
                              <small>campaign_target_id: {item.campaignTargetId || '—'}</small>
                            </div>
                          </td>
                          <td className="nx-cell-preview">
                            <span className="nx-preview-text">{item.messageText}</span>
                          </td>
                          <td><StatusBadge status={item.status} /></td>
                          <td>{formatRelativeTime(item.scheduledForLocal)}</td>
                          <td>{item.market}</td>
                          <td>{item.agent}</td>
                          <td>{item.currentStage}</td>
                          <td>
                            <span className={cls('nx-temp-dot', `is-${item.sellerTemperature}`)} />
                          </td>
                          <td>{item.urgencyScore > 75 ? <RiskTag level="high" /> : <RiskTag level={item.riskLevel} />}</td>
                          <td>
                            <div className="nx-table-quick-actions" onClick={e => e.stopPropagation()}>
                              {(item.status === 'ready' || item.status === 'scheduled') && (
                                <button className="nx-icon-btn" title="Hold" onClick={() => handleAction('hold', item.id)}><Icon name="shield" /></button>
                              )}
                              {item.status === 'failed' && item.retryEligible && (
                                <button className="nx-icon-btn is-primary" title="Retry" onClick={() => handleAction('retry', item.id)}><Icon name="zap" /></button>
                              )}
                              <button className="nx-icon-btn" title="Edit" onClick={() => emitNotification({ title: 'Not Implemented', detail: 'Inline edit requires backend API', severity: 'warning', sound: 'notification' })}><Icon name="file-text" /></button>
                              <button className="nx-icon-btn is-danger" title="Suppress" onClick={() => handleAction('cancel', item.id)}><Icon name="close" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredItems.length === 0 && (
                        <tr>
                          <td colSpan={11} className="nx-table-empty">
                            No items found in the current view.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {viewMode === 'approval' && (
              <div className="nx-approval-stack" data-testid="queue-approval-view">
                {filteredItems.map((item: QueueItem) => (
                  <div key={item.id} className={cls('nx-approval-card', selectedItemId === item.id && 'is-selected')} onClick={() => handleSelectItem(item.id)}>
                    <div className="nx-approval-card-header">
                      <div className="nx-approval-seller">
                        <h4>{item.sellerName}</h4>
                        <span>{item.propertyAddress}</span>
                      </div>
                      <div className="nx-approval-meta-tags">
                        <span className="nx-tag is-warning"><Icon name="shield" /> {item.approvalReason || 'Human Review Required'}</span>
                        <span className={cls('nx-tag', item.aiConfidence > 80 ? 'is-success' : 'is-error')}>AI Confidence: {item.aiConfidence}%</span>
                      </div>
                    </div>

                    <div className="nx-approval-card-body">
                      <div className="nx-approval-context">
                        <div className="nx-context-row">
                          <span className="nx-label">Extracted Intent:</span>
                          <span className="nx-value">{item.extractedIntent || 'Unknown'}</span>
                        </div>
                        <div className="nx-context-row">
                          <span className="nx-label">Seller Temp:</span>
                          <span className="nx-value is-caps">{item.sellerTemperature}</span>
                        </div>
                        {item.priorThreadSummary && (
                          <div className="nx-context-row is-full">
                            <span className="nx-label">Prior Thread Summary:</span>
                            <span className="nx-value">{item.priorThreadSummary}</span>
                          </div>
                        )}
                      </div>

                      <div className="nx-approval-message-box">
                        <div className="nx-message-box-header">
                          <span>Proposed AI Reply</span>
                          <span className="nx-template-name">{item.templateName}</span>
                        </div>
                        <p>{item.messageText}</p>
                      </div>
                    </div>

                    <div className="nx-approval-card-footer" onClick={e => e.stopPropagation()}>
                      <button className="nx-btn nx-btn--primary" onClick={() => handleAction('approve', item.id)}>
                        <Icon name="check" /> Approve
                      </button>
                      <button className="nx-btn nx-btn--secondary" onClick={() => emitNotification({ title: 'Not Implemented', detail: 'Inline edit requires backend API', severity: 'warning', sound: 'notification' })}>
                        <Icon name="file-text" /> Edit
                      </button>
                      <button className="nx-btn nx-btn--secondary" onClick={() => handleAction('hold', item.id)}>
                        <Icon name="shield" /> Hold
                      </button>
                      <button className="nx-btn nx-btn--danger" onClick={() => handleAction('cancel', item.id)}>
                        <Icon name="close" /> Suppress
                      </button>
                    </div>
                  </div>
                ))}
                {filteredItems.length === 0 && (
                  <div className="nx-queue-empty">
                    <p>No items pending human approval.</p>
                  </div>
                )}
              </div>
            )}

            {viewMode === 'failed' && (
              <div className="nx-failure-stack" data-testid="queue-failed-view">
                {failedGroups.map(({ group, items }: { group: string, items: QueueItem[] }) => (
                  <div key={group} className="nx-failure-group">
                    <div className="nx-failure-group-header">
                      <h3>{group} Failures</h3>
                      <span className="nx-count-badge">{items.length}</span>
                    </div>
                    <div className="nx-operational-stack is-nested">
                      {items.map((item: QueueItem) => (
                        <div
                          key={item.id}
                          className={cls('nx-failure-item', selectedItemId === item.id && 'is-selected')}
                          onClick={() => handleSelectItem(item.id)}
                        >
                          <div className="nx-failure-item-top">
                            <div className="nx-failure-item-identity">
                              <strong>{item.sellerName}</strong>
                              <span>{item.propertyAddress}</span>
                            </div>
                            <span className="nx-failure-reason">{item.failureReason || 'Unknown Error'}</span>
                          </div>
                          <div className="nx-failure-item-bottom">
                            <span className="nx-failure-meta">
                              Attempt {item.retryCount} of {item.maxRetries} • {item.retryEligible ? 'Retry Eligible' : 'Human Action Required'}
                            </span>
                            <div className="nx-failure-actions" onClick={e => e.stopPropagation()}>
                              {item.retryEligible && (
                                <button className="nx-btn nx-btn--xs nx-btn--primary" onClick={() => handleAction('retry', item.id)}>
                                  <Icon name="zap" style={{ width: 12, height: 12, marginRight: 4 }} /> Retry
                                </button>
                              )}
                              <button className="nx-btn nx-btn--xs nx-btn--secondary" onClick={() => emitNotification({ title: 'Not Implemented', detail: 'Rerouting requires backend support.', severity: 'warning', sound: 'notification' })}>
                                Reroute
                              </button>
                              <button className="nx-btn nx-btn--xs nx-btn--danger" onClick={() => handleAction('cancel', item.id)}>
                                Suppress
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {failedGroups.length === 0 && (
                  <div className="nx-queue-empty">
                    <p>No failed items in queue.</p>
                  </div>
                )}
              </div>
            )}

            {viewMode === 'week' && (
              <div className="nx-week-board" data-testid="queue-week-view">
                <div className="nx-campaign-swimlanes">
                  {weekClusters.map((cluster: { market: string, temp: string, stage: string, items: QueueItem[] }) => (
                    <div key={`${cluster.market}-${cluster.temp}-${cluster.stage}`} className="nx-campaign-cluster">
                      <div className="nx-cluster-header">
                        <div className="nx-cluster-identity">
                          <h3>{cluster.market.toUpperCase()}</h3>
                          <span className={cls('nx-cluster-tag', `is-${cluster.temp}`)}>{cluster.temp}</span>
                          <span className="nx-cluster-tag is-stage">{cluster.stage}</span>
                        </div>
                        <div className="nx-cluster-metrics">
                          <span>{cluster.items.length} Sellers</span>
                          <span>{cluster.items.filter((i: QueueItem) => i.urgencyScore > 50).length} High Urgency</span>
                        </div>
                      </div>

                      <div className="nx-operational-stack is-nested">
                        {cluster.items.map((item: QueueItem) => (
                          <OperationalRow
                            key={item.id}
                            item={item}
                            isSelected={selectedItemId === item.id}
                            onClick={() => handleSelectItem(item.id)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {weekClusters.length === 0 && (
                    <div className="nx-queue-empty">
                      <p>No campaign clusters active for this week.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {viewMode === 'month' && (
              <div className="nx-month-heatmap" data-testid="queue-month-view">
                 {/* Heatmap Calendar */}
                 <div className="nx-queue-month-grid">
                   {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                     <div key={day} className="nx-month-day-label">{day}</div>
                   ))}
                   {/* Empty cells for start of month alignment */}
                   <div className="nx-month-cell is-empty" />
                   <div className="nx-month-cell is-empty" />
                   {Array.from({ length: 30 }).map((_, i) => {
                     // Generate deterministic metrics from array index to avoid Math.random
                     const outVolume = (i * 13) % 120 + 20
                     const inVolume = (i * 7) % 5
                     const activityLevel = outVolume > 100 ? 4 : outVolume > 70 ? 3 : outVolume > 40 ? 2 : 1
                     const isSelected = selectedItemId === `day-${i}`

                     return (
                       <div
                         key={i}
                         className={cls('nx-month-cell', i === 14 && 'is-today', isSelected && 'is-selected')}
                         onClick={() => handleSelectItem(`day-${i}`)}
                       >
                         <span className="nx-month-date">{i + 1}</span>
                         <div className="nx-month-intensity" data-level={activityLevel} />
                         <div className="nx-month-metrics">
                           <span>{outVolume} Out</span>
                           <span style={{ color: 'var(--success)' }}>{inVolume} In</span>
                         </div>
                       </div>
                     )
                   })}
                 </div>

                 {/* Cadence Timeline */}
                 <div className="nx-forecast-timeline">
                   <h3>Automation Cadence Timeline</h3>
                   <div className="nx-timeline-track">
                     <div className="nx-timeline-marker" style={{ left: '15%' }} title="Nurture Wave" />
                     <div className="nx-timeline-marker is-spike" style={{ left: '45%' }} title="High Volume Outreach" />
                     <div className="nx-timeline-marker" style={{ left: '80%' }} title="Follow-up Cycle" />
                   </div>
                   <div className="nx-operational-stack is-nested">
                      {filteredItems.slice(0, 5).map((item: QueueItem) => (
                        <OperationalRow
                          key={item.id}
                          item={item}
                          isSelected={selectedItemId === item.id}
                          onClick={() => handleSelectItem(item.id)}
                        />
                      ))}
                   </div>
                 </div>
              </div>
            )}
          </div>
        </main>

        <TacticalIntelligenceStack
          item={selectedItem} 
          onAction={handleAction} 
          viewMode={viewMode}
        />
      </div>
    </div>
  )
}
