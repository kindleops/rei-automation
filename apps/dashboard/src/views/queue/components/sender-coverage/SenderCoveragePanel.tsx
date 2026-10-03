import { useEffect, useMemo, useState } from 'react'
import { LCButton, LCDialog, LCEmpty, LCError, LCIconButton, LCMetric, LCSegmented, LCSelect, LCSkeleton, LCStatus, cx } from '../../../../shared/lc'
import {
  previewRoutes,
  readSenderCoverage,
  saveRoutes,
  type AffinityTier,
  type CoverageMarket,
  type CoverageStatus,
  type RouteDraft,
  type RoutePreview,
  type SenderCoverage,
} from './sender-coverage-api'
import { STATUS_FILTERS, STATUS_META, TIER_LABEL, TIER_ORDER, reasonWords, routeHealthTone } from './sender-coverage-model'
import './sender-coverage.css'

/**
 * SENDER COVERAGE (Sender Routing 2.0) — inside the Queue app's Sender Fleet
 * section, desktop only. Markets x ordered pools x health, the factual
 * LOCAL / REGIONAL / DEGRADED / UNCOVERED status, and route edits with an
 * impact preview. The server decides every status; this view renders it.
 */
export function SenderCoveragePanel() {
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<{ loading: boolean; data: SenderCoverage | null; error: string | null }>({ loading: true, data: null, error: null })
  const [filter, setFilter] = useState<'ALL' | CoverageStatus>('ALL')
  const [editing, setEditing] = useState<CoverageMarket | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    readSenderCoverage(ctl.signal).then((res) => {
      if (ctl.signal.aborted) return
      setState(res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: null, error: res.message })
    })
    return () => ctl.abort()
  }, [reload])

  const data = state.data
  const markets = useMemo(() => {
    const list = data?.markets ?? []
    const order: Record<CoverageStatus, number> = { UNCOVERED: 0, DEGRADED: 1, REGIONAL: 2, LOCAL: 3 }
    return list
      .filter((m) => filter === 'ALL' || m.status === filter)
      .slice()
      .sort((a, b) => order[a.status] - order[b.status] || (b.parked_sends ?? 0) - (a.parked_sends ?? 0) || a.display_name.localeCompare(b.display_name))
  }, [data, filter])

  if (state.loading && !data) {
    return (
      <section className="sc" aria-label="Sender coverage">
        <LCSkeleton shape="lines" count={6} label="Loading sender coverage" />
      </section>
    )
  }
  if (!data) {
    return (
      <section className="sc" aria-label="Sender coverage">
        <LCError what="Sender coverage" detail={state.error ?? undefined} onRetry={() => setReload((n) => n + 1)} />
      </section>
    )
  }

  const proposal = data.graph_status !== 'live'
  const m = data.metrics
  return (
    <section className="sc" aria-label="Sender coverage">
      <header className="sc-head">
        <div className="sc-head__title">
          <h3>Sender Coverage</h3>
          <p>
            Which pools may send for each market, in priority order, and whether they can send right now. Geography picks the pool; the existing
            allocator picks the number inside it.
          </p>
        </div>
        <div className="sc-head__state">
          {proposal ? (
            <LCStatus tone="attn" label={`Proposed graph · ${data.proposal_version ?? 'pending'} · not enabled`} title={`The routing schema is not applied. This is the proposal awaiting owner approval; live sends still use today's router.${data.seed_backfill_simulated ? " Registration and webhook evidence from the proposed seed is applied in memory (not written)." : ''}`} />
          ) : (
            <LCStatus tone={data.graph_enabled ? 'ok' : 'neutral'} label={`Live graph v${data.graph_version ?? '—'} · routing ${data.graph_enabled ? 'on' : 'off'}`} />
          )}
          <LCIconButton icon="refresh-cw" label="Refresh coverage" size="sm" onClick={() => setReload((n) => n + 1)} />
        </div>
      </header>

      {proposal && data.seed_backfill_simulated ? (
        <p className="sc-note">Preview of the proposal as seeded: registration and inbound-webhook evidence from the 2026-10-02 reconciliation is applied in memory. Today every number has registration_status unrecorded; nothing has been written.</p>
      ) : null}
      {!data.blocklist_readable ? <p className="sc-warn">The operator blocklist could not be read; eligibility below may overstate coverage.</p> : null}

      <div className="sc-metrics">
        <LCMetric size="sm" label="Local" value={m.local} tone="ok" basis={`of ${m.markets} markets`} />
        <LCMetric size="sm" label="Regional" value={m.regional} tone="exec" />
        <LCMetric size="sm" label="Degraded" value={m.degraded} tone={m.degraded ? 'attn' : null} />
        <LCMetric size="sm" label="Uncovered" value={m.uncovered} tone={m.uncovered ? 'crit' : null} />
        <LCMetric size="sm" label="Healthy senders" value={m.healthy_senders} basis={`${data.pools.reduce((s, p) => s + p.total, 0)} in pools`} />
        <LCMetric size="sm" label="Capacity left today" value={m.daily_capacity_remaining.toLocaleString()} basis={data.per_sender_cap ? `cap ${data.per_sender_cap}/number` : undefined} />
        <LCMetric size="sm" label="Parked sends" value={m.parked_sends === null ? null : m.parked_sends} basis={data.parked_unresolved_market ? `+${data.parked_unresolved_market} with no canonical market` : 'no_eligible_sender_for_route'} />
      </div>

      <div className="sc-pools" role="list" aria-label="Pools">
        {data.pools.map((p) => (
          <div key={p.pool_key} className={cx('sc-pool', `is-${p.health}`)} role="listitem">
            <div className="sc-pool__top">
              <span className="sc-pool__name">{p.name}</span>
              <span className="sc-pool__count">
                {p.eligible}/{p.total}
              </span>
            </div>
            <ul className="sc-pool__numbers">
              {p.numbers.length ? (
                p.numbers.map((n) => (
                  <li key={n.textgrid_number_id ?? n.phone ?? ''} className={cx(n.eligible && 'is-ok')}>
                    <span className="sc-mono">{n.phone ?? '—'}</span>
                    <span>{reasonWords(n.reason)}</span>
                  </li>
                ))
              ) : (
                <li>
                  <span>No numbers yet</span>
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>

      <div className="sc-toolbar">
        <LCSegmented size="sm" label="Filter markets by coverage" options={STATUS_FILTERS} value={filter} onChange={setFilter} />
        <span className="sc-toolbar__meta">{markets.length} markets</span>
      </div>

      {markets.length ? (
        <div className="sc-table" role="table" aria-label="Market coverage">
          <div className="sc-row sc-row--head" role="row">
            <span role="columnheader">Market</span>
            <span role="columnheader">Coverage</span>
            <span role="columnheader">Routes in priority order</span>
            <span role="columnheader">Parked</span>
            <span role="columnheader" className="sc-sr">Edit</span>
          </div>
          {markets.map((mk) => (
            <div key={mk.market_id} className="sc-row" role="row">
              <span role="cell" className="sc-market">
                <strong>{mk.display_name}</strong>
                <small>{mk.label ?? (mk.routes.length ? 'No route can send now' : 'No routes configured')}</small>
              </span>
              <span role="cell">
                <LCStatus tone={STATUS_META[mk.status].tone} label={STATUS_META[mk.status].label} title={data.definitions[mk.status]} />
              </span>
              <span role="cell" className="sc-chain">
                {mk.routes.length ? (
                  mk.routes.map((r, i) => (
                    <span key={r.pool_key} className={cx('sc-hop', mk.active_pool === r.pool_key && 'is-active')} data-tone={routeHealthTone(r)} title={`${TIER_LABEL[r.tier]} · ${r.eligible}/${r.total} eligible${r.provenance ? ` · ${r.provenance}` : ''}`}>
                      {i > 0 ? <span className="sc-hop__sep" aria-hidden="true">›</span> : null}
                      <span className="sc-hop__dot" aria-hidden="true" />
                      <span className="sc-hop__name">{r.pool_name}</span>
                      <span className="sc-hop__tier">{r.local ? 'local' : TIER_LABEL[r.tier].toLowerCase()}</span>
                    </span>
                  ))
                ) : (
                  <span className="sc-muted">—</span>
                )}
                {mk.blocked_pools.length ? <span className="sc-muted">never: {mk.blocked_pools.join(', ')}</span> : null}
              </span>
              <span role="cell" className="sc-num">{mk.parked_sends === null ? '—' : mk.parked_sends}</span>
              <span role="cell">
                <LCButton size="sm" variant="ghost" onClick={() => setEditing(mk)}>
                  Edit
                </LCButton>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <LCEmpty compact title="No markets in this state" body="Change the filter to see other markets." />
      )}

      <dl className="sc-defs">
        {(Object.keys(STATUS_META) as CoverageStatus[]).map((k) => (
          <div key={k}>
            <dt>{STATUS_META[k].label}</dt>
            <dd>{data.definitions[k]}</dd>
          </div>
        ))}
      </dl>

      {editing ? <RouteEditor key={editing.market_id} market={editing} pools={data.pools.map((p) => ({ key: p.pool_key, name: p.name }))} live={!proposal} onClose={(saved) => { setEditing(null); if (saved) setReload((n) => n + 1) }} /> : null}
    </section>
  )
}

function RouteEditor({ market, pools, live, onClose }: { market: CoverageMarket; pools: Array<{ key: string; name: string }>; live: boolean; onClose: (saved: boolean) => void }) {
  const [drafts, setDrafts] = useState<RouteDraft[]>(() => market.routes.map((r) => ({ pool_key: r.pool_key, tier: r.tier })).concat(market.blocked_pools.map((k) => ({ pool_key: k, tier: 'blocked_never' as AffinityTier }))))
  const [preview, setPreview] = useState<{ busy: boolean; result: RoutePreview | null; error: string | null }>({ busy: false, result: null, error: null })
  const [save, setSave] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const [reason, setReason] = useState('')

  const used = new Set(drafts.map((d) => d.pool_key))
  const free = pools.filter((p) => !used.has(p.key))
  const change = (next: RouteDraft[]) => {
    setDrafts(next)
    setPreview({ busy: false, result: null, error: null })
  }
  const move = (i: number, by: number) => {
    const next = drafts.slice()
    const j = i + by
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    change(next)
  }
  const payload = () => drafts.map((d, i) => ({ ...d, priority: (i + 1) * 10 }))
  const runPreview = async () => {
    setPreview({ busy: true, result: null, error: null })
    const res = await previewRoutes(market.market_id, payload())
    setPreview(res.ok ? { busy: false, result: res.data, error: null } : { busy: false, result: null, error: res.message })
  }
  const runSave = async () => {
    setSave({ busy: true, error: null })
    const res = await saveRoutes(market.market_id, payload(), reason.trim())
    if (res.ok) onClose(true)
    else setSave({ busy: false, error: res.status === 423 ? 'Graph edits are gated off (SENDER_ROUTING_GRAPH_WRITES).' : res.message })
  }

  return (
    <LCDialog
      open
      onOpenChange={(open) => { if (!open) onClose(false) }}
      title={`Routes for ${market.display_name}`}
      description="Walked top to bottom; the first pool with an eligible sender sends. Load balancing happens only inside a pool."
      width={620}
      sticky
      footer={
        <div className="sc-edit__foot">
          <LCButton variant="secondary" size="sm" loading={preview.busy} onClick={runPreview}>
            Preview impact
          </LCButton>
          <LCButton
            variant="primary"
            size="sm"
            loading={save.busy}
            disabled={!live || !preview.result || !reason.trim()}
            title={!live ? 'The routing schema is not applied; the proposal is edited by the owner before it is seeded.' : !preview.result ? 'Preview the impact first' : !reason.trim() ? 'A reason is required (audited)' : undefined}
            onClick={runSave}
          >
            Save routes
          </LCButton>
        </div>
      }
    >
      <ol className="sc-edit">
        {drafts.map((d, i) => (
          <li key={d.pool_key} className="sc-edit__row">
            <span className="sc-edit__n">{i + 1}</span>
            <LCSelect
              size="sm"
              label="Pool"
              value={d.pool_key}
              options={pools.filter((p) => p.key === d.pool_key || !used.has(p.key)).map((p) => ({ value: p.key, label: p.name }))}
              onChange={(v) => change(drafts.map((x, k) => (k === i ? { ...x, pool_key: v } : x)))}
            />
            <LCSelect<AffinityTier>
              size="sm"
              label="Tier"
              value={d.tier}
              options={TIER_ORDER.map((t) => ({ value: t, label: TIER_LABEL[t] }))}
              onChange={(v) => change(drafts.map((x, k) => (k === i ? { ...x, tier: v } : x)))}
            />
            <LCIconButton icon="chevron-up" label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
            <LCIconButton icon="chevron-down" label="Move down" size="sm" disabled={i === drafts.length - 1} onClick={() => move(i, 1)} />
            <LCIconButton icon="x" label="Remove route" size="sm" onClick={() => change(drafts.filter((_, k) => k !== i))} />
          </li>
        ))}
      </ol>
      {free.length ? (
        <LCButton size="sm" variant="quiet" onClick={() => change([...drafts, { pool_key: free[0].key, tier: 'regional_fallback' }])}>
          Add route
        </LCButton>
      ) : null}
      <label className="sc-edit__reason">
        <span>Reason (audited)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Phoenix may use Dallas while LA is blocked" />
      </label>
      {preview.error ? <p className="sc-warn">{preview.error}</p> : null}
      {preview.result ? (
        <div className="sc-impact" aria-live="polite">
          <span>
            Coverage <strong>{STATUS_META[preview.result.coverage_before].label}</strong> → <strong>{STATUS_META[preview.result.coverage_after].label}</strong>
          </span>
          <span>{preview.result.rows_considered} queued / parked sends in this market</span>
          <span className="is-ok">{preview.result.became_routable} become routable</span>
          <span className={cx(preview.result.lost_coverage > 0 && 'is-crit')}>{preview.result.lost_coverage} lose coverage</span>
          <span>{preview.result.changed_pool} change pool</span>
        </div>
      ) : null}
      {save.error ? <p className="sc-warn">{save.error}</p> : null}
    </LCDialog>
  )
}
