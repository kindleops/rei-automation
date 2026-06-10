import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { WorkflowDetail } from './workflow.types'

const NODE_TYPES = [
  'send_sms',
  'send_email',
  'send_rvm',
  'send_direct_mail',
  'wait',
  'condition',
  'branch',
  'update_status',
  'update_stage',
  'update_temperature',
  'schedule_followup',
  'cancel_queue',
  'suppress_phone',
  'assign_operator',
  'create_notification',
  'trigger_comp_pull',
  'trigger_buyer_match',
  'calculate_offer',
  'require_approval',
  'generate_contract',
  'send_contract',
  'email_title_company',
  'stop_workflow',
]

interface WorkflowStepsPanelProps {
  detail: WorkflowDetail
  busy?: boolean
  onCreateStep: (payload: Record<string, unknown>) => Promise<void>
}

export const WorkflowStepsPanel = ({ detail, busy, onCreateStep }: WorkflowStepsPanelProps) => {
  const [label, setLabel] = useState('Owner Check Message')
  const [nodeType, setNodeType] = useState('send_sms')
  const [delayAmount, setDelayAmount] = useState('2')
  const [delayUnit, setDelayUnit] = useState('days')

  const nextOrder = useMemo(
    () => (detail.steps.reduce((max, step) => Math.max(max, Number(step.step_order) || 0), 0) + 10),
    [detail.steps],
  )

  const createStep = async () => {
    await onCreateStep({
      label,
      node_type: nodeType,
      step_order: nextOrder,
      delay_amount: nodeType === 'wait' ? Number(delayAmount) || null : null,
      delay_unit: nodeType === 'wait' ? delayUnit : null,
      actions: nodeType.startsWith('send_')
        ? [{ action_type: nodeType, dry_run: true, live_enabled: false }]
        : [],
      config: nodeType.startsWith('send_')
        ? { live_send_enabled: false }
        : {},
    })
  }

  return (
    <div className="wfs-panel-grid is-wide">
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Builder</span>
            <h3>Step Sequence</h3>
          </div>
          <span className="wfs-count">{detail.steps.length}</span>
        </header>

        <div className="wfs-step-list">
          {detail.steps.length === 0 ? (
            <div className="wfs-empty">No steps</div>
          ) : detail.steps.map((step) => (
            <article key={step.id} className="wfs-step-row">
              <span className="wfs-step-row__order">{step.step_order}</span>
              <span className="wfs-step-row__icon"><Icon name={step.node_type.startsWith('send_') ? 'send' : 'activity'} /></span>
              <span className="wfs-step-row__main">
                <strong>{step.label}</strong>
                <span>{step.node_type}</span>
              </span>
              <span className="wfs-step-row__meta">
                {step.delay_amount ? `${step.delay_amount} ${step.delay_unit}` : step.is_active ? 'Active' : 'Off'}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Node</span>
            <h3>Add Step</h3>
          </div>
        </header>
        <div className="wfs-form-grid is-single">
          <label>
            <span>Label</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            <span>Node Type</span>
            <select value={nodeType} onChange={(event) => setNodeType(event.target.value)}>
              {NODE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          {nodeType === 'wait' && (
            <>
              <label>
                <span>Delay</span>
                <input type="number" min={0} value={delayAmount} onChange={(event) => setDelayAmount(event.target.value)} />
              </label>
              <label>
                <span>Unit</span>
                <select value={delayUnit} onChange={(event) => setDelayUnit(event.target.value)}>
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                  <option value="business_days">Business Days</option>
                </select>
              </label>
            </>
          )}
        </div>
        <button type="button" className="wfs-primary-btn" disabled={busy} onClick={createStep}>
          <Icon name="check" /> Add Step
        </button>
      </section>
    </div>
  )
}
