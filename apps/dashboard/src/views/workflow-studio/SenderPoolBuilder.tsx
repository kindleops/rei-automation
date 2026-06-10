import { useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { WorkflowSenderPool } from './workflow.types'

const splitScope = (value: string) =>
  value.split(',').map((item) => item.trim()).filter(Boolean)

interface SenderPoolBuilderProps {
  pools: WorkflowSenderPool[]
  busy?: boolean
  onCreateSenderPool: (payload: Record<string, unknown>) => Promise<void>
  onCreateSenderMember: (senderPoolId: string, payload: Record<string, unknown>) => Promise<void>
}

export const SenderPoolBuilder = ({
  pools,
  busy,
  onCreateSenderPool,
  onCreateSenderMember,
}: SenderPoolBuilderProps) => {
  const [poolName, setPoolName] = useState('Default SMS Pool')
  const [marketScope, setMarketScope] = useState('default')
  const [stateScope, setStateScope] = useState('TX')
  const [selectedPoolId, setSelectedPoolId] = useState(pools[0]?.id ?? '')
  const [senderValue, setSenderValue] = useState('+15555550100')
  const [senderLabel, setSenderLabel] = useState('Dry Run Sender')

  const selectedPool = useMemo(
    () => pools.find((pool) => pool.id === selectedPoolId) ?? pools[0],
    [pools, selectedPoolId],
  )

  const createPool = async () => {
    await onCreateSenderPool({
      name: poolName,
      pool_key: poolName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      channel: 'sms',
      market_scope: splitScope(marketScope),
      state_scope: splitScope(stateScope),
      language_scope: ['en'],
      routing_mode: 'exact_market',
      daily_cap: 50,
      hourly_cap: 10,
      health_thresholds: { max_failure_rate: 0.05, max_opt_out_rate: 0.012 },
    })
  }

  const createMember = async () => {
    if (!selectedPool) return
    await onCreateSenderMember(selectedPool.id, {
      sender_value: senderValue,
      sender_label: senderLabel,
      status: 'active',
      weight: 1,
      daily_cap: 25,
      hourly_cap: 5,
    })
  }

  return (
    <section className="wfs-section wfs-sender-builder">
      <header className="wfs-section__header">
        <div>
          <span className="wfs-kicker">Routing</span>
          <h3>Sender Pool Builder</h3>
        </div>
        <span className="wfs-guard"><Icon name="shield" /> Live blocked</span>
      </header>

      <div className="wfs-routing-mode-row">
        <span className="is-active"><Icon name="target" /> Exact Market</span>
        <span><Icon name="map" /> State Fallback</span>
        <span><Icon name="activity" /> Health Weighted</span>
      </div>

      <div className="wfs-form-grid">
        <label>
          <span>Pool Name *</span>
          <input value={poolName} onChange={(event) => setPoolName(event.target.value)} />
        </label>
        <label>
          <span>Markets *</span>
          <input value={marketScope} onChange={(event) => setMarketScope(event.target.value)} />
        </label>
        <label>
          <span>States *</span>
          <input value={stateScope} onChange={(event) => setStateScope(event.target.value)} />
        </label>
      </div>
      <div className="wfs-pool-cap-preview">
        <span><Icon name="clock" /> 10/hour</span>
        <span><Icon name="activity" /> 50/day</span>
        <span><Icon name="globe" /> EN scope</span>
      </div>
      <button type="button" className="wfs-primary-btn" disabled={busy} onClick={createPool}>
        <Icon name="check" /> Add Pool
      </button>

      <div className="wfs-builder-divider" />

      <div className="wfs-form-grid">
        <label>
          <span>Pool *</span>
          <select value={selectedPool?.id ?? ''} onChange={(event) => setSelectedPoolId(event.target.value)}>
            {pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}
          </select>
        </label>
        <label>
          <span>Sender *</span>
          <input value={senderValue} onChange={(event) => setSenderValue(event.target.value)} />
        </label>
        <label>
          <span>Label</span>
          <input value={senderLabel} onChange={(event) => setSenderLabel(event.target.value)} />
        </label>
      </div>
      <div className="wfs-pool-cap-preview">
        <span><Icon name="clock" /> 5/hour</span>
        <span><Icon name="activity" /> 25/day</span>
        <span><Icon name="shield" /> dry-run route</span>
      </div>
      <button type="button" className="wfs-primary-btn" disabled={busy || !selectedPool} onClick={createMember}>
        <Icon name="send" /> Add Sender
      </button>
    </section>
  )
}
