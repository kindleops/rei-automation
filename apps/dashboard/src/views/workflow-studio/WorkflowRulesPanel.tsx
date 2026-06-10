import { Icon } from '../../shared/icons'
import type { WorkflowDetail } from './workflow.types'

interface WorkflowRulesPanelProps {
  detail: WorkflowDetail
  mode: 'reply' | 'health'
}

export const WorkflowRulesPanel = ({ detail, mode }: WorkflowRulesPanelProps) => {
  const ruleSteps = mode === 'reply'
    ? detail.steps.filter((step) => ['condition', 'branch', 'suppress_phone', 'cancel_queue'].includes(step.node_type))
    : detail.steps.filter((step) => ['require_approval', 'create_notification', 'assign_operator'].includes(step.node_type))
  const senderRules = mode === 'health'
    ? detail.sender_pools.map((pool) => ({
      id: pool.id,
      label: pool.name,
      payload: pool.health_thresholds ?? {},
    }))
    : []

  return (
    <div className="wfs-panel-grid is-wide">
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">{mode === 'reply' ? 'Reply' : 'Health'}</span>
            <h3>{mode === 'reply' ? 'Rules' : 'Guardrails'}</h3>
          </div>
          <span className="wfs-count">{ruleSteps.length + senderRules.length}</span>
        </header>
        <div className="wfs-rule-list">
          {ruleSteps.length === 0 && senderRules.length === 0 ? (
            <div className="wfs-empty">No rules configured</div>
          ) : (
            <>
              {ruleSteps.map((step) => (
                <article key={step.id} className="wfs-rule-row">
                  <span><Icon name="shield" /></span>
                  <div>
                    <strong>{step.label}</strong>
                    <pre>{JSON.stringify(mode === 'reply' ? step.conditions : step.actions, null, 2)}</pre>
                  </div>
                </article>
              ))}
              {senderRules.map((rule) => (
                <article key={rule.id} className="wfs-rule-row">
                  <span><Icon name="activity" /></span>
                  <div>
                    <strong>{rule.label}</strong>
                    <pre>{JSON.stringify(rule.payload, null, 2)}</pre>
                  </div>
                </article>
              ))}
            </>
          )}
        </div>
      </section>
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Validation</span>
            <h3>Shape Check</h3>
          </div>
          <span className={detail.validation?.ok ? 'wfs-guard' : 'wfs-status is-paused'}>
            {detail.validation?.ok ? 'Valid' : 'Review'}
          </span>
        </header>
        <div className="wfs-validation-list">
          {(detail.validation?.errors ?? []).map((entry) => <span key={entry} className="is-error">{entry}</span>)}
          {(detail.validation?.warnings ?? []).map((entry) => <span key={entry}>{entry}</span>)}
          {detail.validation?.ok && (detail.validation?.warnings ?? []).length === 0 && (
            <span>Ready for dry run</span>
          )}
        </div>
      </section>
    </div>
  )
}
