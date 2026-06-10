import { useState } from 'react'
import { Icon } from '../../shared/icons'
import type { WorkflowDetail } from './workflow.types'

const asTextArray = (value: string) =>
  value.split(',').map((item) => item.trim()).filter(Boolean)

interface WorkflowOverviewPanelProps {
  detail: WorkflowDetail | null
  busy?: boolean
  onCreate: (payload: Record<string, unknown>) => Promise<void>
  onClone: () => Promise<void>
  onPause: () => Promise<void>
  onResume: () => Promise<void>
}

export const WorkflowOverviewPanel = ({
  detail,
  busy,
  onCreate,
  onClone,
  onPause,
  onResume,
}: WorkflowOverviewPanelProps) => {
  const [name, setName] = useState('Owner Check Workflow')
  const [channel, setChannel] = useState('sms')
  const [workflowType, setWorkflowType] = useState('outbound')
  const [marketScope, setMarketScope] = useState('default')
  const [languageScope, setLanguageScope] = useState('en')
  const [dailyCap, setDailyCap] = useState('75')

  const workflow = detail?.workflow

  const submitCreate = async () => {
    await onCreate({
      name,
      channel,
      workflow_type: workflowType,
      status: 'draft',
      live_send_enabled: false,
      market_scope: asTextArray(marketScope),
      language_scope: asTextArray(languageScope),
      daily_cap: Number(dailyCap) || null,
      timezone: 'America/Chicago',
    })
  }

  return (
    <div className="wfs-panel-grid">
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Create</span>
            <h3>Draft Workflow</h3>
          </div>
          <span className="wfs-guard"><Icon name="shield" /> Dry Run</span>
        </header>
        <div className="wfs-form-grid">
          <label>
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>Channel</span>
            <select value={channel} onChange={(event) => setChannel(event.target.value)}>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
              <option value="rvm">RVM</option>
              <option value="direct_mail">Direct Mail</option>
              <option value="multichannel">Multichannel</option>
            </select>
          </label>
          <label>
            <span>Type</span>
            <select value={workflowType} onChange={(event) => setWorkflowType(event.target.value)}>
              <option value="outbound">Outbound</option>
              <option value="follow_up">Follow Up</option>
              <option value="auto_reply">Auto Reply</option>
              <option value="nurture">Nurture</option>
              <option value="reactivation">Reactivation</option>
              <option value="deal_execution">Deal Execution</option>
            </select>
          </label>
          <label>
            <span>Markets</span>
            <input value={marketScope} onChange={(event) => setMarketScope(event.target.value)} />
          </label>
          <label>
            <span>Languages</span>
            <input value={languageScope} onChange={(event) => setLanguageScope(event.target.value)} />
          </label>
          <label>
            <span>Daily Cap</span>
            <input type="number" min={0} value={dailyCap} onChange={(event) => setDailyCap(event.target.value)} />
          </label>
        </div>
        <button type="button" className="wfs-primary-btn" disabled={busy} onClick={submitCreate}>
          <Icon name="check" /> Create Draft
        </button>
      </section>

      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Selected</span>
            <h3>{workflow?.name ?? 'No Workflow Selected'}</h3>
          </div>
          {workflow && <span className={`wfs-status is-${workflow.status}`}>{workflow.status}</span>}
        </header>
        {workflow ? (
          <>
            <div className="wfs-metric-grid">
              <div><span>Steps</span><strong>{detail.steps.length}</strong></div>
              <div><span>Templates</span><strong>{detail.template_sets.reduce((sum, set) => sum + (set.variants?.length ?? 0), 0)}</strong></div>
              <div><span>Senders</span><strong>{detail.sender_pools.reduce((sum, pool) => sum + (pool.members?.length ?? 0), 0)}</strong></div>
              <div><span>Live Sends</span><strong>{workflow.live_send_enabled ? 'On' : 'Off'}</strong></div>
            </div>
            <div className="wfs-actions">
              <button type="button" disabled={busy} onClick={onClone}><Icon name="layers" /> Clone</button>
              <button type="button" disabled={busy || workflow.status === 'paused'} onClick={onPause}><Icon name="pause" /> Pause</button>
              <button type="button" disabled={busy || workflow.status === 'active'} onClick={onResume}><Icon name="play" /> Resume</button>
            </div>
          </>
        ) : (
          <div className="wfs-empty">Select or create a workflow</div>
        )}
      </section>
    </div>
  )
}
