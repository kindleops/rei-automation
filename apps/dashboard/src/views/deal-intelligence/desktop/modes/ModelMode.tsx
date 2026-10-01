import { useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { cx, LCButton, LCConfirm } from '../../../../shared/lc'
import { ago, dateShort, dateTime, usd } from '../di-format'
import { availableOf, rerunReasons, snapshotRows, type ConfidenceModel, type GateView } from '../di-model'
import type { DiDecision, DiSelection } from '../di-types'
import { Plane } from '../di-ui'
import { ConfidencePlane, GatePlane } from '../planes/ConfidenceGates'

/**
 * MODEL — exceptionally transparent: what the engine scored and how, what it
 * weighted, which inputs it lacked, every immutable snapshot, and whether a
 * re-run would change anything. Strategy scores are strategy outputs, not a
 * global "deal quality".
 */
export function ModelMode({ d, conf, gates, selection, onSelect, engine, now }: {
  d: DiDecision
  conf: ConfidenceModel | null
  gates: GateView[]
  selection: DiSelection | null
  onSelect: (s: DiSelection) => void
  engine: { canRun: boolean; running: boolean; onRun: () => void; error: string | null; progress: Array<{ stage: string; status: string; label: string }> }
  now: number
}) {
  const dec = availableOf(d)
  const aos = dec?.aosComposition ?? null
  const snaps = snapshotRows(d)
  const reasons = rerunReasons(d)
  const [confirm, setConfirm] = useState(false)
  const cb = dec?.confidenceBreakdown
  const strategies = d.strategies
  const sMax = 100
  return (
    <div className="dr-mode dr-model">
      <div className="dr-model__grid">
        <Plane id="strategies" eyebrow="Strategy outputs" title={dec?.bestStrategyLabel ? `Engine best: ${dec.bestStrategyLabel}` : 'No strategy scored'} under="flow">
          {strategies.length ? (
            <ol className="dr-strats">
              {strategies.map((s) => {
                const sel = selection?.type === 'strategy' && selection.key === s.key
                return (
                  <li key={s.key}>
                    <button type="button" className={cx('dr-strat', s.isBest && 'is-best', sel && 'is-selected')} onClick={() => onSelect({ type: 'strategy', key: s.key })} aria-pressed={sel}>
                      <span className="dr-strat__name">{s.label}{s.isBest ? <em>engine best</em> : null}</span>
                      <span className="dr-strat__bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, ((s.score ?? 0) / sMax) * 100))}%` }} /><b className="dr-strat__tick" style={{ left: '68%' }} /></span>
                      <b className="lc-num">{s.score ?? '—'}</b>
                    </button>
                  </li>
                )
              })}
            </ol>
          ) : <p className="dr-none">The engine scored no strategies for this property.</p>}
          {dec?.strategyBasis ? (
            <p className="dr-quiet">
              {dec.strategyBasis.cashViable ? `Cash is viable (fee ${usd(dec.strategyBasis.fee)} ≥ ${usd(dec.strategyBasis.feeNeeded)}, valuation confidence ${dec.strategyBasis.valuationConfidence} ≥ 60), so cash leads even where a creative score is higher.` : `Cash is not viable here, so the strongest creative strategy (≥ 68) leads${dec.strategyBasis.creativeBest ? `: ${dec.strategyBasis.creativeBest} ${dec.strategyBasis.creativeBestScore}` : ''}.`} Tick at 68 = the engine’s creative-strategy threshold. Cash shows the engine’s cash-offer confidence.
            </p>
          ) : null}
        </Plane>

        <Plane id="aos" eyebrow="Acquisition opportunity score" title={aos ? <><span className="dr-big lc-num">{aos.score ?? '—'}</span><small>/1,000 · gate 780</small></> : 'Composition not recorded'} headerLabel="AOS composition" under="exec">
          {aos ? (
            <>
              <div className="dr-aos-total" aria-hidden="true">
                {aos.components.map((c) => <i key={c.key} data-key={c.key} style={{ width: `${(c.points / aos.max) * 100}%` }} />)}
                <b className="dr-aos-total__gate" style={{ left: '78%' }} />
              </div>
              <ol className="dr-aos">
                {aos.components.map((c) => {
                  const sel = selection?.type === 'aos' && selection.key === c.key
                  return (
                    <li key={c.key}>
                      <button type="button" className={cx('dr-aosrow', sel && 'is-selected')} onClick={() => onSelect({ type: 'aos', key: c.key })} aria-pressed={sel}>
                        <span>{c.label}</span>
                        <span className="dr-aosrow__bar" aria-hidden="true"><i data-key={c.key} style={{ width: `${(c.points / c.max) * 100}%` }} /></span>
                        <b className="lc-num">{Math.round(c.points)}<small>/{c.max}</small></b>
                      </button>
                    </li>
                  )
                })}
              </ol>
              {aos.motivation?.reasons.length ? <p className="dr-quiet">Distress factors on record: {aos.motivation.reasons.map((r) => `${r.reason} +${r.points}`).join(' · ')}.</p> : null}
            </>
          ) : <p className="dr-none">This analysis predates the recorded AOS breakdown.</p>}
        </Plane>

        <ConfidencePlane model={conf} selection={selection} onSelect={onSelect} />
        <GatePlane gates={gates} tierLabel={dec?.tierLabel ?? null} selection={selection} onSelect={onSelect} />

        <Plane id="coverage" eyebrow="Input coverage" title={cb ? `${(cb.missing ?? []).length} engine input${(cb.missing ?? []).length === 1 ? '' : 's'} missing` : 'Not recorded'} depth={1}>
          {cb ? (
            <div className="dr-coverage">
              <div><span className="dr-eyebrow">Subject data · {cb.subject ?? '—'}</span>{(cb.subjectMissing ?? []).length ? <ul>{cb.subjectMissing!.map((m) => <li key={m}><Icon name="x" size={10} />{m}</li>)}</ul> : <p className="dr-quiet">Nothing missing.</p>}</div>
              <div><span className="dr-eyebrow">Finance & distress · {cb.finance ?? '—'}</span>{(cb.financeMissing ?? cb.missing).length ? <ul>{(cb.financeMissing ?? cb.missing).map((m) => <li key={m}><Icon name="x" size={10} />{m}</li>)}</ul> : <p className="dr-quiet">Nothing missing.</p>}</div>
              {dec?.investorEvidence ? (
                <div><span className="dr-eyebrow">Buyer behavior · {cb.buyer ?? '—'}</span><p className="dr-quiet">{[dec.investorEvidence.local !== null ? `${dec.investorEvidence.local} nearby investor purchases` : null, dec.investorEvidence.distinctBuyers !== null ? `${dec.investorEvidence.distinctBuyers} distinct buyers` : null, dec.investorEvidence.recent !== null ? `${dec.investorEvidence.recent} recent` : null, dec.investorEvidence.method].filter(Boolean).join(' · ')}</p></div>
              ) : null}
            </div>
          ) : <p className="dr-none">This analysis did not record input coverage.</p>}
        </Plane>
      </div>

      <Plane id="snapshots" eyebrow="Immutable snapshots" title={`${d.lineage.snapshotCount} snapshot${d.lineage.snapshotCount === 1 ? '' : 's'}${d.lineage.snapshotMatchesProjection === false ? ' · latest differs from the live projection' : ''}`} under="exec"
        aside={
          <div className="dr-rerun">
            {reasons.length ? <span className="dr-rerun__why" data-tone="attn">{reasons[0]}</span> : <span className="dr-rerun__why">No input has changed since the last analysis — a re-run would reproduce it.</span>}
            {engine.canRun ? <LCButton size="sm" icon="refresh-cw" loading={engine.running} onClick={() => setConfirm(true)}>Re-run decision engine</LCButton> : null}
          </div>
        }>
        {engine.running || engine.progress.some((p) => p.status === 'done') ? (
          <ol className="dr-progress" aria-label="Engine run progress">
            {engine.progress.map((p) => <li key={p.stage} data-status={p.status}><i />{p.label}</li>)}
          </ol>
        ) : null}
        {engine.error ? <p className="dr-warn">The last run did not finish: {engine.error.replace(/_/g, ' ')}.</p> : null}
        {snaps.length ? (
          <table className="dr-table dr-snaps">
            <thead><tr><th>Computed</th><th>Engine value</th><th>Offer</th><th>Floor</th><th>Confidence</th><th>Comps</th><th>Decision</th></tr></thead>
            <tbody>
              {snaps.map((s) => {
                const sel = selection?.type === 'snapshot' && selection.index === s.index
                const delta = (v: number | null | undefined, fmt: (n: number) => string | null) => (v ? <em data-dir={v > 0 ? 'up' : 'down'}>{v > 0 ? '+' : ''}{fmt(v)}</em> : null)
                return (
                  <tr key={s.at} className={cx(sel && 'is-selected')} onClick={() => onSelect({ type: 'snapshot', index: s.index })}>
                    <td><button type="button" className="dr-linkcell" onClick={() => onSelect({ type: 'snapshot', index: s.index })}>{dateTime(s.at)}</button><small>{ago(s.at, now)}</small></td>
                    <td className="lc-num">{usd(s.mid) ?? '—'}{delta(s.delta?.mid, (n) => usd(n))}</td>
                    <td className="lc-num">{usd(s.offer) ?? '—'}{delta(s.delta?.offer, (n) => usd(n))}</td>
                    <td className="lc-num">{usd(s.floor) ?? '—'}</td>
                    <td className="lc-num">{s.confidence ?? '—'}{delta(s.delta?.confidence, (n) => String(n))}</td>
                    <td className="lc-num">{s.comps ?? '—'}{delta(s.delta?.comps, (n) => String(n))}</td>
                    <td>{s.tier ?? '—'}{s.delta?.tierChanged ? <em data-dir="change">changed</em> : null}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : <p className="dr-none">No immutable snapshots recorded (snapshots exist since Aug 31, 2026).</p>}
        {snaps.length > 1 && snaps.every((s) => !s.delta || (!s.delta.mid && !s.delta.offer && !s.delta.tierChanged)) ? <p className="dr-quiet">Value, offer and decision are unchanged across these snapshots.</p> : null}
        <p className="dr-quiet">Snapshots are append-only; selecting one compares it with the current decision. Nothing here rewrites history.{d.lineage.latestSnapshotAt ? ` Latest ${dateShort(d.lineage.latestSnapshotAt, now)}.` : ''}</p>
      </Plane>

      <LCConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Re-run the decision engine?"
        confirmLabel="Re-run engine"
        effects={[
          { text: 'Writes a new canonical score and an immutable snapshot for this property.', kind: 'note' },
          { text: 'Sends nothing to the seller and moves no stage.', kind: 'keeps' },
          { text: reasons.length ? `Why now: ${reasons.join(' · ')}` : 'No input has changed since the last analysis; expect the same result.', kind: reasons.length ? 'note' : 'keeps' },
        ]}
        onConfirm={() => { setConfirm(false); engine.onRun() }}
      />
    </div>
  )
}
