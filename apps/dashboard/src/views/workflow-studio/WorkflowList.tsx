import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { Icon } from '../../shared/icons'
import type { IconName } from '../../shared/icons'
import type { Workflow, WorkflowDetail, WorkflowDryRunResult } from './workflow.types'
import { WorkflowDryRunPreview } from './WorkflowDryRunPreview'
import { WorkflowSenderPoolPanel } from './WorkflowSenderPoolPanel'
import { WorkflowTemplatesPanel } from './WorkflowTemplatesPanel'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const statusLabel = (status: string) =>
  status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())

export interface WorkflowNodeLibraryItem {
  label: string
  type: string
  icon: IconName
  description: string
  favorite?: boolean
  category?: string
}

export const workflowNodeCategories: Array<{ title: string; items: WorkflowNodeLibraryItem[] }> = [
  {
    title: 'Triggers',
    items: [
      ['New Lead', 'trigger_new_lead'],
      ['Inbound SMS Received', 'trigger_inbound_sms_received'],
      ['Inbound Email Received', 'trigger_inbound_email_received'],
      ['SMS Delivered', 'trigger_sms_delivered'],
      ['SMS Failed', 'trigger_sms_failed'],
      ['No Reply After Delay', 'trigger_no_reply_after_delay'],
      ['Follow-Up Due', 'trigger_follow_up_due'],
      ['Seller Replied', 'trigger_seller_replied'],
      ['Seller Positive Reply', 'trigger_seller_positive_reply'],
      ['Seller Negative Reply', 'trigger_seller_negative_reply'],
      ['Seller Price Reply', 'trigger_seller_price_reply'],
      ['Seller Opted Out', 'trigger_seller_opted_out'],
      ['Wrong Number Detected', 'trigger_wrong_number_detected'],
      ['Status Changed', 'trigger_status_changed'],
      ['Stage Changed', 'trigger_stage_changed'],
      ['Temperature Changed', 'trigger_temperature_changed'],
      ['Buyer Match Found', 'trigger_buyer_match_found'],
      ['Comp Confidence High', 'trigger_comp_confidence_high'],
      ['Offer Approved', 'trigger_offer_approved'],
      ['Contract Signed', 'trigger_contract_signed'],
      ['Title Issue Detected', 'trigger_title_issue_detected'],
      ['Queue Item Failed', 'trigger_queue_item_failed'],
      ['Sender Health Dropped', 'trigger_sender_health_dropped'],
      ['Template Performance Changed', 'trigger_template_performance_changed'],
      ['Market Health Changed', 'trigger_market_health_changed'],
    ].map(([label, type]) => ({
      label,
      type,
      icon: 'bolt',
      description: `Start when ${label.toLowerCase()} is detected.`,
      favorite: ['New Lead', 'Seller Replied', 'No Reply After Delay'].includes(label),
    })),
  },
  {
    title: 'Communication',
    items: [
      { label: 'Send SMS', type: 'send_sms', icon: 'send', description: 'Render a guarded SMS template and route through a sender pool.', favorite: true },
      { label: 'Send Email', type: 'send_email', icon: 'mail', description: 'Render an email template through the workflow template studio.' },
      { label: 'Send RVM', type: 'send_rvm', icon: 'mic', description: 'Prepare a ringless voicemail action for later execution controls.' },
      { label: 'Send Direct Mail', type: 'send_direct_mail', icon: 'file-text', description: 'Prepare a direct mail action using market-scoped template data.' },
      { label: 'Send Offer', type: 'send_offer', icon: 'dollar-sign', description: 'Send an offer after deal intelligence and approval checks.', favorite: true },
      { label: 'Send Contract', type: 'send_contract', icon: 'file-text', description: 'Send a contract only behind approval and live-send guards.' },
      { label: 'Email Title Company', type: 'email_title_company', icon: 'briefcase', description: 'Notify title with deal metadata and operator context.' },
    ],
  },
  {
    title: 'Timing',
    items: [
      { label: 'Wait', type: 'wait', icon: 'clock', description: 'Pause the path for a fixed duration.', favorite: true },
      { label: 'Wait Until Business Hours', type: 'wait_until_business_hours', icon: 'calendar', description: 'Hold execution until the local business window opens.' },
      { label: 'Wait Until Local Time Window', type: 'wait_until_local_time_window', icon: 'clock', description: 'Respect market timezone windows before continuing.' },
      { label: 'Wait Until Weekday', type: 'wait_until_weekday', icon: 'calendar', description: 'Avoid weekend execution windows.' },
      { label: 'Wait Until Follow-Up Due', type: 'wait_until_follow_up_due', icon: 'clock', description: 'Resume when the thread follow-up clock is due.' },
    ],
  },
  {
    title: 'Conditions',
    items: [
      ['If Seller Replied', 'condition_seller_replied'],
      ['If No Reply', 'condition_no_reply'],
      ['If Language', 'condition_language'],
      ['If Market', 'condition_market'],
      ['If State', 'condition_state'],
      ['If Property Type', 'condition_property_type'],
      ['If Asset Type', 'condition_asset_type'],
      ['If Equity Above', 'condition_equity_above'],
      ['If Motivation Score Above', 'condition_motivation_score_above'],
      ['If Temperature', 'condition_temperature'],
      ['If Stage', 'condition_stage'],
      ['If Buyer Demand Above', 'condition_buyer_demand_above'],
      ['If Offer Approved', 'condition_offer_approved'],
      ['If Contract Signed', 'condition_contract_signed'],
    ].map(([label, type]) => ({
      label,
      type,
      icon: 'layout-split',
      description: `Branch the path by ${label.replace(/^If /, '').toLowerCase()}.`,
      favorite: ['If Seller Replied', 'If No Reply', 'If Language'].includes(label),
    })),
  },
  {
    title: 'Deal Intelligence',
    items: [
      { label: 'Run Comps', type: 'run_comps', icon: 'stats', description: 'Refresh valuation inputs before offer logic.' },
      { label: 'Run Buyer Match', type: 'run_buyer_match', icon: 'target', description: 'Score buyer demand and dispo fit.' },
      { label: 'Calculate Offer', type: 'calculate_offer', icon: 'dollar-sign', description: 'Calculate an offer from ARV, repairs, and demand.', favorite: true },
      { label: 'Push to Underwriting', type: 'push_to_underwriting', icon: 'briefcase', description: 'Send the deal to underwriting review.' },
      { label: 'Generate Contract', type: 'generate_contract', icon: 'file-text', description: 'Prepare contract data without sending live documents.' },
      { label: 'Require Approval', type: 'require_approval', icon: 'shield', description: 'Require operator approval before risky actions.', favorite: true },
      { label: 'Move to Closing', type: 'move_to_closing', icon: 'check-double', description: 'Advance approved deals into the closing workflow.' },
    ],
  },
  {
    title: 'State & Ops',
    items: [
      { label: 'Update Status', type: 'update_status', icon: 'refresh-cw', description: 'Patch thread status after a workflow decision.' },
      { label: 'Update Stage', type: 'update_stage', icon: 'flag', description: 'Move the seller through the acquisition stage map.' },
      { label: 'Update Temperature', type: 'update_temperature', icon: 'trending-up', description: 'Adjust lead temperature from reply intelligence.' },
      { label: 'Assign Operator', type: 'assign_operator', icon: 'user', description: 'Assign follow-up ownership to an operator.' },
      { label: 'Create Task', type: 'create_task', icon: 'check', description: 'Create a work item for manual review.' },
      { label: 'Create Notification', type: 'create_notification', icon: 'bell', description: 'Notify operators without sending outbound seller messages.' },
      { label: 'Cancel Queue', type: 'cancel_queue', icon: 'slash', description: 'Cancel pending queue actions for a thread.' },
      { label: 'Suppress Phone', type: 'suppress_phone', icon: 'phone', description: 'Suppress a phone number before outbound routing.', favorite: true },
      { label: 'Suppress Owner', type: 'suppress_owner', icon: 'users', description: 'Suppress an owner across future workflow runs.' },
      { label: 'Pause Workflow', type: 'pause_workflow', icon: 'pause', description: 'Pause automation while preserving audit context.' },
      { label: 'Stop Workflow', type: 'stop_workflow', icon: 'close', description: 'Terminate a workflow path cleanly.' },
    ],
  },
]

const suggestedNodeTypes = new Set([
  'trigger_new_lead',
  'send_sms',
  'wait',
  'condition_no_reply',
  'suppress_phone',
  'require_approval',
])

export const workflowAllNodes = workflowNodeCategories.flatMap((category) =>
  category.items.map((item) => ({ ...item, category: category.title })),
)

export const getWorkflowNodeByType = (nodeType: string) =>
  workflowAllNodes.find((item) => item.type === nodeType) ?? null

type RailMode = 'workflows' | 'nodes' | 'templates' | 'sender-pools' | 'filters' | 'runs'
type UtilityDrawerTab = 'Dry Run' | 'Run Log' | 'Audit'

const railModes: Array<{ id: RailMode; label: string; icon: IconName }> = [
  { id: 'workflows', label: 'Workflows', icon: 'layers' },
  { id: 'nodes', label: 'Nodes', icon: 'grid' },
  { id: 'templates', label: 'Templates', icon: 'message' },
  { id: 'sender-pools', label: 'Sender Pools', icon: 'phone' },
  { id: 'filters', label: 'Filters', icon: 'filter' },
  { id: 'runs', label: 'Runs', icon: 'activity' },
]

interface WorkflowListProps {
  workflows: Workflow[]
  detail: WorkflowDetail | null
  dryRunResult: WorkflowDryRunResult | null
  selectedId?: string | null
  loading?: boolean
  busy?: boolean
  onSelect: (workflowId: string) => void
  onAddNode: (item: WorkflowNodeLibraryItem) => void
  onCreateTemplateSet: (payload: Record<string, unknown>) => Promise<void>
  onCreateTemplateVariant: (templateSetId: string, payload: Record<string, unknown>) => Promise<void>
  onRenderVariant: (variantId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  onSaveTranslation: (variantId: string, payload: Record<string, unknown>) => Promise<void>
  onCreateSenderPool: (payload: Record<string, unknown>) => Promise<void>
  onCreateSenderMember: (senderPoolId: string, payload: Record<string, unknown>) => Promise<void>
  onDryRun: (payload: Record<string, unknown>) => Promise<void>
  onOpenUtilityDrawer: (tab: UtilityDrawerTab) => void
}

function WorkflowRows({
  workflows,
  selectedId,
  loading,
  onSelect,
}: Pick<WorkflowListProps, 'workflows' | 'selectedId' | 'loading' | 'onSelect'>) {
  return (
    <div className="wfs-list__items">
      {loading && workflows.length === 0 ? (
        <div className="wfs-empty">Loading workflows</div>
      ) : workflows.length === 0 ? (
        <div className="wfs-empty">No workflows</div>
      ) : workflows.map((workflow) => (
        <button
          key={workflow.id}
          type="button"
          className={cls('wfs-workflow-row', selectedId === workflow.id && 'is-active')}
          onClick={() => onSelect(workflow.id)}
        >
          <span className="wfs-workflow-row__icon">
            <Icon name={workflow.channel === 'email' ? 'mail' : 'send'} />
          </span>
          <span className="wfs-workflow-row__main">
            <strong>{workflow.name}</strong>
            <span>{workflow.workflow_key}</span>
          </span>
          <span className={cls('wfs-status', `is-${workflow.status}`)}>
            {statusLabel(workflow.status)}
          </span>
        </button>
      ))}
    </div>
  )
}

function NodePalette({
  detail,
  busy,
  onAddNode,
}: {
  detail: WorkflowDetail | null
  busy?: boolean
  onAddNode: (item: WorkflowNodeLibraryItem) => void
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const canCreateNode = Boolean(detail && !busy)
  const suggestedNodes = useMemo(
    () => workflowAllNodes.filter((item) => suggestedNodeTypes.has(item.type)),
    [],
  )
  const filteredCategories = useMemo(() => {
    if (!normalizedQuery) return workflowNodeCategories
    return workflowNodeCategories
      .map((category) => ({
        ...category,
        items: category.items.filter((item) =>
          `${item.label} ${item.type} ${item.description}`.toLowerCase().includes(normalizedQuery),
        ),
      }))
      .filter((category) => category.items.length > 0)
  }, [normalizedQuery])

  const startDrag = (event: DragEvent<HTMLButtonElement>, item: WorkflowNodeLibraryItem) => {
    if (!canCreateNode) return
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-workflow-node', JSON.stringify({ type: item.type }))
    event.dataTransfer.setData('text/plain', item.type)
  }

  const renderNodeButton = (item: WorkflowNodeLibraryItem, suggested = false) => (
    <button
      key={item.type}
      type="button"
      className={cls('wfs-library-node', suggested && 'is-suggested')}
      data-node-type={item.type}
      title={canCreateNode ? item.description : 'Select or create a workflow before adding nodes'}
      disabled={!canCreateNode}
      draggable={canCreateNode}
      onClick={() => onAddNode(item)}
      onDragStart={(event) => startDrag(event, item)}
    >
      <Icon name={item.icon} />
      <span>
        <strong>{item.label}</strong>
        <small>{suggested ? item.category : item.description}</small>
      </span>
      {item.favorite ? <Icon name="star" /> : <Icon name="drag" />}
    </button>
  )

  return (
    <div className="wfs-node-library">
      <header className="wfs-node-library__header">
        <div>
          <span className="wfs-kicker">Node Studio</span>
          <strong>Palette</strong>
        </div>
        <span>{workflowAllNodes.length}</span>
      </header>

      <label className="wfs-node-search">
        <Icon name="search" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes" />
      </label>

      {!detail && (
        <div className="wfs-studio-hint">
          <Icon name="shield" />
          <span>Select or create a workflow to drop nodes onto the canvas.</span>
        </div>
      )}

      {!normalizedQuery && (
        <section className="wfs-suggested-nodes">
          <header>
            <span>Suggested</span>
            <strong>{suggestedNodes.length}</strong>
          </header>
          <div className="wfs-suggested-nodes__grid">
            {suggestedNodes.map((item) => renderNodeButton(item, true))}
          </div>
        </section>
      )}

      {filteredCategories.length === 0 ? (
        <div className="wfs-command-empty is-compact">
          <Icon name="search" />
          <strong>No nodes found</strong>
          <span>Try a trigger, send, condition, approval, or suppression term.</span>
        </div>
      ) : filteredCategories.map((category) => (
        <details key={category.title} className="wfs-node-category" open={category.title !== 'Triggers' || Boolean(normalizedQuery)}>
          <summary>
            <span>{category.title}</span>
            <strong>{category.items.length}</strong>
          </summary>
          <div className="wfs-node-category__items">
            {category.items.map((item) => renderNodeButton(item))}
          </div>
        </details>
      ))}
    </div>
  )
}

function FiltersStudio({ detail }: { detail: WorkflowDetail | null }) {
  if (!detail) {
    return (
      <div className="wfs-command-empty">
        <Icon name="filter" />
        <strong>No workflow selected</strong>
        <span>Filter scope appears after a workflow is selected.</span>
      </div>
    )
  }

  const filterRows = [
    ['Markets', detail.workflow.market_scope?.join(', ') || 'all'],
    ['States', detail.workflow.state_scope?.join(', ') || 'all'],
    ['Languages', detail.workflow.language_scope?.join(', ') || 'all'],
    ['Property Types', detail.workflow.property_type_scope?.join(', ') || 'all'],
    ['Owner Types', detail.workflow.owner_type_scope?.join(', ') || 'all'],
    ['Daily Cap', String(detail.workflow.daily_cap ?? 'n/a')],
    ['Hourly Cap', String(detail.workflow.hourly_cap ?? 'n/a')],
    ['Timezone', detail.workflow.timezone || 'America/Chicago'],
  ]

  return (
    <div className="wfs-side-studio">
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Filter Studio</span>
            <h3>Workflow Scope</h3>
          </div>
          <span className="wfs-count">{filterRows.length}</span>
        </header>
        <div className="wfs-filter-grid">
          {filterRows.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Guardrails</span>
            <h3>Outbound Safety</h3>
          </div>
        </header>
        <div className="wfs-side-proof">
          <span><Icon name="shield" /> live_send_enabled=false</span>
          <span><Icon name="activity" /> dry-run validation required</span>
          <span><Icon name="filter" /> filters are read-only here</span>
        </div>
      </section>
    </div>
  )
}

function RunsStudio({
  detail,
  dryRunResult,
  busy,
  onDryRun,
  onOpenUtilityDrawer,
}: Pick<WorkflowListProps, 'detail' | 'dryRunResult' | 'busy' | 'onDryRun' | 'onOpenUtilityDrawer'>) {
  if (!detail) {
    return (
      <div className="wfs-command-empty">
        <Icon name="activity" />
        <strong>No workflow selected</strong>
        <span>Run controls and logs appear after a workflow is selected.</span>
      </div>
    )
  }

  return (
    <div className="wfs-side-studio">
      <WorkflowDryRunPreview
        detail={detail}
        busy={busy}
        result={dryRunResult}
        onDryRun={onDryRun}
      />
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Utility Drawer</span>
            <h3>Logs</h3>
          </div>
        </header>
        <div className="wfs-actions">
          <button type="button" onClick={() => onOpenUtilityDrawer('Dry Run')}><Icon name="activity" /> Dry Run</button>
          <button type="button" onClick={() => onOpenUtilityDrawer('Run Log')}><Icon name="list" /> Run Log</button>
          <button type="button" onClick={() => onOpenUtilityDrawer('Audit')}><Icon name="database" /> Audit</button>
        </div>
      </section>
    </div>
  )
}

export const WorkflowList = ({
  workflows,
  detail,
  dryRunResult,
  selectedId,
  loading,
  busy,
  onSelect,
  onAddNode,
  onCreateTemplateSet,
  onCreateTemplateVariant,
  onRenderVariant,
  onSaveTranslation,
  onCreateSenderPool,
  onCreateSenderMember,
  onDryRun,
  onOpenUtilityDrawer,
}: WorkflowListProps) => {
  const [mode, setMode] = useState<RailMode>('nodes')
  const templateVariantCount = detail?.template_sets.reduce((count, set) => count + (set.variants?.length ?? 0), 0) ?? 0
  const senderCount = detail?.sender_pools.reduce((count, pool) => count + (pool.members?.length ?? 0), 0) ?? 0

  return (
    <aside className={cls('wfs-list', `is-mode-${mode}`)}>
      <nav className="wfs-studio-rail" aria-label="Workflow Studio modes">
        {railModes.map((item) => (
          <button
            key={item.id}
            type="button"
            className={mode === item.id ? 'is-active' : ''}
            onClick={() => setMode(item.id)}
            title={item.label}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="wfs-studio-column">
        <header className="wfs-list__header">
          <div>
            <span className="wfs-kicker">Builder Rail</span>
            <h2>{railModes.find((item) => item.id === mode)?.label ?? 'Studio'}</h2>
          </div>
          <span className="wfs-count">
            {mode === 'workflows'
              ? workflows.length
              : mode === 'templates'
                ? templateVariantCount
                : mode === 'sender-pools'
                  ? senderCount
                  : mode === 'runs'
                    ? dryRunResult?.steps.length ?? 0
                    : workflowAllNodes.length}
          </span>
        </header>

        {mode === 'workflows' && (
          <WorkflowRows
            workflows={workflows}
            selectedId={selectedId}
            loading={loading}
            onSelect={onSelect}
          />
        )}

        {mode === 'nodes' && (
          <NodePalette
            detail={detail}
            busy={busy}
            onAddNode={onAddNode}
          />
        )}

        {mode === 'templates' && (
          detail ? (
            <WorkflowTemplatesPanel
              detail={detail}
              busy={busy}
              onCreateTemplateSet={onCreateTemplateSet}
              onCreateTemplateVariant={onCreateTemplateVariant}
              onRenderVariant={onRenderVariant}
              onSaveTranslation={onSaveTranslation}
            />
          ) : (
            <div className="wfs-command-empty">
              <Icon name="message" />
              <strong>No workflow selected</strong>
              <span>Template Studio attaches template sets and variants to workflow send nodes.</span>
            </div>
          )
        )}

        {mode === 'sender-pools' && (
          detail ? (
            <WorkflowSenderPoolPanel
              detail={detail}
              busy={busy}
              onCreateSenderPool={onCreateSenderPool}
              onCreateSenderMember={onCreateSenderMember}
            />
          ) : (
            <div className="wfs-command-empty">
              <Icon name="phone" />
              <strong>No workflow selected</strong>
              <span>Sender Pool Studio manages dry-run sender routing for communication nodes.</span>
            </div>
          )
        )}

        {mode === 'filters' && <FiltersStudio detail={detail} />}

        {mode === 'runs' && (
          <RunsStudio
            detail={detail}
            dryRunResult={dryRunResult}
            busy={busy}
            onDryRun={onDryRun}
            onOpenUtilityDrawer={onOpenUtilityDrawer}
          />
        )}
      </div>
    </aside>
  )
}
