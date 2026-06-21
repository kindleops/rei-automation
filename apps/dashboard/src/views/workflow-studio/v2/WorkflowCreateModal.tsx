import { useState } from 'react'
import { WorkflowGlassModal } from './WorkflowGlassModal'

export interface WorkflowCreatePayload {
  name: string
  description: string
  workflow_type: string
  channel: string
  start_from: 'blank' | 'system_template' | 'existing'
  trigger_type: string
  operational_mode: 'test' | 'active_safe' | 'armed'
  market_scope: string[]
  state_scope: string[]
  language_scope: string[]
  asset_scope: string[]
}

interface WorkflowCreateModalProps {
  open: boolean
  busy?: boolean
  onClose: () => void
  onSubmit: (payload: WorkflowCreatePayload) => void
}

const DEFAULT: WorkflowCreatePayload = {
  name: '',
  description: '',
  workflow_type: 'outbound',
  channel: 'sms',
  start_from: 'blank',
  trigger_type: 'trigger.lead_entered_workflow',
  operational_mode: 'test',
  market_scope: ['default'],
  state_scope: ['TX'],
  language_scope: ['en'],
  asset_scope: [],
}

export const WorkflowCreateModal = ({ open, busy, onClose, onSubmit }: WorkflowCreateModalProps) => {
  const [form, setForm] = useState<WorkflowCreatePayload>(DEFAULT)
  const [error, setError] = useState('')

  const update = <K extends keyof WorkflowCreatePayload>(key: K, value: WorkflowCreatePayload[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const submit = () => {
    if (!form.name.trim()) {
      setError('Workflow name is required.')
      return
    }
    setError('')
    onSubmit({ ...form, name: form.name.trim() })
  }

  return (
    <WorkflowGlassModal
      open={open}
      title="New Workflow"
      subtitle="Create a canonical Workflow V2 draft with guarded defaults."
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="wfs2__btn is-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="wfs2__btn is-primary" onClick={submit} disabled={busy}>
            Create Draft
          </button>
        </>
      )}
    >
      {error ? <div className="wfs2-modal__error">{error}</div> : null}

      <label className="wfs2-modal__field">
        <span>Workflow name</span>
        <input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Owner Acquisition Follow-Up" />
      </label>

      <label className="wfs2-modal__field">
        <span>Description</span>
        <textarea value={form.description} onChange={(e) => update('description', e.target.value)} rows={2} />
      </label>

      <div className="wfs2-modal__grid">
        <label className="wfs2-modal__field">
          <span>Workflow type</span>
          <select value={form.workflow_type} onChange={(e) => update('workflow_type', e.target.value)}>
            <option value="outbound">Outbound</option>
            <option value="follow_up">Follow-up</option>
            <option value="automation">Automation</option>
            <option value="deal_execution">Deal execution</option>
          </select>
        </label>

        <label className="wfs2-modal__field">
          <span>Channel</span>
          <select value={form.channel} onChange={(e) => update('channel', e.target.value)}>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
            <option value="multichannel">Multichannel</option>
          </select>
        </label>
      </div>

      <div className="wfs2-modal__grid">
        <label className="wfs2-modal__field">
          <span>Start from</span>
          <select value={form.start_from} onChange={(e) => update('start_from', e.target.value as WorkflowCreatePayload['start_from'])}>
            <option value="blank">Blank</option>
            <option value="system_template">System template</option>
            <option value="existing">Existing workflow</option>
          </select>
        </label>

        <label className="wfs2-modal__field">
          <span>Trigger</span>
          <select value={form.trigger_type} onChange={(e) => update('trigger_type', e.target.value)}>
            <option value="trigger.lead_entered_workflow">Lead entered workflow</option>
            <option value="trigger.inbound_sms_received">Inbound SMS received</option>
            <option value="trigger.manual_enrollment">Manual enrollment</option>
          </select>
        </label>
      </div>

      <label className="wfs2-modal__field">
        <span>Operational mode</span>
        <select
          value={form.operational_mode}
          onChange={(e) => update('operational_mode', e.target.value as WorkflowCreatePayload['operational_mode'])}
        >
          <option value="test">Test (no-send)</option>
          <option value="active_safe">Active Safe (no-send)</option>
          <option value="armed">Armed (guarded)</option>
        </select>
      </label>

      <div className="wfs2-modal__grid">
        <label className="wfs2-modal__field">
          <span>Market scope</span>
          <input value={form.market_scope.join(', ')} onChange={(e) => update('market_scope', e.target.value.split(',').map((v) => v.trim()).filter(Boolean))} />
        </label>
        <label className="wfs2-modal__field">
          <span>State scope</span>
          <input value={form.state_scope.join(', ')} onChange={(e) => update('state_scope', e.target.value.split(',').map((v) => v.trim()).filter(Boolean))} />
        </label>
      </div>
    </WorkflowGlassModal>
  )
}