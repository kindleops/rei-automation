import { Icon } from '../../../../shared/icons'
import { cx, LCTooltip } from '../../../../shared/lc'
import type { ConfidenceModel, GateView } from '../di-model'
import type { DiSelection } from '../di-types'
import { Plane } from '../di-ui'

const DIM_TONE: Record<string, string> = { valuation: 'exec', subject: 'cobalt', buyer: 'flow', finance: 'ok' }

/**
 * CONFIDENCE, DECOMPOSED — the engine's own formula, each component's score,
 * what it contributes and what it costs. The largest loss is named; nothing
 * is a speedometer.
 */
export function ConfidencePlane({ model, selection, onSelect }: { model: ConfidenceModel | null; selection: DiSelection | null; onSelect: (s: DiSelection) => void }) {
  if (!model) {
    return (
      <Plane id="confidence" eyebrow="Evidence confidence" title="Not decomposed">
        <p className="dr-none">This analysis did not record a confidence breakdown.</p>
      </Plane>
    )
  }
  const total = model.rows.reduce((s, r) => s + (r.contribution ?? 0), 0)
  return (
    <Plane id="confidence" eyebrow="Evidence confidence" title={<><span className="dr-big lc-num">{model.overall ?? '—'}</span><small>/100 overall</small></>} headerLabel="Evidence confidence">
      <div className="dr-stack" role="img" aria-label={`Contributions: ${model.rows.map((r) => `${r.label} ${r.contribution ?? '—'}`).join(', ')}`}>
        {model.rows.map((r) => <i key={r.key} data-dim={DIM_TONE[r.key]} style={{ width: `${r.contribution ?? 0}%` }} />)}
        <i className="is-lost" style={{ width: `${Math.max(0, 100 - total)}%` }} />
      </div>
      <ol className="dr-confrows">
        {model.rows.map((r) => {
          const sel = selection?.type === 'confidence' && selection.key === r.key
          const largest = model.largest?.key === r.key
          return (
            <li key={r.key}>
              <button type="button" className={cx('dr-confrow', sel && 'is-selected', largest && 'is-largest')} onClick={() => onSelect({ type: 'confidence', key: r.key })} aria-pressed={sel}>
                <span className="dr-confrow__label">{r.label}<em>{Math.round(r.weight * 100)}%</em></span>
                <span className="dr-confrow__bar" aria-hidden="true"><i data-dim={DIM_TONE[r.key]} style={{ width: `${r.score ?? 0}%` }} /></span>
                <b className="lc-num">{r.score ?? '—'}</b>
                <span className="dr-confrow__math lc-num">+{r.contribution ?? '—'}{r.lost ? <em> −{r.lost}</em> : null}</span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="dr-conf__foot">
        {model.largest ? (
          <p><b>Largest uncertainty: {model.largest.label.toLowerCase()}</b> (−{model.largest.lost} pts){model.largest.notes.length ? ` — ${model.largest.notes.join(' · ')}` : model.largest.missing.length ? ` — missing ${model.largest.missing.join(', ').toLowerCase()}` : ''}.{model.secondary ? ` Then ${model.secondary.label.toLowerCase()} (−${model.secondary.lost}).` : ''}</p>
        ) : null}
        {model.capReason && model.cap !== null && model.cap < 100 ? <p className="dr-warn">Capped at {model.cap}: {model.capReason}.</p> : null}
        {model.formula ? <p className="dr-quiet">{model.formula}</p> : null}
      </div>
    </Plane>
  )
}

/**
 * HARD-OFFER GATES — a compact constraint rail. Each gate shows the value
 * the engine compared and its threshold; select one for its definition,
 * source and what could change it.
 */
export function GatePlane({ gates, tierLabel, selection, onSelect }: { gates: GateView[]; tierLabel: string | null; selection: DiSelection | null; onSelect: (s: DiSelection) => void }) {
  if (!gates.length) return null
  const passed = gates.filter((g) => g.pass).length
  const failed = gates.filter((g) => !g.pass)
  return (
    <Plane
      id="gates"
      eyebrow="Decision constraints"
      title={<><span className="dr-big lc-num">{passed}<small>/{gates.length}</small></span><small>hard-offer gates pass</small></>}
      headerLabel="Hard-offer gates"
      under={failed.length ? 'attn' : 'ok'}
    >
      <ol className="dr-gates">
        {gates.map((g) => {
          const sel = selection?.type === 'gate' && selection.key === g.key
          return (
            <li key={g.key}>
              <button type="button" className={cx('dr-gate', g.pass ? 'is-pass' : 'is-fail', sel && 'is-selected')} onClick={() => onSelect({ type: 'gate', key: g.key })} aria-pressed={sel}>
                <span className="dr-gate__mark" aria-hidden="true"><Icon name={g.pass ? 'check' : 'x'} size={11} /></span>
                <span className="dr-gate__label">{g.legacy ? g.label.replace(/\s*\(earlier rule\)/i, '') : g.label}{g.legacy ? <LCTooltip content="Recorded under an earlier engine rule (fee compared with the target margin)"><em className="dr-legacy">earlier rule</em></LCTooltip> : null}</span>
                <span className="dr-gate__value lc-num">{g.display}</span>
                {g.gapText ? <span className="dr-gate__gap">{g.gapText}</span> : null}
              </button>
            </li>
          )
        })}
      </ol>
      <p className="dr-quiet">
        {failed.length
          ? `All must pass for an automated hard offer. ${failed.length === 1 ? 'One gate stands' : `${failed.length} gates stand`} between this deal and one.${tierLabel ? ` Current decision: ${tierLabel.toLowerCase()}.` : ''}`
          : 'All gates pass — the engine may make a hard offer.'}
      </p>
    </Plane>
  )
}
