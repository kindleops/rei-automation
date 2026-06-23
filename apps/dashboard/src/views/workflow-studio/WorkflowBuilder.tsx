import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from 'react'
import { Icon } from '../../shared/icons'
import type { IconName } from '../../shared/icons'
import type {
  WorkflowDetail,
  WorkflowDryRunResult,
  WorkflowDryRunStep,
  WorkflowStep,
} from './workflow.types'
import { WorkflowDryRunPreview } from './WorkflowDryRunPreview'
import { getWorkflowNodeByType, type WorkflowNodeLibraryItem } from './WorkflowList'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const bottomTabs = ['Dry Run', 'Run Log', 'Audit'] as const
const CANVAS_WIDTH = 2260
const CANVAS_HEIGHT = 720
const NODE_WIDTH = 252
const NODE_CENTER_Y = 57
const DEFAULT_DROP_POSITION = { x: 380, y: 255 }

interface WorkflowBuilderProps {
  detail: WorkflowDetail | null
  busy?: boolean
  dryRunResult: WorkflowDryRunResult | null
  utilityDrawerOpen: boolean
  utilityDrawerTab: typeof bottomTabs[number]
  onOpenUtilityDrawer: (tab: typeof bottomTabs[number]) => void
  onCloseUtilityDrawer: () => void
  onCreate: (payload: Record<string, unknown>) => Promise<void>
  onClone: () => Promise<void>
  onPause: () => Promise<void>
  onResume: () => Promise<void>
  onCreateStep: (payload: Record<string, unknown>) => Promise<void>
  onUpdateStep: (stepId: string, payload: Record<string, unknown>) => Promise<void>
  onCreateTemplateSet: (payload: Record<string, unknown>) => Promise<void>
  onCreateTemplateVariant: (templateSetId: string, payload: Record<string, unknown>) => Promise<void>
  onRenderVariant: (variantId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  onSaveTranslation: (variantId: string, payload: Record<string, unknown>) => Promise<void>
  onCreateSenderPool: (payload: Record<string, unknown>) => Promise<void>
  onCreateSenderMember: (senderPoolId: string, payload: Record<string, unknown>) => Promise<void>
  onDryRun: (payload: Record<string, unknown>) => Promise<void>
}

type NodeFamily = 'trigger' | 'send' | 'wait' | 'condition' | 'intelligence' | 'ops' | 'safety' | 'approval'
type ConnectionKind = 'true' | 'false' | 'next'
type ValidationSeverity = 'error' | 'warning'
type CanvasPosition = { x: number; y: number }

interface CanvasNode {
  id: string
  key: string
  label: string
  nodeType: string
  x: number
  y: number
  step?: WorkflowStep
  paths?: {
    true_path?: string
    false_path?: string
    next_path?: string
  }
}

interface CanvasConnection {
  id: string
  from: CanvasNode
  to: CanvasNode
  kind: ConnectionKind
}

interface ValidationFinding {
  id: string
  label: string
  detail: string
  severity: ValidationSeverity
}

const emptyBlueprint: CanvasNode[] = [
  { id: 'preview-trigger', key: 'new_lead_trigger', label: 'New Lead', nodeType: 'trigger_new_lead', x: 96, y: 282, paths: { next_path: 'send_initial_sms' } },
  { id: 'preview-sms', key: 'send_initial_sms', label: 'Send SMS', nodeType: 'send_sms', x: 382, y: 282, paths: { next_path: 'wait_two_days' } },
  { id: 'preview-wait', key: 'wait_two_days', label: 'Wait 2 Days', nodeType: 'wait', x: 668, y: 282, paths: { next_path: 'if_no_reply' } },
  { id: 'preview-condition', key: 'if_no_reply', label: 'If No Reply', nodeType: 'condition_no_reply', x: 954, y: 282, paths: { true_path: 'send_follow_up_sms', false_path: 'if_reply' } },
  { id: 'preview-followup', key: 'send_follow_up_sms', label: 'Follow-Up SMS', nodeType: 'send_sms', x: 1242, y: 154, paths: { next_path: 'create_notification' } },
  { id: 'preview-reply', key: 'if_reply', label: 'If Reply', nodeType: 'condition_seller_replied', x: 1242, y: 410, paths: { next_path: 'update_stage' } },
  { id: 'preview-stage', key: 'update_stage', label: 'Update Stage', nodeType: 'update_stage', x: 1530, y: 410, paths: { next_path: 'create_notification' } },
  { id: 'preview-notify', key: 'create_notification', label: 'Notify Operator', nodeType: 'create_notification', x: 1818, y: 410 },
]

const defaultCreatePayload = {
  name: 'Owner Acquisition Follow-Up',
  channel: 'sms',
  workflow_type: 'outbound',
  status: 'draft',
  live_send_enabled: false,
  market_scope: ['default'],
  state_scope: ['TX'],
  language_scope: ['en'],
  daily_cap: 75,
  hourly_cap: 15,
  timezone: 'America/Chicago',
}

const sampleContext = {
  write_audit: true,
  context: {
    conversation_thread_id: 'workflow-studio-preview',
    first_name: 'Jordan',
    seller_display_name: 'Jordan Seller',
    property_address: '123 Main St',
    market: 'default',
    state: 'TX',
    city: 'Austin',
    zip: '78701',
    agent_name: 'Nexus Operator',
    property_type: 'SFR',
    unit_count: '1',
    asking_price: '$250,000',
    offer_price: '$210,000',
    language: 'en',
  },
}

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasMeaningfulKeys(value: unknown) {
  return isRecord(value) && Object.keys(value).length > 0
}

function nodeFamily(nodeType: string): NodeFamily {
  if (nodeType.startsWith('trigger_')) return 'trigger'
  if (nodeType.startsWith('send_') || nodeType === 'email_title_company') return 'send'
  if (nodeType.startsWith('wait')) return 'wait'
  if (nodeType.startsWith('condition') || nodeType === 'branch') return 'condition'
  if (nodeType === 'require_approval' || nodeType.includes('approval')) return 'approval'
  if (nodeType.includes('suppress') || nodeType.includes('opt_out') || nodeType.includes('stop') || nodeType.includes('cancel')) return 'safety'
  if (['run_comps', 'run_buyer_match', 'calculate_offer', 'push_to_underwriting', 'generate_contract', 'move_to_closing'].includes(nodeType)) return 'intelligence'
  return 'ops'
}

function familyLabel(family: NodeFamily) {
  const labels: Record<NodeFamily, string> = {
    trigger: 'Trigger',
    send: 'Communication',
    wait: 'Timing',
    condition: 'Condition',
    intelligence: 'Deal Intelligence',
    ops: 'State/Ops',
    safety: 'Safety',
    approval: 'Approval',
  }
  return labels[family]
}

function nodeIcon(nodeType: string): IconName {
  const family = nodeFamily(nodeType)
  if (family === 'trigger') return 'bolt'
  if (family === 'send') return nodeType.includes('email') ? 'mail' : 'send'
  if (family === 'wait') return 'clock'
  if (family === 'condition') return 'layout-split'
  if (family === 'intelligence') return nodeType.includes('offer') ? 'dollar-sign' : 'brain'
  if (family === 'safety') return 'shield'
  if (family === 'approval') return 'check-double'
  return 'settings'
}

function stepPosition(step: WorkflowStep, index: number, localPosition?: CanvasPosition) {
  if (localPosition) return localPosition
  const ui = step.config?.ui
  const position = step.config?.position
  const maybePositionX = isRecord(position) && 'x' in position ? Number(position.x) : NaN
  const maybePositionY = isRecord(position) && 'y' in position ? Number(position.y) : NaN
  const maybeX = isRecord(ui) && 'x' in ui ? Number(ui.x) : NaN
  const maybeY = isRecord(ui) && 'y' in ui ? Number(ui.y) : NaN
  const family = nodeFamily(step.node_type)
  const branchOffset = family === 'condition' ? 0 : index % 2 === 0 ? -46 : 46
  return {
    x: Number.isFinite(maybePositionX) ? maybePositionX : Number.isFinite(maybeX) ? maybeX : 100 + (index * 286),
    y: Number.isFinite(maybePositionY) ? Math.max(48, maybePositionY) : Number.isFinite(maybeY) ? Math.max(48, maybeY - 82) : 270 + branchOffset,
  }
}

function canvasNodes(detail: WorkflowDetail | null, localPositions: Record<string, CanvasPosition>): CanvasNode[] {
  if (!detail?.steps?.length) return emptyBlueprint
  return [...detail.steps]
    .sort((a, b) => Number(a.step_order) - Number(b.step_order))
    .map((step, index) => {
      const position = stepPosition(step, index, localPositions[step.id])
      return {
        id: step.id,
        key: step.step_key,
        label: step.label,
        nodeType: step.node_type,
        x: position.x,
        y: position.y,
        step,
      }
    })
}

function canvasConnections(nodes: CanvasNode[]) {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const connections: CanvasConnection[] = []

  nodes.forEach((node, index) => {
    const conditions = node.step?.conditions ?? node.paths ?? {}
    const trueNode = byKey.get(String(conditions.true_path ?? ''))
    const falseNode = byKey.get(String(conditions.false_path ?? ''))
    const nextNode = byKey.get(String(conditions.next_path ?? ''))
    if (trueNode) connections.push({ id: `${node.id}-true-${trueNode.id}`, from: node, to: trueNode, kind: 'true' })
    if (falseNode) connections.push({ id: `${node.id}-false-${falseNode.id}`, from: node, to: falseNode, kind: 'false' })
    if (!trueNode && !falseNode && nextNode) {
      connections.push({ id: `${node.id}-next-${nextNode.id}`, from: node, to: nextNode, kind: 'next' })
    }
    if (!trueNode && !falseNode && !nextNode && nodes[index + 1]) {
      connections.push({ id: `${node.id}-next-${nodes[index + 1].id}`, from: node, to: nodes[index + 1], kind: 'next' })
    }
  })

  return connections
}

function dryRunByNode(result: WorkflowDryRunResult | null) {
  const map = new Map<string, WorkflowDryRunStep>()
  const order = new Map<string, number>()
  for (const [index, step] of (result?.steps ?? []).entries()) {
    if (step.step_id) {
      map.set(step.step_id, step)
      order.set(step.step_id, index)
    }
    if (step.step_key) {
      map.set(step.step_key, step)
      order.set(step.step_key, index)
    }
  }
  return { map, order }
}

function nodeSubtitle(node: CanvasNode, dryRunStep?: WorkflowDryRunStep) {
  const family = nodeFamily(node.nodeType)
  const config = node.step?.config ?? {}
  const conditions = (node.step?.conditions ?? node.paths ?? {}) as Record<string, unknown>
  if (dryRunStep?.rendered_template) return `${dryRunStep.rendered_template.sms?.character_count ?? 0} chars / ${dryRunStep.rendered_template.sms?.segment_count ?? 0} segments`
  if (family === 'send') return String(config.template_set_key ?? config.template_set_id ?? 'Template + sender route')
  if (family === 'wait') return `${String(node.step?.delay_amount ?? dryRunStep?.wait?.delay_amount ?? 2)} ${String(node.step?.delay_unit ?? dryRunStep?.wait?.delay_unit ?? 'days')}`
  if (family === 'condition') return `If ${titleCase(String(conditions.field ?? node.nodeType.replace(/^condition_/, '')))}`
  if (family === 'trigger') return 'Starts workflow execution'
  if (family === 'intelligence') return 'Deal signal enrichment'
  if (family === 'safety') return 'Guardrail enforcement'
  if (family === 'approval') return 'Operator approval gate'
  return 'State update or operator task'
}

function isSendCapable(nodeType: string) {
  return nodeFamily(nodeType) === 'send' || nodeType === 'send_contract' || nodeType === 'send_offer'
}

function inferConditionField(nodeType: string) {
  return nodeType.replace(/^condition_/, '').replace(/^if_/, '') || 'workflow_state'
}

function normalizeStepKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

export function buildWorkflowStepPayload(
  item: WorkflowNodeLibraryItem,
  position: CanvasPosition = DEFAULT_DROP_POSITION,
  stepOrder = 10,
) {
  const family = nodeFamily(item.type)
  const stepKey = `${normalizeStepKey(item.type)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const config: Record<string, unknown> = {
    ui: position,
    position,
    live_send_enabled: false,
    live_send_blocked: isSendCapable(item.type),
  }
  const payload: Record<string, unknown> = {
    step_key: stepKey,
    step_order: stepOrder,
    node_type: item.type,
    label: item.label,
    config,
    actions: [],
    conditions: {},
    stop_conditions: {},
    is_active: true,
  }

  if (family === 'trigger') {
    config.trigger_event = item.type.replace(/^trigger_/, '')
  }
  if (family === 'send') {
    config.template_set_key = 'default_owner_check'
    config.sender_pool_key = 'default_dry_run_pool'
    config.language = 'en'
    config.spin_syntax_enabled = true
    config.send_window = 'business_hours'
    config.approval_required = item.type === 'send_offer' || item.type === 'send_contract'
    payload.actions = [{ action_type: item.type, dry_run: true, live_enabled: false }]
  }
  if (family === 'wait') {
    payload.delay_amount = 2
    payload.delay_unit = item.type === 'wait_until_weekday' ? 'weekdays' : 'days'
    config.business_hours_only = item.type !== 'wait'
    config.timezone = 'America/Chicago'
  }
  if (family === 'condition') {
    payload.conditions = {
      field: inferConditionField(item.type),
      operator: 'equals',
      value: true,
      true_path: '',
      false_path: '',
    }
  }
  if (family === 'approval') {
    config.approval_required = true
    config.approver_role = 'Operator'
    payload.actions = [{ action_type: 'require_approval', dry_run: true, live_enabled: false }]
  }
  if (family === 'safety') {
    payload.stop_conditions = { safety_node: item.type }
    payload.actions = [{ action_type: item.type, dry_run: true, live_enabled: false }]
  }
  if (family === 'intelligence' || family === 'ops') {
    payload.actions = [{ action_type: item.type, dry_run: true, live_enabled: false }]
  }

  return payload
}

function isMissingNodeConfig(node: CanvasNode, detail: WorkflowDetail | null) {
  if (!node.step || !detail) return false
  const family = nodeFamily(node.nodeType)
  if (family === 'send') {
    return detail.template_sets.length === 0 || detail.sender_pools.length === 0
  }
  if (family === 'condition') {
    return !node.step.conditions?.true_path || !node.step.conditions?.false_path
  }
  if (family === 'wait') {
    return !node.step.delay_amount && !node.step.config?.delay_amount
  }
  return false
}

function nodeStatus(node: CanvasNode, detail: WorkflowDetail | null, dryRunStep?: WorkflowDryRunStep) {
  if (dryRunStep?.live_send_blocked || (isSendCapable(node.nodeType) && detail?.workflow.live_send_enabled !== true)) return 'Live Blocked'
  if (dryRunStep) return dryRunStep.status === 'blocked' ? 'Blocked' : 'Dry Run'
  if (isMissingNodeConfig(node, detail)) return 'Needs Config'
  return 'Ready'
}

function buildValidation(detail: WorkflowDetail | null, nodes: CanvasNode[], connections: CanvasConnection[]): ValidationFinding[] {
  if (!detail) {
    return [{
      id: 'no-workflow',
      label: 'No workflow selected',
      detail: 'Create or select a workflow before publishing.',
      severity: 'warning',
    }]
  }

  const findings = new Map<string, ValidationFinding>()
  const add = (finding: ValidationFinding) => findings.set(finding.id, finding)
  const sendNodes = nodes.filter((node) => isSendCapable(node.nodeType))
  const conditionNodes = nodes.filter((node) => nodeFamily(node.nodeType) === 'condition')
  const hasTrigger = nodes.some((node) => nodeFamily(node.nodeType) === 'trigger')
  const incoming = new Set(connections.map((connection) => connection.to.id))

  for (const error of detail.validation?.errors ?? []) {
    add({ id: `api-error-${error}`, label: titleCase(error), detail: error, severity: 'error' })
  }
  for (const warning of detail.validation?.warnings ?? []) {
    add({ id: `api-warning-${warning}`, label: titleCase(warning), detail: warning, severity: 'warning' })
  }

  if (!hasTrigger) {
    add({ id: 'no-trigger', label: 'No trigger', detail: 'Workflow needs a trigger node before it can be tested or published.', severity: 'error' })
  }
  if (sendNodes.length > 0 && detail.template_sets.length === 0) {
    add({ id: 'missing-template', label: 'Missing template', detail: 'Communication nodes need an approved template set.', severity: 'error' })
  }
  if (sendNodes.length > 0 && detail.sender_pools.length === 0) {
    add({ id: 'missing-sender-pool', label: 'Missing sender pool', detail: 'Communication nodes need a sender routing pool.', severity: 'error' })
  }
  if (detail.workflow.live_send_enabled) {
    add({ id: 'unsafe-live-send', label: 'Unsafe live send', detail: 'Live sends are marked on for this workflow and must remain blocked in this slice.', severity: 'error' })
  }
  const disconnected = nodes.filter((node, index) => index > 0 && !incoming.has(node.id) && nodeFamily(node.nodeType) !== 'trigger')
  if (disconnected.length > 0) {
    add({ id: 'disconnected-node', label: 'Disconnected node', detail: `${disconnected.length} node path${disconnected.length === 1 ? '' : 's'} are not connected.`, severity: 'warning' })
  }
  if (conditionNodes.some((node) => !node.step?.conditions?.true_path || !node.step?.conditions?.false_path)) {
    add({ id: 'missing-condition-branch', label: 'Missing condition branch', detail: 'Condition nodes should define both True and False paths.', severity: 'warning' })
  }
  const hasStopCondition = detail.steps.some((step) => hasMeaningfulKeys(step.stop_conditions) || ['stop_workflow', 'pause_workflow', 'cancel_queue'].includes(step.node_type))
  if (!hasStopCondition) {
    add({ id: 'no-stop-condition', label: 'No stop condition', detail: 'Add a stop condition for replies, opt-outs, or terminal workflow states.', severity: 'warning' })
  }
  const hasSuppression = detail.steps.some((step) => step.node_type.includes('suppress') || step.node_type.includes('opt_out'))
  if (!hasSuppression) {
    add({ id: 'no-suppression-check', label: 'No suppression check', detail: 'Suppression/opt-out protection should be visible before outbound nodes.', severity: 'warning' })
  }
  const offerOrContract = detail.steps.some((step) => step.node_type.includes('offer') || step.node_type.includes('contract'))
  const approvalGate = detail.steps.some((step) => step.node_type === 'require_approval' || step.config?.approval_required === true)
  if (offerOrContract && !approvalGate) {
    add({ id: 'no-approval-gate', label: 'No approval gate', detail: 'Offers and contracts should require an approval gate.', severity: 'warning' })
  }

  return Array.from(findings.values())
}

function formatTimestamp(value?: string) {
  if (!value) return 'Not saved'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Saved'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function FieldTile({ label, value, required }: { label: string; value: string; required?: boolean }) {
  return (
    <label className={required ? 'is-required' : ''}>
      <span>{label}{required ? ' *' : ''}</span>
      <input value={value} readOnly />
    </label>
  )
}

function ConfigSection({
  title,
  icon,
  children,
}: {
  title: string
  icon: IconName
  children: ReactNode
}) {
  return (
    <section className="wfs-config-section">
      <header>
        <Icon name={icon} />
        <strong>{title}</strong>
      </header>
      <div className="wfs-config-section__body">{children}</div>
    </section>
  )
}

function NodeConfigPanel({
  node,
  detail,
  dryRunStep,
  findings,
}: {
  node: CanvasNode | null
  detail: WorkflowDetail | null
  dryRunStep?: WorkflowDryRunStep
  findings: ValidationFinding[]
}) {
  if (!node) {
    return (
      <aside className="wfs-inspector">
        <div className="wfs-inspector__empty">
          <Icon name="settings" />
          <strong>Select a node</strong>
          <span>Inspector metadata will appear here.</span>
        </div>
      </aside>
    )
  }

  const family = nodeFamily(node.nodeType)
  const config = node.step?.config ?? {}
  const conditions = (node.step?.conditions ?? node.paths ?? {}) as Record<string, unknown>
  const isSend = family === 'send'
  const isWait = family === 'wait'
  const isCondition = family === 'condition'
  const status = nodeStatus(node, detail, dryRunStep)
  const nodeFindings = findings.filter((finding) => {
    if (isSend && (finding.id.includes('template') || finding.id.includes('sender') || finding.id.includes('live'))) return true
    if (isCondition && finding.id.includes('condition')) return true
    if (family === 'safety' && finding.id.includes('suppression')) return true
    if (['send_contract', 'send_offer', 'calculate_offer'].includes(node.nodeType) && finding.id.includes('approval')) return true
    return finding.id.includes('disconnected')
  })

  return (
    <aside className="wfs-inspector">
      <header className="wfs-inspector__header">
        <span className={cls('wfs-node-icon', `is-${family}`)}><Icon name={nodeIcon(node.nodeType)} /></span>
        <div>
          <span className="wfs-kicker">{familyLabel(family)}</span>
          <h3>{node.label}</h3>
          <div className="wfs-inspector__meta">
            <span className={cls('wfs-node-badge', `is-${status.toLowerCase().replace(/\s+/g, '-')}`)}>{status}</span>
            {isSendCapable(node.nodeType) && <span className="wfs-shield-chip"><Icon name="shield" /> Live blocked</span>}
          </div>
        </div>
      </header>

      <div className="wfs-config-stack">
        <ConfigSection title="Node Identity" icon="radar">
          <FieldTile label="Node Type" value={titleCase(node.nodeType)} />
          <FieldTile label="Step Key" value={node.key} />
          <div className="wfs-config-row">
            <span>Category</span>
            <strong>{familyLabel(family)}</strong>
          </div>
        </ConfigSection>

        {isSend && (
          <ConfigSection title="Required Routing" icon="send">
            <FieldTile label="Template Set" value={String(config.template_set_key ?? config.template_set_id ?? 'default_owner_check')} required />
            <FieldTile label="Sender Pool" value={String(config.sender_pool_key ?? 'default_dry_run_pool')} required />
            <div className="wfs-config-row">
              <span>Language</span>
              <strong>{String(config.language ?? detail?.workflow.language_scope?.[0] ?? 'en')}</strong>
            </div>
            <div className="wfs-toggle-row">
              <span>Spin Syntax</span>
              <button type="button" className="is-on">Enabled</button>
            </div>
            <div className="wfs-toggle-row">
              <span>Approval Required</span>
              <button type="button" className={config.approval_required ? 'is-on' : ''}>{config.approval_required ? 'On' : 'Off'}</button>
            </div>
          </ConfigSection>
        )}

        {isWait && (
          <ConfigSection title="Timing Controls" icon="clock">
            <FieldTile label="Delay Amount" value={String(node.step?.delay_amount ?? dryRunStep?.wait?.delay_amount ?? 2)} required />
            <FieldTile label="Delay Unit" value={String(node.step?.delay_unit ?? dryRunStep?.wait?.delay_unit ?? 'days')} required />
            <div className="wfs-toggle-row">
              <span>Business Hours Only</span>
              <button type="button" className={config.business_hours_only ? 'is-on' : ''}>
                {config.business_hours_only ? 'On' : 'Off'}
              </button>
            </div>
            <FieldTile label="Timezone" value={String(config.timezone ?? detail?.workflow.timezone ?? 'America/Chicago')} />
          </ConfigSection>
        )}

        {isCondition && (
          <ConfigSection title="Condition Builder" icon="layout-split">
            <FieldTile label="Field" value={String(conditions.field ?? node.nodeType.replace(/^condition_/, ''))} required />
            <FieldTile label="Operator" value={String(conditions.operator ?? 'equals')} required />
            <FieldTile label="Value" value={String(conditions.value ?? 'true')} />
            <div className="wfs-path-grid">
              <span><strong>True</strong>{String(conditions.true_path ?? 'next')}</span>
              <span><strong>False</strong>{String(conditions.false_path ?? 'hold')}</span>
            </div>
          </ConfigSection>
        )}

        {family === 'intelligence' && (
          <ConfigSection title="Deal Intelligence" icon="brain">
            <FieldTile label="Signal Source" value={String(config.source ?? 'Deal context')} />
            <FieldTile label="Confidence Floor" value={String(config.confidence_floor ?? '0.72')} />
            <div className="wfs-toggle-row"><span>Approval Required</span><button type="button" className={config.approval_required ? 'is-on' : ''}>{config.approval_required ? 'On' : 'Review'}</button></div>
          </ConfigSection>
        )}

        {family === 'approval' && (
          <ConfigSection title="Approval Gate" icon="check-double">
            <FieldTile label="Approver" value={String(config.approver_role ?? 'Operator')} required />
            <FieldTile label="Escalation" value={String(config.escalation_policy ?? 'Manual review')} />
          </ConfigSection>
        )}

        <ConfigSection title="Warnings" icon={nodeFindings.length > 0 ? 'alert' : 'check'}>
          {nodeFindings.length === 0 ? (
            <div className="wfs-config-row is-good">
              <span>Validation</span>
              <strong>Clear</strong>
            </div>
          ) : (
            <div className="wfs-inspector-warning-list">
              {nodeFindings.slice(0, 4).map((finding) => (
                <span key={finding.id} className={`is-${finding.severity}`}>
                  <Icon name={finding.severity === 'error' ? 'alert' : 'alert-circle'} />
                  {finding.label}
                </span>
              ))}
            </div>
          )}
        </ConfigSection>

        <ConfigSection title="Live Safety" icon="shield">
          <div className="wfs-live-block">
            <Icon name="shield" />
            <span>Live sends are blocked by studio guards</span>
          </div>
          <div className="wfs-config-row">
            <span>Outbound status</span>
            <strong>{isSendCapable(node.nodeType) ? '0 sent' : 'Not outbound'}</strong>
          </div>
        </ConfigSection>

        {dryRunStep?.rendered_template && (
          <ConfigSection title="Output Preview" icon="message">
            <div className="wfs-rendered-message">
              <span>Rendered Message</span>
              <p>{dryRunStep.rendered_template.body}</p>
              <small>
                {dryRunStep.rendered_template.sms?.character_count ?? 0} chars /
                {dryRunStep.rendered_template.sms?.segment_count ?? 0} segments
              </small>
            </div>
          </ConfigSection>
        )}

        <ConfigSection title="Audit Metadata" icon="database">
          <div className="wfs-config-row">
            <span>Step ID</span>
            <strong>{node.step?.id ? node.step.id.slice(0, 8) : 'preview'}</strong>
          </div>
          <div className="wfs-config-row">
            <span>Dry-run status</span>
            <strong>{dryRunStep?.status ?? 'Not run'}</strong>
          </div>
        </ConfigSection>
      </div>
    </aside>
  )
}

function CanvasNodeButton({
  node,
  selected,
  dragging,
  dryRunStep,
  runIndex,
  isCurrent,
  detail,
  onSelect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  node: CanvasNode
  selected: boolean
  dragging?: boolean
  dryRunStep?: WorkflowDryRunStep
  runIndex?: number
  isCurrent?: boolean
  detail: WorkflowDetail | null
  onSelect: (nodeId: string) => void
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, node: CanvasNode) => void
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void
}) {
  const family = nodeFamily(node.nodeType)
  const status = nodeStatus(node, detail, dryRunStep)
  const missing = isMissingNodeConfig(node, detail)
  const sendCapable = isSendCapable(node.nodeType)

  return (
    <button
      type="button"
      className={cls('wfs-canvas-node', `is-${family}`, selected && 'is-selected', dragging && 'is-dragging', dryRunStep && 'is-dry-run', isCurrent && 'is-current-run', missing && 'has-warning')}
      style={{ left: node.x, top: node.y }}
      onClick={() => onSelect(node.id)}
      onPointerDown={(event) => onPointerDown(event, node)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="wfs-canvas-node__port is-in" />
      <span className={cls('wfs-node-icon', `is-${family}`)}>
        <Icon name={nodeIcon(node.nodeType)} />
      </span>
      <span className="wfs-canvas-node__main">
        <small>{familyLabel(family)}</small>
        <strong>{node.label}</strong>
        <em>{nodeSubtitle(node, dryRunStep)}</em>
      </span>
      <span className="wfs-node-badge-row">
        <span className={cls('wfs-node-badge', `is-${status.toLowerCase().replace(/\s+/g, '-')}`)}>{status}</span>
        {typeof runIndex === 'number' && <span className="wfs-run-index">{String(runIndex + 1).padStart(2, '0')}</span>}
        {missing && <span className="wfs-node-alert" title="Missing config"><Icon name="alert" /></span>}
        {sendCapable && <span className="wfs-node-shield" title="Live blocked"><Icon name="shield" /></span>}
      </span>
      <span className="wfs-canvas-node__port is-out" />
    </button>
  )
}

function Minimap({ nodes, selectedNodeId }: { nodes: CanvasNode[]; selectedNodeId: string | null }) {
  return (
    <div className="wfs-minimap" aria-hidden="true">
      <span className="wfs-minimap__viewport" />
      {nodes.map((node) => (
        <span
          key={node.id}
          className={node.id === selectedNodeId ? 'is-selected' : ''}
          style={{ left: `${Math.min(92, Math.max(4, (node.x / CANVAS_WIDTH) * 100))}%`, top: `${Math.min(84, Math.max(10, (node.y / CANVAS_HEIGHT) * 100))}%` }}
        />
      ))}
    </div>
  )
}

function RunLog({ result }: { result: WorkflowDryRunResult | null }) {
  if (!result) {
    return (
      <div className="wfs-command-empty">
        <Icon name="activity" />
        <strong>No run log yet</strong>
        <span>Run a simulation to capture node-level execution, routing decisions, and live-send proof.</span>
      </div>
    )
  }
  return (
    <div className="wfs-drawer-log">
      {result.steps.map((step, index) => (
        <article key={step.step_id ?? step.step_key ?? `${step.node_type}-${index}`}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{step.label}</strong>
            <small>{step.node_type} / {step.status}</small>
          </div>
          <em>{step.live_send_blocked ? 'Live blocked' : 'Ready'}</em>
        </article>
      ))}
    </div>
  )
}

function AuditTrail({ detail }: { detail: WorkflowDetail }) {
  const rows = detail.audit ?? []
  if (!rows.length) {
    return (
      <div className="wfs-command-empty">
        <Icon name="database" />
        <strong>No audit events</strong>
        <span>Workflow actions and dry-run audit records will appear here.</span>
      </div>
    )
  }
  return (
    <div className="wfs-drawer-log">
      {rows.slice(0, 12).map((row, index) => (
        <article key={String(row.id ?? `${row.action}-${index}`)}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{String(row.action ?? 'workflow.event')}</strong>
            <small>{String(row.created_at ?? '')}</small>
          </div>
          <em>{String(row.actor_type ?? 'system')}</em>
        </article>
      ))}
    </div>
  )
}

export const WorkflowBuilder = (props: WorkflowBuilderProps) => {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(0.76)
  const [localPositions, setLocalPositions] = useState<Record<string, CanvasPosition>>({})
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const canvasScrollRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    nodeId: string
    pointerId: number
    offsetX: number
    offsetY: number
    position: CanvasPosition
    moved: boolean
  } | null>(null)
  const lastDraggedNodeRef = useRef<string | null>(null)

  const { detail, dryRunResult } = props
  const nodes = useMemo(() => canvasNodes(detail, localPositions), [detail, localPositions])
  const connections = useMemo(() => canvasConnections(nodes), [nodes])
  const dryRunLookup = useMemo(() => dryRunByNode(dryRunResult), [dryRunResult])
  const dryRunMap = dryRunLookup.map
  const dryRunOrder = dryRunLookup.order
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0] ?? null
  const selectedDryRun = selectedNode ? dryRunMap.get(selectedNode.id) ?? dryRunMap.get(selectedNode.key) : undefined
  const workflow = detail?.workflow
  const liveBlocked = workflow?.live_send_enabled !== true
  const findings = useMemo(() => buildValidation(detail, nodes, connections), [detail, nodes, connections])
  const errorCount = findings.filter((finding) => finding.severity === 'error').length
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length
  const liveBlockedCount = nodes.filter((node) => isSendCapable(node.nodeType)).length
  const currentRunKey = dryRunResult?.steps.at(-1)?.step_id ?? dryRunResult?.steps.at(-1)?.step_key ?? null

  useEffect(() => {
    setLocalPositions({})
    setDraggingNodeId(null)
    dragStateRef.current = null
    setDropActive(false)
  }, [detail?.workflow.id])

  const runQuickDryRun = async () => {
    if (!detail) return
    props.onOpenUtilityDrawer('Dry Run')
    await props.onDryRun(sampleContext)
  }

  const createDefaultDraft = async () => {
    await props.onCreate(defaultCreatePayload)
  }

  const fitView = () => {
    const viewport = canvasScrollRef.current
    if (!viewport) return
    const nextZoom = Math.max(0.46, Math.min(0.9, (viewport.clientWidth - 48) / CANVAS_WIDTH))
    setZoom(nextZoom)
    window.requestAnimationFrame(() => {
      viewport.scrollTo({ left: 0, top: 120, behavior: 'smooth' })
    })
  }

  const centerView = () => {
    const viewport = canvasScrollRef.current
    if (!viewport) return
    viewport.scrollTo({
      left: Math.max(0, ((CANVAS_WIDTH * zoom) - viewport.clientWidth) / 2),
      top: Math.max(0, ((CANVAS_HEIGHT * zoom) - viewport.clientHeight) / 2),
      behavior: 'smooth',
    })
  }

  const pointFromClient = (clientX: number, clientY: number): CanvasPosition => {
    const viewport = canvasScrollRef.current
    if (!viewport) return DEFAULT_DROP_POSITION
    const rect = viewport.getBoundingClientRect()
    return {
      x: Math.round((clientX - rect.left + viewport.scrollLeft) / zoom),
      y: Math.round((clientY - rect.top + viewport.scrollTop) / zoom),
    }
  }

  const clampCanvasPosition = (position: CanvasPosition): CanvasPosition => ({
    x: Math.max(36, Math.min(CANVAS_WIDTH - NODE_WIDTH - 36, Math.round(position.x))),
    y: Math.max(40, Math.min(CANVAS_HEIGHT - 132, Math.round(position.y))),
  })

  const createNodeAtPosition = async (nodeType: string, position: CanvasPosition) => {
    if (!detail) return
    const item = getWorkflowNodeByType(nodeType)
    if (!item) return
    const maxOrder = Math.max(0, ...detail.steps.map((step) => Number(step.step_order) || 0))
    await props.onCreateStep(buildWorkflowStepPayload(item, clampCanvasPosition(position), maxOrder + 10))
  }

  const addDefaultNode = async () => {
    const viewport = canvasScrollRef.current
    const center = viewport
      ? {
          x: (viewport.scrollLeft + (viewport.clientWidth / 2)) / zoom - (NODE_WIDTH / 2),
          y: (viewport.scrollTop + (viewport.clientHeight / 2)) / zoom - NODE_CENTER_Y,
        }
      : DEFAULT_DROP_POSITION
    await createNodeAtPosition('send_sms', center)
  }

  const handleCanvasDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!detail) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const handleCanvasDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!detail) return
    event.preventDefault()
    setDropActive(false)
    const raw =
      event.dataTransfer.getData('application/x-workflow-node') ||
      event.dataTransfer.getData('text/plain')
    let nodeType = raw
    try {
      const parsed = JSON.parse(raw)
      nodeType = String(parsed?.type ?? raw)
    } catch {
      nodeType = raw
    }
    if (!nodeType) return
    const point = pointFromClient(event.clientX, event.clientY)
    await createNodeAtPosition(nodeType, {
      x: point.x - (NODE_WIDTH / 2),
      y: point.y - NODE_CENTER_Y,
    })
  }

  const handleNodePointerDown = (event: PointerEvent<HTMLButtonElement>, node: CanvasNode) => {
    setSelectedNodeId(node.id)
    if (!node.step || event.button !== 0) return
    const point = pointFromClient(event.clientX, event.clientY)
    dragStateRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y,
      position: { x: node.x, y: node.y },
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingNodeId(node.id)
  }

  const handleNodePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    event.preventDefault()
    const point = pointFromClient(event.clientX, event.clientY)
    const nextPosition = clampCanvasPosition({
      x: point.x - dragState.offsetX,
      y: point.y - dragState.offsetY,
    })
    const moved = Math.abs(nextPosition.x - dragState.position.x) > 2 || Math.abs(nextPosition.y - dragState.position.y) > 2
    dragStateRef.current = { ...dragState, position: nextPosition, moved: dragState.moved || moved }
    setLocalPositions((current) => ({ ...current, [dragState.nodeId]: nextPosition }))
  }

  const handleNodePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    dragStateRef.current = null
    setDraggingNodeId(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
    if (!dragState.moved) return
    lastDraggedNodeRef.current = dragState.nodeId
    window.setTimeout(() => {
      if (lastDraggedNodeRef.current === dragState.nodeId) lastDraggedNodeRef.current = null
    }, 0)
    const node = nodes.find((candidate) => candidate.id === dragState.nodeId)
    if (!node?.step) return
    const currentUi = isRecord(node.step.config?.ui) ? node.step.config.ui : {}
    const nextConfig = {
      ...node.step.config,
      ui: { ...currentUi, ...dragState.position },
      position: dragState.position,
    }
    void props.onUpdateStep(node.step.id, { config: nextConfig })
  }

  const selectNode = (nodeId: string) => {
    if (lastDraggedNodeRef.current === nodeId) return
    setSelectedNodeId(nodeId)
  }

  return (
    <main className="wfs-builder wfs-builder--visual">
      <header className="wfs-commandbar">
        <div className="wfs-commandbar__identity">
          <span className="wfs-kicker">Workflow Command</span>
          <h2>{workflow?.name ?? 'Owner Acquisition Blueprint'}</h2>
          <div className="wfs-commandbar__chips">
            <span className={cls('wfs-status', workflow && `is-${workflow.status}`)}>{workflow?.status ?? 'draft'}</span>
            <span><Icon name="message" /> {workflow?.channel ?? 'sms'}</span>
            <span><Icon name="radar" /> {workflow?.workflow_type ?? 'outbound'}</span>
            <span className="is-safe"><Icon name="shield" /> Live blocked</span>
            <span><Icon name="check" /> Saved {formatTimestamp(workflow?.updated_at)}</span>
          </div>
        </div>

        <div className="wfs-mode-switch" aria-label="Send mode">
          <button type="button" className="is-active"><Icon name="eye" /> Dry Run</button>
          <button type="button" disabled title="Live sends are disabled by global workflow guards">
            <Icon name="zap" /> Live
          </button>
        </div>

        <div className="wfs-commandbar__actions">
          <button type="button" disabled={props.busy || !detail} title="Draft changes are persisted by each workflow action">
            <Icon name="check" /> Saved
          </button>
          <button type="button" disabled={props.busy || !detail} onClick={() => void props.onClone()}><Icon name="layers" /> Clone</button>
          <button type="button" disabled={props.busy || !detail} onClick={() => void runQuickDryRun()}><Icon name="play" /> Test <span>{findings.length}</span></button>
          <button type="button" disabled={!detail} onClick={() => props.onOpenUtilityDrawer('Run Log')}><Icon name="list" /> Logs</button>
          {workflow?.status === 'paused' ? (
            <button type="button" disabled={props.busy || !detail} onClick={() => void props.onResume()}><Icon name="play" /> Resume</button>
          ) : (
            <button type="button" disabled={props.busy || !detail} onClick={() => void props.onPause()}><Icon name="pause" /> Pause</button>
          )}
          <button type="button" disabled title={liveBlocked ? 'Live sends are blocked' : 'Publish is not enabled in this slice'}>
            <Icon name="shield" /> Publish <span>{errorCount + warningCount}</span>
          </button>
        </div>
      </header>

      <div className="wfs-validation-strip">
        <div>
          <Icon name={errorCount > 0 ? 'alert' : warningCount > 0 ? 'alert-circle' : 'check-double'} />
          <strong>{errorCount > 0 ? `${errorCount} blocker${errorCount === 1 ? '' : 's'}` : warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : 'Validation clear'}</strong>
        </div>
        <div className="wfs-validation-strip__items">
          {findings.slice(0, 6).map((finding) => (
            <span key={finding.id} className={`is-${finding.severity}`}>{finding.label}</span>
          ))}
        </div>
      </div>

      <div className="wfs-workbench">
        <section className={cls('wfs-canvas-panel', dropActive && 'is-drop-active')} aria-label="Workflow canvas">
          <div className="wfs-canvas-toolbar">
            <div>
              <span className="wfs-kicker">Canvas</span>
              <strong>{nodes.length} nodes / {connections.length} paths</strong>
            </div>
            <div className="wfs-canvas-toolbar__right">
              <button type="button" className="wfs-canvas-tool" onClick={fitView}><Icon name="maximize" /> Fit View</button>
              <button type="button" className="wfs-canvas-tool" onClick={centerView}><Icon name="target" /> Center</button>
              <div className="wfs-zoom-controls" aria-label="Zoom controls">
                <button type="button" onClick={() => setZoom((value) => Math.max(0.46, value - 0.08))}><Icon name="chevron-down" /></button>
                <span>{Math.round(zoom * 100)}%</span>
                <button type="button" onClick={() => setZoom((value) => Math.min(1.08, value + 0.08))}><Icon name="chevron-up" /></button>
              </div>
            </div>
          </div>

          <div
            className="wfs-canvas-scroll"
            ref={canvasScrollRef}
            onDragOver={handleCanvasDragOver}
            onDragLeave={() => setDropActive(false)}
            onDrop={(event) => void handleCanvasDrop(event)}
          >
            <div className="wfs-canvas-grid" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${zoom})` }}>
              <svg className="wfs-canvas-lines" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="wfs-path-next" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="#65f2d3" stopOpacity="0.24" />
                    <stop offset="50%" stopColor="#80b8ff" stopOpacity="0.82" />
                    <stop offset="100%" stopColor="#65f2d3" stopOpacity="0.34" />
                  </linearGradient>
                  <linearGradient id="wfs-path-true" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="#7ee79d" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#65f2d3" stopOpacity="0.9" />
                  </linearGradient>
                  <linearGradient id="wfs-path-false" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="#ff7b86" stopOpacity="0.26" />
                    <stop offset="100%" stopColor="#c6a7ff" stopOpacity="0.86" />
                  </linearGradient>
                  {(['next', 'true', 'false'] as const).map((kind) => (
                    <marker key={kind} id={`wfs-arrow-${kind}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                      <path className={`wfs-arrow-fill is-${kind}`} d="M 0 0 L 12 6 L 0 12 z" />
                    </marker>
                  ))}
                </defs>
                {connections.map((connection) => {
                  const fromRun = dryRunMap.has(connection.from.id) || dryRunMap.has(connection.from.key)
                  const toRun = dryRunMap.has(connection.to.id) || dryRunMap.has(connection.to.key)
                  const active = fromRun && toRun
                  const x1 = connection.from.x + NODE_WIDTH
                  const y1 = connection.from.y + NODE_CENTER_Y
                  const x2 = connection.to.x
                  const y2 = connection.to.y + NODE_CENTER_Y
                  const mid = Math.max(70, Math.abs(x2 - x1) / 2)
                  const labelX = x1 + ((x2 - x1) / 2)
                  const labelY = y1 + ((y2 - y1) / 2) - 11
                  return (
                    <g key={connection.id}>
                      <path
                        className={cls('wfs-connection', `is-${connection.kind}`, active && 'is-active')}
                        markerEnd={`url(#wfs-arrow-${connection.kind})`}
                        d={`M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`}
                      />
                      <text className={cls('wfs-connection-label', `is-${connection.kind}`)} x={labelX} y={labelY}>
                        {connection.kind === 'true' ? 'True' : connection.kind === 'false' ? 'False' : 'Next'}
                      </text>
                    </g>
                  )
                })}
              </svg>

              {nodes.map((node) => {
                const dryStep = dryRunMap.get(node.id) ?? dryRunMap.get(node.key)
                const runIndex = dryRunOrder.get(node.id) ?? dryRunOrder.get(node.key)
                return (
                  <CanvasNodeButton
                    key={node.id}
                    node={node}
                    selected={selectedNode?.id === node.id}
                    dragging={draggingNodeId === node.id}
                    dryRunStep={dryStep}
                    runIndex={runIndex}
                    isCurrent={Boolean(currentRunKey && (currentRunKey === node.id || currentRunKey === node.key))}
                    detail={detail}
                    onSelect={selectNode}
                    onPointerDown={handleNodePointerDown}
                    onPointerMove={handleNodePointerMove}
                    onPointerUp={handleNodePointerUp}
                  />
                )
              })}
            </div>
          </div>

          <div className="wfs-floating-actions">
            <button type="button" disabled={props.busy || !detail} onClick={() => void addDefaultNode()}>
              <Icon name="grid" /> Add Node
            </button>
            <button type="button" disabled={props.busy || !detail} onClick={() => void runQuickDryRun()}>
              <Icon name="play" /> Run Dry Test
            </button>
          </div>

          <div className="wfs-canvas-footer">
            <Minimap nodes={nodes} selectedNodeId={selectedNode?.id ?? null} />
            <div className="wfs-live-proof">
              <span><Icon name="shield" /> AUTOMATION_LIVE_SENDS_ENABLED=false</span>
              <span><Icon name="shield" /> WORKFLOW_LIVE_SENDS_ENABLED=false</span>
              <span><Icon name="activity" /> Dry-run only</span>
            </div>
          </div>

          {!detail && (
            <div className="wfs-create-overlay">
              <span className="wfs-node-icon is-trigger"><Icon name="bolt" /></span>
              <strong>Create the default acquisition workflow</strong>
              <p>Preview the visual path now, then create a guarded draft with live sends still blocked.</p>
              <button type="button" className="wfs-primary-btn" disabled={props.busy} onClick={() => void createDefaultDraft()}>
                <Icon name="check" /> Create Draft
              </button>
            </div>
          )}
        </section>

        <NodeConfigPanel node={selectedNode} detail={detail} dryRunStep={selectedDryRun} findings={findings} />
      </div>

      {props.utilityDrawerOpen && (
      <section className="wfs-bottom-drawer">
        <header className="wfs-drawer-head">
          <nav className="wfs-drawer-tabs" aria-label="Workflow drawer">
            {bottomTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={props.utilityDrawerTab === tab ? 'is-active' : ''}
                onClick={() => props.onOpenUtilityDrawer(tab)}
              >
                <Icon name={tab === 'Dry Run' ? 'activity' : tab === 'Run Log' ? 'list' : 'database'} />
                {tab}
              </button>
            ))}
          </nav>
          <div className="wfs-drawer-metrics">
            <span><strong>{nodes.length}</strong> nodes</span>
            <span><strong>{findings.length}</strong> warnings</span>
            <span><strong>{liveBlockedCount}</strong> live-blocked</span>
            <span><strong>{dryRunResult ? `${dryRunResult.steps.length} steps` : 'none'}</strong> last dry run</span>
            <button type="button" className="wfs-drawer-close" onClick={props.onCloseUtilityDrawer}><Icon name="close" /> Close</button>
          </div>
        </header>
        <div className="wfs-drawer-body">
          {props.utilityDrawerTab === 'Dry Run' && detail && (
            <WorkflowDryRunPreview
              detail={detail}
              busy={props.busy}
              result={props.dryRunResult}
              onDryRun={props.onDryRun}
            />
          )}
          {props.utilityDrawerTab === 'Run Log' && <RunLog result={props.dryRunResult} />}
          {props.utilityDrawerTab === 'Audit' && detail && <AuditTrail detail={detail} />}
          {!detail && props.utilityDrawerTab !== 'Run Log' && (
            <div className="wfs-command-empty">
              <Icon name="command" />
              <strong>Create or select a workflow</strong>
              <span>Canvas preview is available, but studios need a workflow draft.</span>
            </div>
          )}
        </div>
      </section>
      )}
    </main>
  )
}
