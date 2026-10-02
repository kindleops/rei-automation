import { LCStatus, cx } from '../../../shared/lc'
import { leaveOneOut, replayInputFor, replayValuation, type ReplayInput, type ReplayResult } from '../../../domain/comp-intelligence/comps-valuation-replay'
import { fmtMoment, fmtMoney, fmtPct } from '../../../domain/comp-intelligence/comps-workstation-model'
import type { Workstation } from './derive-workstation'
import type { FocusStore } from './focus-store'
import { DeviationRows } from './charts/DeviationRows'
import { COMPONENT_LABEL } from './valuation-sources'

const METHOD_WORDS: Record<string, string> = {
  weighted_adjusted_comp_value: 'Weighted adjusted comp value',
  subject_value_fallback: 'Record-estimate fallback (no comp qualified)',
  no_valuation_inputs: 'No valuation inputs',
}

const STEP_REASON: Array<{ code: string; label: string }> = [
  { code: 'comp_score_below_30', label: 'comparability score under 30' },
  { code: 'missing_adjusted_price', label: 'could not be adjusted to the subject' },
  { code: 'adjusted_price_outlier', label: 'adjusted price outside the MAD outlier band' },
  { code: 'asset_family_invariant', label: 'failed the asset-family invariant' },
  { code: 'outside_top_comp_limit', label: 'eligible, beyond the top 12 by weight' },
]

export function ModelMode({ m, store }: { m: Workstation; store: FocusStore }) {
  const run = m.run
  const rules = m.rules
  const sys = m.systemReplay.result
  const op = m.operatorReplay?.result ?? null
  const lensInputs = m.lensComps.map(replayInputFor).filter((x): x is ReplayInput => x !== null)
  const loo = lensInputs.length >= 2 ? leaveOneOut(lensInputs) : []
  const maxAbs = loo.reduce((a, r) => Math.max(a, Math.abs(r.deltaMid ?? 0)), 0)
  const todayInputs = m.lensComps.length && m.lens === 'system'
    ? m.lensComps.map((c): ReplayInput | null => (c.today?.eligible && c.today.weight && c.today.adjustedPrice && c.today.score !== null && c.today.score !== undefined && c.today.completeness !== null && c.today.completeness !== undefined
      ? { key: c.key, weight: c.today.weight, adjustedPrice: c.today.adjustedPrice, score: c.today.score, completeness: c.today.completeness, saleSource: c.engine?.saleSource ?? null }
      : null))
    : []
  const today = todayInputs.length && todayInputs.every(Boolean) && (m.drift.aged || m.drift.rejected) ? replayValuation(todayInputs as ReplayInput[]) : null
  const breakdown = run?.pool.rejectionBreakdown ?? {}
  const missing = missingSubjectFields(m)

  return (
    <div className="ciw-model">
      <section className="ciw-block">
        <header className="ciw-block__head">
          <span className="ciw-block__title">Engine run</span>
          <span className="ciw-block__aside">
            {m.parity.state === 'exact' ? <LCStatus tone="ok" label="Replay reproduces it exactly" quiet /> : m.parity.state === 'differs' ? <LCStatus tone="attn" label="Replay differs" /> : <LCStatus tone="neutral" label={m.parity.reason === 'fallback_valuation' ? 'Fallback — nothing to replay' : m.parity.reason === 'no_stored_valuation' ? 'No stored run' : 'Nothing to replay'} quiet />}
          </span>
        </header>
        {run ? (
          <dl className="ciw-kv lc-num">
            <div><dt>Engine</dt><dd>Acquisition decision engine {run.version ?? ''}</dd></div>
            <div><dt>Computed</dt><dd>{fmtMoment(run.computedAt) ?? 'not recorded'}{runAge(run.computedAt, m.now)}</dd></div>
            <div><dt>Method</dt><dd>{METHOD_WORDS[run.method ?? ''] ?? run.method ?? '—'}</dd></div>
            {run.formula ? <div><dt>Formula</dt><dd className="ciw-mono">{run.formula}</dd></div> : null}
            <div><dt>Priced from</dt><dd>{run.selectedCount ?? m.systemKeys.size} comps · total weight {run.totalWeight?.toFixed(4) ?? '—'} · dispersion {run.dispersion !== null ? fmtPct(run.dispersion, 1) : '—'}</dd></div>
            <div><dt>Sale sources</dt><dd>{run.sourceTypes.length ? run.sourceTypes.map((s) => s.replace(/_/g, ' ')).join(' + ') : '—'}</dd></div>
          </dl>
        ) : <p className="ciw-muted">The acquisition engine has not valued this subject — there is no stored run to explain.</p>}
        {m.parity.state === 'exact' ? <p className="ciw-muted">Comp Intelligence replays the engine’s valuation formula in your browser to price operator sets. Replayed over the stored system set it returns exactly the stored range and confidence, so every operator delta is the operator’s change alone.</p> : null}
        {m.parity.state === 'differs' ? <p className="ciw-muted">Replaying the stored set does not reproduce the stored valuation ({m.parity.fields.map((f) => `${f.field} ${f.field === 'confidence' ? f.stored : fmtMoney(f.stored)} vs ${f.field === 'confidence' ? f.replay : fmtMoney(f.replay)}`).join('; ')}). Operator deltas are measured against the replay, not the stored figure.</p> : null}
      </section>

      {run && (run.pool.rawCandidates !== null || Object.keys(breakdown).length) ? (
        <section className="ciw-block">
          <header className="ciw-block__head"><span className="ciw-block__title">How the engine chose its set</span><span className="ciw-block__aside">stored run</span></header>
          <ol className="ciw-funnel lc-num">
            {run.pool.rawCandidates !== null ? <FunnelStep n={run.pool.rawCandidates} max={run.pool.rawCandidates} label={`sales in the engine’s pool${rules ? ` (≤ ${rules.radiusMiles} mi, sold ≤ ${rules.months} mo, top ${rules.pool.limit})` : ''}`} /> : null}
            {run.pool.eligibleCandidates !== null && run.pool.rawCandidates !== null ? <FunnelStep n={run.pool.eligibleCandidates} max={run.pool.rawCandidates} label="passed eligibility (asset class, price, distance, age, size)" /> : null}
            {STEP_REASON.filter((r) => breakdown[r.code]).map((r) => <FunnelStep key={r.code} n={-(breakdown[r.code] ?? 0)} max={run.pool.rawCandidates ?? 1} label={r.label} out />)}
            <FunnelStep n={run.selectedCount ?? m.systemKeys.size} max={run.pool.rawCandidates ?? Math.max(1, m.systemKeys.size)} label="priced — the system set" strong />
          </ol>
        </section>
      ) : null}

      {rules ? (
        <section className="ciw-block">
          <header className="ciw-block__head"><span className="ciw-block__title">Selection rules · {m.w.subject.familyLabel ?? rules.family}</span></header>
          <ul className="ciw-rules">
            <li>Same asset class — the engine never prices across families</li>
            <li>Within <b>{rules.radiusMiles} mi</b>, sold within <b>{rules.months} months</b></li>
            {rules.size ? <li>{rules.size.label} between <b>×{rules.size.min}</b> and <b>×{rules.size.max}</b> the subject’s</li> : null}
            <li>Sale price ≥ <b>{fmtMoney(rules.minSalePrice)}</b> and ≥ <b>{Math.round(rules.nominalPriceToValue * 100)}%</b> of the recorded value (no nominal transfers); package sales rejected</li>
            <li>Comparability score ≥ <b>{rules.minCompScore}</b>; adjusted prices outside median ± max(<b>{rules.outlier.madMultiple}× MAD</b>, <b>{Math.round(rules.outlier.floorShareOfMedian * 100)}%</b> of median) are outliers (needs ≥ {rules.outlier.minObservations} comps)</li>
            <li>Top <b>{rules.maxSelected}</b> by weight = comparability × comp confidence × recency × source (MLS ×{rules.weight.mlsFactor}, other ×{rules.weight.otherFactor})</li>
            <li>Recency, by elapsed days with no month steps: {rules.recency.map((k) => `${k.months} mo ${k.score}%`).join(' → ')}, straight between, flat before and after</li>
          </ul>
        </section>
      ) : null}

      {sys || op ? (
        <section className="ciw-block">
          <header className="ciw-block__head"><span className="ciw-block__title">Why confidence is {(m.lens === 'operator' && op ? op : sys)?.confidence ?? '—'}</span><span className="ciw-block__aside">{rules?.confidence.formula}</span></header>
          <div className="ciw-confbars" role="table" aria-label="Valuation confidence components">
            {(Object.keys(COMPONENT_LABEL) as Array<keyof ReplayResult['components']>).map((k) => (
              <div key={k} role="row" className="ciw-confbar">
                <span role="cell" className="ciw-confbar__label">{COMPONENT_LABEL[k].label}<em>{Math.round(COMPONENT_LABEL[k].weight * 100)}%</em></span>
                <span role="cell" className="ciw-confbar__track">
                  {sys ? <i className="is-system" style={{ width: `${Math.min(100, sys.components[k])}%` }} title={`System ${sys.components[k].toFixed(1)}`} /> : null}
                  {op ? <i className="is-operator" style={{ width: `${Math.min(100, op.components[k])}%` }} title={`Your set ${op.components[k].toFixed(1)}`} /> : null}
                </span>
                <span role="cell" className="ciw-confbar__value lc-num">{sys ? sys.components[k].toFixed(1) : '—'}{op ? <em> → {op.components[k].toFixed(1)}</em> : null}</span>
              </div>
            ))}
          </div>
          <p className="ciw-muted">{COMPONENT_LABEL.depth.hint} · comparability and completeness are weighted by engine weight · {COMPONENT_LABEL.consistency.hint} · {COMPONENT_LABEL.sourceDiversity.hint}.</p>
        </section>
      ) : null}

      {loo.length ? (
        <section className="ciw-block">
          <header className="ciw-block__head"><span className="ciw-block__title">Leave-one-out sensitivity</span><span className="ciw-block__aside">central value without each comp · same formula, no backfill</span></header>
          <DeviationRows
            store={store}
            ariaLabel="Change in the central value when each comp is removed"
            rows={loo.map((r) => {
              const c = m.byKey.get(r.key)
              return {
                key: r.key,
                label: c?.address?.split(',')[0] ?? 'Comp',
                value: r.deltaMid,
                text: r.deltaMid !== null ? `${r.deltaMid > 0 ? '+' : r.deltaMid < 0 ? '−' : '±'}${fmtMoney(Math.abs(r.deltaMid))}` : null,
                note: r.deltaMidPct !== null ? ` ${fmtPct(r.deltaMidPct, 1, true)}` : null,
                emphasis: maxAbs > 0 && Math.abs(r.deltaMid ?? 0) === maxAbs,
              }
            })}
          />
          <p className="ciw-muted">{loo.length} comps. The largest single dependency moves the central value by {fmtMoney(maxAbs)}{sys?.mid ? ` (${fmtPct(maxAbs / sys.mid, 1)})` : ''}. The engine itself would refill a removed slot from its pool; this measures how much the current set leans on each sale.</p>
        </section>
      ) : null}

      {m.drift.aged || m.drift.rejected ? (
        <section className="ciw-block">
          <header className="ciw-block__head"><span className="ciw-block__title">Since the engine ran</span></header>
          <p className="ciw-muted lc-num">
            {m.drift.aged ? `${m.drift.aged} of the system comps have aged since the engine ran, so today’s rules weigh them less. ` : ''}
            {m.drift.rejected ? `${m.drift.rejected} would now be rejected by the engine’s rules. ` : ''}
            {today && sys ? `The same set with today’s weights: central ${fmtMoney(today.mid)} (${fmtPct((today.mid - sys.mid) / sys.mid, 1, true)}), confidence ${today.confidence}. The stored valuation stays canonical until the engine re-runs.` : ''}
          </p>
        </section>
      ) : null}

      <section className="ciw-block">
        <header className="ciw-block__head"><span className="ciw-block__title">Known caveats</span></header>
        <ul className="ciw-rules is-caveats">
          {missing.length ? <li>Subject fields not recorded: <b>{missing.join(', ')}</b> — the engine cannot compare what the subject record lacks, which lowers completeness.</li> : null}
          <li>Recorded deeds are judged with the engine’s rules for review, but the engine prices only from its own pool of sold comps.</li>
          <li>Comps from the engine’s set keep the weights it priced with; comps you add are scored by its rules today.</li>
          <li>Recency falls a little each day, so today’s weights drift slightly from the stored ones between engine runs.</li>
          <li>No listing feed: active and pending supply are not part of this evidence.</li>
        </ul>
      </section>
    </div>
  )
}

function runAge(at: string | null, now: number): string {
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t) || !now) return ''
  const hours = Math.max(0, (now - t) / 3_600_000)
  if (hours < 1) return ' · under an hour before this read'
  if (hours < 48) return ` · ${Math.round(hours)} h before this read`
  return ` · ${Math.floor(hours / 24)} days before this read`
}

function FunnelStep({ n, max, label, out, strong }: { n: number; max: number; label: string; out?: boolean; strong?: boolean }) {
  const pct = Math.max(2, Math.min(100, (Math.abs(n) / Math.max(1, max)) * 100))
  return (
    <li className={cx('ciw-funnel__step', out && 'is-out', strong && 'is-strong')}>
      <b>{out ? `−${Math.abs(n)}` : n}</b>
      <span className="ciw-funnel__bar"><i style={{ width: `${pct}%` }} /></span>
      <span className="ciw-funnel__label">{label}</span>
    </li>
  )
}

function missingSubjectFields(m: Workstation): string[] {
  const s = m.w.subject
  const out: string[] = []
  if (m.kind === 'sfr' || m.kind === 'other') {
    if (s.beds === null) out.push('bedrooms')
    if (s.baths === null) out.push('bathrooms')
  }
  if (m.kind === 'multifamily' && !s.units) out.push('unit count')
  if (m.kind !== 'land' && !s.sqft) out.push('building sq ft')
  if (!s.yearBuilt && m.kind !== 'land') out.push('year built')
  if (!s.lotSqft) out.push('lot size')
  if (!s.condition) out.push('condition')
  if (s.lat === null || s.lng === null) out.push('coordinates')
  return out
}
