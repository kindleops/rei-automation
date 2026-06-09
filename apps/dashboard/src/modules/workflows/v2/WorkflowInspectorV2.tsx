import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { WorkflowDetail, WorkflowDryRunResult, WorkflowDryRunStep, WorkflowStep } from '../workflow.types'
import { getWorkflowNodeByType } from '../WorkflowList'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

type InspectorTab = 'general' | 'logic' | 'safety' | 'data'

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
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function isSendCapable(nodeType: string) {
  return nodeType.startsWith('send_') || nodeType === 'email_title_company'
}

function nodeCategory(nodeType: string) {
  const library = getWorkflowNodeByType(nodeType)
  return library?.category ?? titleCase(nodeType.split('_')[0] ?? 'node')
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export const WorkflowInspectorV2 = ({
  node,
  detail,
  dryRunStep,
  dryRunResult,
}: WorkflowInspectorV2Props) => {
  const [tab, setTab] = useState<InspectorTab>('general')

  if (!node) {
    return (
      <aside className="wfs2-inspector">
        <div className="wfs2-inspector__empty">
          <Icon name="settings" />
          <strong>Select a node</strong>
          <span>Inspector metadata will appear here.</span>
        </div>
      </aside>
    )
  }

  const config = node.step?.config ?? {}
  const conditions = (node.step?.conditions ?? {}) as Record<string, unknown>
  const liveBlocked = isSendCapable(node.nodeType) && detail?.workflow.live_send_enabled !== true

  return (
    <aside className="wfs2-inspector">
      <nav className="wfs2-inspector__tabs" aria-label="Inspector tabs">
        {([
          ['general', 'General'],
          ['logic', 'Logic'],
          ['safety', 'Safety'],
          ['data', 'Data'],
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
        {tab === 'general' && (
          <>
            <label className="wfs2-field">
              <span>Node name</span>
              <input value={node.label} readOnly />
            </label>
            <label className="wfs2-field">
              <span>Node type</span>
              <input value={titleCase(node.nodeType)} readOnly />
            </label>
            <label className="wfs2-field">
              <span>Step key</span>
              <input value={node.key} readOnly />
            </label>
            <label className="wfs2-field">
              <span>Category</span>
              <input value={nodeCategory(node.nodeType)} readOnly />
            </label>
          </>
        )}

        {tab === 'logic' && (
          <>
            {(node.step?.delay_amount != null || node.nodeType.startsWith('wait')) && (
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
            <label className="wfs2-field">
              <span>Live send blocked</span>
              <input value={liveBlocked || dryRunStep?.live_send_blocked ? 'Yes' : 'No'} readOnly />
            </label>
            <label className="wfs2-field">
              <span>Suppression status</span>
              <input
                value={
                  node.nodeType.includes('suppress') || node.nodeType.includes('opt_out')
                    ? 'Suppression node'
                    : 'Not a suppression node'
                }
                readOnly
              />
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
      </div>
    </aside>
  )
}
