import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { WorkflowDetail, WorkflowDryRunResult, WorkflowDryRunStep } from './workflow.types'

interface WorkflowDryRunPreviewProps {
  detail: WorkflowDetail
  busy?: boolean
  result: WorkflowDryRunResult | null
  onDryRun: (payload: Record<string, unknown>) => Promise<void>
}

const compactValue = (value: unknown): string => {
  if (value == null || value === '') return 'none'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(compactValue).join(', ')
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 3)
      .map(([key, item]) => `${key}: ${compactValue(item)}`)
      .join(' / ')
  }
  return String(value)
}

const stepSignal = (step: WorkflowDryRunStep) => {
  if (step.rendered_template) return 'Rendered message'
  if (step.sender_route) return 'Sender route'
  if (step.wait) return 'Wait scheduled'
  if (step.conditions) return 'Condition resolved'
  if (step.approval_gate) return 'Approval gate'
  return step.live_send_blocked ? 'Live-send proof' : 'Node executed'
}

export const WorkflowDryRunPreview = ({
  detail,
  busy,
  result,
  onDryRun,
}: WorkflowDryRunPreviewProps) => {
  const [firstName, setFirstName] = useState('Jordan')
  const [propertyAddress, setPropertyAddress] = useState('123 Main St')
  const [market, setMarket] = useState(detail.workflow.market_scope?.[0] ?? 'default')
  const [state, setState] = useState(detail.workflow.state_scope?.[0] ?? 'TX')

  const renderedMessage = useMemo(
    () => result?.steps.find((step) => step.rendered_template)?.rendered_template ?? null,
    [result],
  )
  const senderRoute = useMemo(
    () => result?.steps.find((step) => step.sender_route)?.sender_route ?? null,
    [result],
  )
  const waitStep = useMemo(
    () => result?.steps.find((step) => step.wait)?.wait ?? null,
    [result],
  )
  const conditionStep = useMemo(
    () => result?.steps.find((step) => step.conditions)?.conditions ?? null,
    [result],
  )

  const run = async () => {
    await onDryRun({
      write_audit: true,
      context: {
        conversation_thread_id: 'workflow-studio-preview',
        first_name: firstName,
        seller_display_name: `${firstName} Seller`,
        property_address: propertyAddress,
        market,
        state,
        city: 'Austin',
        zip: '78701',
        agent_name: 'Nexus Operator',
        property_type: 'SFR',
        unit_count: '1',
      },
    })
  }

  return (
    <div className="wfs-dryrun-module">
      <section className="wfs-section wfs-dryrun-command">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Simulation</span>
            <h3>Dry Run Control</h3>
          </div>
          <span className="wfs-guard"><Icon name="shield" /> Blocked</span>
        </header>
        <div className="wfs-sim-context-grid">
          <label>
            <span>First Name</span>
            <input value={firstName} onChange={(event) => setFirstName(event.target.value)} />
          </label>
          <label>
            <span>Property</span>
            <input value={propertyAddress} onChange={(event) => setPropertyAddress(event.target.value)} />
          </label>
          <label>
            <span>Market</span>
            <input value={market} onChange={(event) => setMarket(event.target.value)} />
          </label>
          <label>
            <span>State</span>
            <input value={state} onChange={(event) => setState(event.target.value)} />
          </label>
        </div>
        <button type="button" className="wfs-primary-btn" disabled={busy} onClick={run}>
          <Icon name="play" /> Run Simulation
        </button>

        <div className="wfs-dryrun-proof">
          <span>dry_run=true</span>
          <span>outbound sends=0</span>
          <span>audit write=preview</span>
        </div>
      </section>

      <section className="wfs-section wfs-sim-timeline">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Execution</span>
            <h3>{result?.workflow?.name ?? detail.workflow.name}</h3>
          </div>
          <span className="wfs-count">{result?.steps.length ?? detail.steps.length}</span>
        </header>

        {!result ? (
          <div className="wfs-command-empty">
            <Icon name="activity" />
            <strong>Simulation ready</strong>
            <span>Run Simulation to trace every node, render the message, route the sender, resolve conditions, and prove live sends stayed blocked.</span>
          </div>
        ) : (
          <div className="wfs-dryrun-stack">
            <div className="wfs-sim-summary">
              <span className={result.live_send_blocked ? 'is-safe' : 'is-warning'}>
                <Icon name="shield" /> live_send_blocked={String(result.live_send_blocked)}
              </span>
              <span><Icon name="send" /> outbound_sent={result.no_outbound_messages_sent ? '0' : 'review'}</span>
              <span><Icon name="check-double" /> final={result.errors.length > 0 ? 'blocked' : 'guarded success'}</span>
            </div>

            {result.warnings.length > 0 && (
              <div className="wfs-warning-row">
                {result.warnings.map((warning) => <span key={warning}>{warning}</span>)}
              </div>
            )}

            <div className="wfs-execution-timeline">
              {result.steps.map((step, index) => (
                <article key={step.step_id ?? step.step_key ?? `${step.node_type}-${index}`} className={step.live_send_blocked ? 'is-live-blocked' : ''}>
                  <span className="wfs-execution-timeline__index">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <header>
                      <strong>{step.label}</strong>
                      <em>{stepSignal(step)}</em>
                    </header>
                    <small>{step.node_type} / {step.status}</small>
                    {step.rendered_template && <p>{step.rendered_template.body}</p>}
                    {step.sender_route && <small>Sender routing: {compactValue(step.sender_route)}</small>}
                    {step.wait && <small>Wait duration: {compactValue(step.wait)}</small>}
                    {step.conditions && <small>Condition result: {compactValue(step.conditions)}</small>}
                  </div>
                  {step.live_send_blocked && <Icon name="shield" />}
                </article>
              ))}
            </div>
          </div>
        )}
      </section>

      <aside className="wfs-section wfs-sim-output">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Output</span>
            <h3>Run Artifacts</h3>
          </div>
        </header>
        <div className="wfs-output-cards">
          <article>
            <span><Icon name="message" /> Rendered Message</span>
            <p>{renderedMessage?.body ?? 'No rendered message yet. Simulation will show the exact seller-facing copy here.'}</p>
            <small>{renderedMessage?.sms ? `${renderedMessage.sms.character_count} chars / ${renderedMessage.sms.segment_count} segments` : 'SMS count pending'}</small>
          </article>
          <article>
            <span><Icon name="phone" /> Sender Routing</span>
            <p>{senderRoute ? compactValue(senderRoute) : 'Routing decision will appear after simulation.'}</p>
          </article>
          <article>
            <span><Icon name="clock" /> Wait / Branch</span>
            <p>{waitStep ? compactValue(waitStep) : conditionStep ? compactValue(conditionStep) : 'Wait duration and branch result will appear here.'}</p>
          </article>
          <article className="is-safe">
            <span><Icon name="shield" /> Live-Send Proof</span>
            <p>{result ? `no_outbound_messages_sent=${String(result.no_outbound_messages_sent)}` : 'Live-send proof is armed before every simulation.'}</p>
          </article>
        </div>
      </aside>
    </div>
  )
}
