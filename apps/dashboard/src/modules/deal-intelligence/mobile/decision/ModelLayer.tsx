/**
 * MODEL LAYER — how the number was made, and what it would be if an input
 * were different. The scenario lab replays the engine's own arithmetic
 * (deal-scenario-model.ts, pinned to production vectors). A scenario is held
 * in this component only: it is never saved, never sent, and never replaces
 * the system baseline. Reset returns to the engine's inputs.
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import type { DealDecision, ScenarioInputs } from '../../../../domain/deal-intelligence/deal-decision-api'
import { ago, money, shortDate } from '../../../../domain/deal-intelligence/deal-decision-api'
import { computeScenarioOffer } from '../../../../domain/deal-intelligence/deal-scenario-model'
import { cls, DdCard } from './dd-primitives'
import { ConfidenceBars } from './EvidenceLayer'

type Lever = { key: keyof ScenarioInputs; label: string; min: number; max: number; step: number; fmt: (v: number) => string }

export function ScenarioLab({ d }: { d: DealDecision }) {
  const base = d.scenario?.inputs ?? null
  const [s, setS] = useState<ScenarioInputs | null>(base)
  const baseline = useMemo(() => (base ? computeScenarioOffer(base) : null), [base])
  const scen = useMemo(() => (s ? computeScenarioOffer(s) : null), [s])
  if (!base || !s || !baseline || !scen) {
    return (
      <DdCard id="lab" title="Scenario lab" icon="brain" meta="unavailable">
        <p className="ddx-empty">{d.decision.status === 'available' ? 'This analysis did not record the offer inputs, so it cannot be replayed.' : 'Run the decision engine first — there is no baseline to model from.'}</p>
      </DdCard>
    )
  }
  const levers: Lever[] = [
    { key: 'valuation_mid', label: 'Value (ARV)', min: Math.round(base.valuation_mid * 0.6 / 1000) * 1000, max: Math.round(base.valuation_mid * 1.4 / 1000) * 1000, step: 1000, fmt: (v) => money(v, { exact: true }) ?? '' },
    { key: 'repairs', label: 'Repairs', min: 0, max: Math.max(50000, Math.round(base.repairs * 2.5 / 1000) * 1000), step: 500, fmt: (v) => money(v, { exact: true }) ?? '' },
    { key: 'minimum_margin_floor', label: 'Margin floor', min: 5000, max: 60000, step: 500, fmt: (v) => money(v, { exact: true }) ?? '' },
    { key: 'valuation_confidence', label: 'Valuation confidence', min: 0, max: 100, step: 1, fmt: (v) => `${Math.round(v)}` },
  ]
  const changed = levers.some((l) => s[l.key] !== base[l.key])
  const rows: Array<[string, number | null, number | null]> = [
    ['Recommended', baseline.recommended_offer, scen.recommended_offer],
    ['Floor', baseline.minimum_offer, scen.minimum_offer],
    ['Buyer ceiling', baseline.effective_ceiling, scen.effective_ceiling],
    ['Expected fee', baseline.expected_fee, scen.expected_fee],
    ['Target margin', baseline.target_margin, scen.target_margin],
  ]
  const ask = d.offer?.negotiation.ask ?? null

  return (
    <DdCard id="lab" title="Scenario lab" icon="brain" meta={changed ? <b>scenario active</b> : 'at system baseline'}>
      {!d.scenario?.replayable && d.scenario?.reason === 'replay_differs_from_stored' ? (
        <p className="ddx-note is-warn">
          The stored offer ({money(d.offer?.recommended)}) came from earlier engine arithmetic. The baseline here is today’s policy on the same inputs ({money(baseline.recommended_offer)}). Nothing has been re-saved.
        </p>
      ) : null}
      <div className="ddx-levers">
        {levers.map((l) => {
          const v = s[l.key] as number
          const moved = v !== base[l.key]
          return (
            <label key={l.key} className={cls('ddx-lever', moved && 'is-moved')}>
              <span className="ddx-lever__head"><span>{l.label}</span><b>{l.fmt(v)}</b>{moved ? <em>was {l.fmt(base[l.key] as number)}</em> : null}</span>
              <input
                type="range"
                min={l.min}
                max={l.max}
                step={l.step}
                value={v}
                onChange={(e) => setS((cur) => (cur ? { ...cur, [l.key]: Number(e.target.value) } : cur))}
                style={{ ['--p' as string]: `${((v - l.min) / (l.max - l.min || 1)) * 100}%` }}
              />
            </label>
          )
        })}
      </div>
      <table className="ddx-compare">
        <thead><tr><th /><th>System</th><th>Scenario</th><th>Δ</th></tr></thead>
        <tbody>
          {rows.map(([k, a, b]) => {
            const delta = a !== null && b !== null ? b - a : null
            return (
              <tr key={k} className={k === 'Recommended' ? 'is-key' : ''}>
                <th>{k}</th>
                <td>{money(a)}</td>
                <td>{money(b)}</td>
                <td className={cls(delta !== null && delta > 0 && 'is-up', delta !== null && delta < 0 && 'is-down')}>{delta ? `${delta > 0 ? '+' : ''}${money(delta)}` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {ask ? <p className="ddx-note">Scenario gap to the {money(ask)} ask: <b>{money(ask - scen.recommended_offer)}</b> (system: {money(ask - baseline.recommended_offer)}).</p> : null}
      <div className="ddx-lab__foot">
        <span><Icon name="shield" /> Scenario only — not saved, not sent.</span>
        <button type="button" className="ddx-btn" onClick={() => setS(base)} disabled={!changed}><Icon name="refresh-cw" /> Reset</button>
      </div>
    </DdCard>
  )
}

export function Sensitivity({ d }: { d: DealDecision }) {
  const rows = d.scenario?.sensitivity ?? []
  if (!rows.length) return null
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.delta)))
  return (
    <DdCard id="sens" title="Sensitivity" icon="activity" meta="offer Δ, one input at a time" defaultOpen={false}>
      <ul className="ddx-tornado">
        {rows.map((r) => (
          <li key={r.key}>
            <span>{r.label}</span>
            <div className="ddx-tornado__track">
              <i className={r.delta >= 0 ? 'is-up' : 'is-down'} style={{ width: `${(Math.abs(r.delta) / max) * 50}%` }} />
            </div>
            <b className={r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : ''}>{r.delta ? `${r.delta > 0 ? '+' : ''}${money(r.delta)}` : '±$0'}</b>
          </li>
        ))}
      </ul>
    </DdCard>
  )
}

export function Methodology({ d, onRunEngine, engineBusy }: { d: DealDecision; onRunEngine?: (() => void) | null; engineBusy?: boolean }) {
  const o = d.offer
  const cur = d.scenario?.current ?? null
  const inp = d.scenario?.inputs ?? null
  const [confirm, setConfirm] = useState(false)
  return (
    <DdCard id="method" title="Method & lineage" icon="file-text" meta={d.lineage.engineVersion ? `engine ${d.lineage.engineVersion}` : 'no analysis'} defaultOpen={false}>
      {o && inp && cur ? (
        <ol className="ddx-steps">
          <li><span>Exit ceiling</span><code>{money(inp.valuation_mid)} × {inp.max_arv_factor} − {money(inp.repairs)} repairs</code><b>{money(cur.valuation_ceiling)}</b></li>
          <li><span>Buyer ceiling</span><code>{inp.buyer_ceiling_authoritative ? 'min(exit, observed buyers)' : 'exit, may only be reduced by modelled buyer demand'}</code><b>{money(cur.effective_ceiling)}</b></li>
          <li><span>Market terms</span><code>−{cur.terms.confidence_haircut_pct}% confidence · −{cur.terms.motivation_discount_pct}% motivation · +{cur.terms.demand_premium_pct}% demand</code><b /></li>
          <li><span>Margin</span><code>target {money(cur.target_margin)} ({Math.round(cur.margin_pct * 100)}%), protected {money(cur.protected_margin)}</code><b /></li>
          <li className="is-key"><span>Offer</span><code>ceiling × terms − target, capped at ceiling − protected, to $100</code><b>{money(cur.recommended_offer)}</b></li>
          <li><span>Floor</span><code>offer − max($5K, 3% of value)</code><b>{money(cur.minimum_offer)}</b></li>
        </ol>
      ) : <p className="ddx-empty">No replayable offer calculation on record.</p>}
      <span className="ddx-sub">Confidence</span>
      <ConfidenceBars d={d} />
      <dl className="ddx-kv">
        <div><dt>Engine</dt><dd>{d.lineage.engine} {d.lineage.engineVersion ?? ''}</dd></div>
        <div><dt>Margin policy</dt><dd>{d.lineage.policyVersion ?? '—'}</dd></div>
        <div><dt>Last analysed</dt><dd>{d.lineage.computedAt ? `${shortDate(d.lineage.computedAt)} · ${ago(d.lineage.computedAt)}` : 'never'}</dd></div>
        <div><dt>Snapshots</dt><dd>{d.lineage.snapshotCount}{d.lineage.snapshotMatchesProjection === false ? ' · latest ≠ projection' : ''}</dd></div>
        {o?.repairs.amount ? <div><dt>Repairs source</dt><dd>{o.repairs.source ?? '—'}{o.repairs.confidence ? ` · conf ${o.repairs.confidence}` : ''}</dd></div> : null}
      </dl>
      {onRunEngine ? (
        confirm ? (
          <div className="ddx-confirm">
            <p>Re-analysis writes a new canonical score and an immutable snapshot for this property. It sends nothing to the seller.</p>
            <div>
              <button type="button" className="ddx-btn" onClick={() => setConfirm(false)}>Cancel</button>
              <button type="button" className="ddx-btn is-primary" disabled={engineBusy} onClick={() => { setConfirm(false); onRunEngine() }}><Icon name="zap" /> Re-analyse</button>
            </div>
          </div>
        ) : (
          <button type="button" className="ddx-btn is-wide" disabled={engineBusy} onClick={() => setConfirm(true)}>
            <Icon name="refresh-cw" /> {engineBusy ? 'Analysing…' : 'Re-run decision engine'}
          </button>
        )
      ) : null}
    </DdCard>
  )
}
