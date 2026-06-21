import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { runWorkflowDryRun, listNodeTypes } from '../workflowStudio.adapter'
import type {
  WorkflowDetail,
  WorkflowDryRunResult,
  WorkflowDryRunStep,
  WorkflowNodeTypeSchema,
  WorkflowStep,
} from '../workflow.types'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

type InspectorTab = 'general' | 'logic' | 'safety' | 'data' | 'test'

interface CanvasNodeView {
  id: string
  key: string
  label: string
  nodeType: string
  step?: WorkflowStep
}

interface WorkflowInspectorV2Props {
  node: CanvasNodeView | null
  detail: WorkflowDetail | null
  dryRunStep?: WorkflowDryRunStep
  dryRunResult: WorkflowDryRunResult | null
}

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\./g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function isSendCapable(nodeType: string) {
  return nodeType.startsWith('send_') || nodeType.includes('send.') || nodeType === 'email_title_company'
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function schemaFields(schema?: Record<string, unknown>) {
  if (!schema || typeof schema !== 'object') return []
  const properties = schema.properties
  if (!properties || typeof properties !== 'object') return []
  return Object.entries(properties as Record<string, Record<string, unknown>>).map(([key, meta]) => ({
    key,
    label: String(meta.title ?? titleCase(key)),
    type: String(meta.type ?? 'string'),
    description: String(meta.description ?? ''),
  }))
}

const sampleDryRunContext = {
  write_audit: true,
  context: {
    conversation_thread_id: 'workflow-inspector-test',
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

export const WorkflowInspectorV2 = ({
  node,
  detail,
  dryRunStep,
  dryRunResult,
}: WorkflowInspectorV2Props) => {
  const [tab, setTab] = useState<InspectorTab>('general')
  const [developerMode, setDeveloperMode] = useState(false)
  const [registry, setRegistry] = useState<Record<string, WorkflowNodeTypeSchema>>({})
  const [nodeTestResult, setNodeTestResult] = useState<WorkflowDryRunStep | null>(null)
  const [nodeTestBusy, setNodeTestBusy] = useState(false)
  const [nodeTestError, setNodeTestError] = useState('')

  useEffect(() => {
    let cancelled = false
    void listNodeTypes(false)
      .then((response) => {
        if (cancelled) return
        const map: Record<string, WorkflowNodeTypeSchema> = {}
        for (const entry of response.nodes ?? []) {
          map[entry.node_type] = entry
        }
        setRegistry(map)
      })
      .catch(() => {
        if (!cancelled) setRegistry({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  const nodeSchema = node ? registry[node.nodeType] : undefined

  const generalFields = useMemo(() => {
    if (!node) return []
    return [
      { label: 'Node name', value: node.label },
      { label: 'Node type', value: titleCase(node.nodeType) },
      { label: 'Step key', value: node.key },
      { label: 'Category', value: titleCase(nodeSchema?.category ?? node.nodeType.split(/[._]/)[0] ?? 'node') },
      { label: 'Kind', value: titleCase(nodeSchema?.node_kind ?? 'node') },
      { label: 'Communication', value: nodeSchema?.is_communication ? 'Yes' : 'No' },
    ]
  }, [node, nodeSchema])

  if (!node) {
    return (
      <aside className="wfs2-inspector">
        <div className="wfs2-inspector__empty">
          <Icon name="settings" />
          <strong>Select a node</strong>
          <span>Schema-driven inspector will appear here.</span>
        </div>
      </aside>
    )
  }

  const config = node.step?.config ?? {}
  const conditions = (node.step?.conditions ?? {}) as Record<string, unknown>
  const liveBlocked = isSendCapable(node.nodeType) && detail?.workflow.live_send_enabled !== true

  const runNodeTest = async () => {
    if (!detail?.workflow.id) return
    setNodeTestBusy(true)
    setNodeTestError('')
    try {
      const result = await runWorkflowDryRun(detail.workflow.id, {
        ...sampleDryRunContext,
        focus_step_key: node.key,
        focus_step_id: node.id,
      })
      const match =
        result.steps.find((step) => step.step_id === node.id) ??
        result.steps.find((step) => step.step_key === node.key) ??
        result.steps[0] ??
        null
      setNodeTestResult(match)
    } catch (err) {
      setNodeTestError(err instanceof Error ? err.message : 'Node test failed')
      setNodeTestResult(null)
    } finally {
      setNodeTestBusy(false)
    }
  }

  return (
    <aside className="wfs2-inspector">
      <div className="wfs2-inspector__toolbar">
        <label className="wfs2-inspector__dev-toggle">
          <input
            type="checkbox"
            checked={developerMode}
            onChange={(event) => setDeveloperMode(event.target.checked)}
          />
          <span>Developer Mode</span>
        </label>
      </div>

      <nav className="wfs2-inspector__tabs" aria-label="Inspector tabs">
        {([
          ['general', 'General'],
          ['logic', 'Logic'],
          ['safety', 'Safety'],
          ['data', 'Data'],
          ['test', 'Test'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cls('wfs2-inspector__tab', tab === id && 'is-active')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="wfs2-inspector__body">
        {developerMode && (
          <label className="wfs2-field">
            <span>Raw node JSON</span>
            <textarea value={compactJson(node.step ?? node)} readOnly />
          </label>
        )}

        {tab === 'general' && (
          <>
            {generalFields.map((field) => (
              <label key={field.label} className="wfs2-field">
                <span>{field.label}</span>
                <input value={field.value} readOnly />
              </label>
            ))}
            {schemaFields(nodeSchema?.config_schema).map((field) => (
              <label key={field.key} className="wfs2-field">
                <span>{field.label}</span>
                <input value={String(config[field.key] ?? '')} readOnly placeholder={field.description || '—'} />
              </label>
            ))}
          </>
        )}

        {tab === 'logic' && (
          <>
            {(node.step?.delay_amount != null || node.nodeType.startsWith('wait') || node.nodeType.includes('timing')) && (
              <>
                <label className="wfs2-field">
                  <span>Delay amount</span>
                  <input value={String(node.step?.delay_amount ?? dryRunStep?.wait?.delay_amount ?? 2)} readOnly />
                </label>
                <label className="wfs2-field">
                  <span>Delay unit</span>
                  <input value={String(node.step?.delay_unit ?? dryRunStep?.wait?.delay_unit ?? 'days')} readOnly />
                </label>
              </>
            )}
            {schemaFields(nodeSchema?.condition_schema).map((field) => (
              <label key={field.key} className="wfs2-field">
                <span>{field.label}</span>
                <input value={String(conditions[field.key] ?? '—')} readOnly />
              </label>
            ))}
            <label className="wfs2-field">
              <span>Next path</span>
              <input value={String(conditions.next_path ?? '—')} readOnly />
            </label>
            <label className="wfs2-field">
              <span>True path</span>
              <input value={String(conditions.true_path ?? '—')} readOnly />
            </label>
            <label className="wfs2-field">
              <span>False path</span>
              <input value={String(conditions.false_path ?? '—')} readOnly />
            </label>
            {dryRunStep?.conditions && (
              <label className="wfs2-field">
                <span>Dry-run condition</span>
                <textarea value={compactJson(dryRunStep.conditions)} readOnly />
              </label>
            )}
          </>
        )}

        {tab === 'safety' && (
          <>
            {schemaFields(nodeSchema?.safety_schema).map((field) => (
              <label key={field.key} className="wfs2-field">
                <span>{field.label}</span>
                <input value={String(config[field.key] ?? node.step?.stop_conditions?.[field.key] ?? '—')} readOnly />
              </label>
            ))}
            <label className="wfs2-field">
              <span>Live send blocked</span>
              <input value={liveBlocked || dryRunStep?.live_send_blocked ? 'Yes' : 'No'} readOnly />
            </label>
            <label className="wfs2-field">
              <span>Guard required</span>
              <input value={nodeSchema?.requires_guard_before ? 'Yes' : 'No'} readOnly />
            </label>
            <label className="wfs2-field">
              <span>Validation warnings</span>
              <textarea
                value={
                  (detail?.validation?.warnings ?? []).length > 0
                    ? (detail?.validation?.warnings ?? []).join('\n')
                    : 'None'
                }
                readOnly
              />
            </label>
            <label className="wfs2-field">
              <span>Dry-run status</span>
              <input value={dryRunStep?.status ?? (dryRunResult ? 'Not executed for this node' : 'Not run')} readOnly />
            </label>
          </>
        )}

        {tab === 'data' && (
          <>
            <label className="wfs2-field">
              <span>Config payload</span>
              <textarea value={compactJson(config)} readOnly />
            </label>
            <label className="wfs2-field">
              <span>Actions</span>
              <textarea value={compactJson(node.step?.actions ?? [])} readOnly />
            </label>
            {dryRunStep?.rendered_template && (
              <label className="wfs2-field">
                <span>Rendered template</span>
                <textarea value={dryRunStep.rendered_template.body} readOnly />
              </label>
            )}
            {dryRunResult?.selected_sample_context && (
              <label className="wfs2-field">
                <span>Sample context</span>
                <textarea value={compactJson(dryRunResult.selected_sample_context)} readOnly />
              </label>
            )}
          </>
        )}

        {tab === 'test' && (
          <div className="wfs2-inspector__test-panel">
            <p>Run a guarded dry-run focused on this node. No live sends are emitted.</p>
            <button
              type="button"
              className="wfs2__btn is-primary"
              disabled={nodeTestBusy || !detail}
              onClick={() => void runNodeTest()}
            >
              <Icon name="play" /> {nodeTestBusy ? 'Testing…' : 'Test Node'}
            </button>

            {nodeTestError && (
              <div className="wfs2-inspector__test-error">
                <Icon name="alert" /> {nodeTestError}
              </div>
            )}

            {nodeTestResult && (
              <div className="wfs2-inspector__test-result">
                <strong>{nodeTestResult.label}</strong>
                <span>Status: {nodeTestResult.status}</span>
                <span>Live blocked: {nodeTestResult.live_send_blocked ? 'Yes' : 'No'}</span>
                {nodeTestResult.rendered_template && (
                  <textarea value={nodeTestResult.rendered_template.body} readOnly />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}