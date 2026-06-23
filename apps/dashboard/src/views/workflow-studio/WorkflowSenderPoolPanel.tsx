import { Icon } from '../../shared/icons'
import type { WorkflowDetail, WorkflowSenderPool } from './workflow.types'
import { SenderPoolBuilder } from './SenderPoolBuilder'

interface WorkflowSenderPoolPanelProps {
  detail: WorkflowDetail
  busy?: boolean
  onCreateSenderPool: (payload: Record<string, unknown>) => Promise<void>
  onCreateSenderMember: (senderPoolId: string, payload: Record<string, unknown>) => Promise<void>
}

const scopeLabel = (values?: string[]) => values?.filter(Boolean).join(', ') || 'all'

function SenderPoolCard({ pool }: { pool: WorkflowSenderPool }) {
  const members = pool.members ?? []
  return (
    <article className="wfs-sender-pool">
      <header>
        <div>
          <span><Icon name={pool.channel === 'email' ? 'mail' : 'phone'} /> {pool.name}</span>
          <small>{pool.pool_key}</small>
        </div>
        <strong className="wfs-route-chip">{pool.routing_mode}</strong>
      </header>

      <div className="wfs-sender-meta">
        <span><Icon name="map" /> Market {scopeLabel(pool.market_scope)}</span>
        <span><Icon name="flag" /> State {scopeLabel(pool.state_scope)}</span>
        <span><Icon name="globe" /> Lang {scopeLabel(pool.language_scope)}</span>
        <span><Icon name="clock" /> {pool.hourly_cap ?? 'n/a'}/hr</span>
        <span><Icon name="activity" /> {pool.daily_cap ?? 'n/a'}/day</span>
      </div>

      <div className="wfs-pool-health">
        <span className={pool.is_active ? 'is-healthy' : 'is-muted'}>
          <Icon name={pool.is_active ? 'check-double' : 'pause'} />
          {pool.is_active ? 'Healthy' : 'Paused'}
        </span>
        <span className="is-safe"><Icon name="shield" /> Live blocked</span>
      </div>

      <div className="wfs-member-table">
        <header>
          <span>Sender</span>
          <span>Weight</span>
          <span>Caps</span>
          <span>Status</span>
        </header>
        {members.length === 0 ? (
          <div className="wfs-member-empty">No members attached</div>
        ) : members.map((member) => (
          <div key={member.id}>
            <span>{member.sender_label || member.sender_value}</span>
            <span>{member.weight}</span>
            <span>{member.hourly_cap ?? 'n/a'}/hr · {member.daily_cap ?? 'n/a'}/day</span>
            <strong>{member.status}</strong>
          </div>
        ))}
      </div>
    </article>
  )
}

export const WorkflowSenderPoolPanel = ({
  detail,
  busy,
  onCreateSenderPool,
  onCreateSenderMember,
}: WorkflowSenderPoolPanelProps) => (
  <div className="wfs-sender-studio">
    <section className="wfs-section wfs-sender-inventory">
      <header className="wfs-section__header">
        <div>
          <span className="wfs-kicker">Sender Pool Studio</span>
          <h3>Routing Pools</h3>
        </div>
        <span className="wfs-count">{detail.sender_pools.length}</span>
      </header>
      <div className="wfs-sender-list">
        {detail.sender_pools.length === 0 ? (
          <div className="wfs-command-empty">
            <Icon name="phone" />
            <strong>No sender pools</strong>
            <span>Create a dry-run sender pool to model routing without enabling live sends.</span>
          </div>
        ) : detail.sender_pools.map((pool) => (
          <SenderPoolCard key={pool.id} pool={pool} />
        ))}
      </div>
    </section>

    <SenderPoolBuilder
      pools={detail.sender_pools}
      busy={busy}
      onCreateSenderPool={onCreateSenderPool}
      onCreateSenderMember={onCreateSenderMember}
    />
  </div>
)
