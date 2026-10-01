import { useMemo, useState } from 'react'
import type { ScenarioInputs } from '../../../../domain/deal-intelligence/deal-decision-api'
import { Icon } from '../../../../shared/icons'
import { cx, LCButton, LCSegmented, LCTooltip } from '../../../../shared/lc'
import { usd } from '../di-format'
import {
  offerFigures, offerTrack, presetInputs, priceSteps, scenarioOutcome, SCENARIO_PRESETS, sensitivityGrid,
  type OfferFigures, type PresetKey, type ScenarioOutcome,
} from '../di-model'
import type { DiDecision } from '../di-types'
import { Empty, Plane, Tag } from '../di-ui'
import { OfferBand } from '../planes/Spectrum'

type LeverKey = 'valuation_mid' | 'repairs' | 'minimum_margin_floor' | 'valuation_confidence'

/**
 * SCENARIO LAB — the engine's own offer arithmetic (computeScenarioOffer,
 * pinned to production vectors) re-run on different assumptions. Exploratory:
 * nothing is saved, sent, or allowed to replace the current decision; every
 * surface here says SCENARIO. Presets are the engine's recorded sensitivity
 * probes, applied together. Holding, closing and financing costs are not in
 * the engine and are not invented here.
 */
export function ScenarioMode({ d }: { d: DiDecision }) {
  const base = d.scenario?.inputs ?? null
  if (!base) {
    return (
      <div className="dr-mode dr-scenario">
        <Empty icon="brain" title="No replayable analysis" body={d.decision.status === 'available' ? 'This analysis did not record the inputs of its offer calculation, so it cannot be replayed.' : 'Run the decision engine first — there is no baseline to model from.'} />
      </div>
    )
  }
  return <ScenarioLab d={d} base={base} key={d.lineage.computedAt ?? d.subject.propertyId} />
}

function ScenarioLab({ d, base }: { d: DiDecision; base: ScenarioInputs }) {
  const [preset, setPreset] = useState<PresetKey>('base')
  const [custom, setCustom] = useState<ScenarioInputs>(base)
  const [price, setPrice] = useState<number | null>(null)
  const inputs = preset === 'custom' ? custom : presetInputs(base, preset)
  const sys = useMemo(() => scenarioOutcome(base), [base])
  const scen = scenarioOutcome(inputs, price)
  const ask = d.offer?.negotiation.ask ?? null
  const changed = preset !== 'base' || price !== null

  const lever = (key: LeverKey, v: number) => {
    const from = preset === 'custom' ? custom : presetInputs(base, preset)
    setCustom({ ...from, [key]: v })
    setPreset('custom')
  }
  const reset = () => { setPreset('base'); setCustom(base); setPrice(null) }

  const levers: Array<{ key: LeverKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string; hint: string }> = [
    { key: 'valuation_mid', label: 'Value (ARV)', min: Math.round((base.valuation_mid * 0.6) / 1000) * 1000, max: Math.round((base.valuation_mid * 1.4) / 1000) * 1000, step: 1000, fmt: (v) => usd(v, { exact: true }) ?? '', hint: 'The engine value the offer is built from' },
    { key: 'repairs', label: 'Repairs', min: 0, max: Math.max(50000, Math.round((base.repairs * 2.5) / 1000) * 1000), step: 500, fmt: (v) => usd(v, { exact: true }) ?? '', hint: 'Deducted from value × buyer factor' },
    { key: 'minimum_margin_floor', label: 'Minimum margin', min: 5000, max: 60000, step: 500, fmt: (v) => usd(v, { exact: true }) ?? '', hint: 'The protected margin / fee-gate floor' },
    { key: 'valuation_confidence', label: 'Valuation confidence', min: 0, max: 100, step: 1, fmt: (v) => `${Math.round(v)}`, hint: 'Drives the confidence haircut; 80 is the hard-offer gate' },
  ]
  const priceMin = Math.round((Math.min(sys.result.minimum_offer, scen.result.minimum_offer) * 0.8) / 1000) * 1000
  const priceMax = Math.round(((Math.max(sys.result.effective_ceiling ?? 0, scen.result.effective_ceiling ?? 0) || sys.result.recommended_offer * 1.3) * 1.08) / 1000) * 1000

  // the scenario's own band, with the operator's price as a pin
  const fScen: OfferFigures = {
    ...offerFigures(d),
    engineFloor: scen.result.minimum_offer || null,
    engineRec: scen.result.recommended_offer || null,
    buyerCeiling: scen.result.effective_ceiling,
    valuationCeiling: scen.result.valuation_ceiling,
    authFloor: null,
    authCeiling: null,
    minMargin: scen.result.protected_margin,
    targetMargin: scen.result.target_margin,
    maxForTarget: scen.maxForTarget,
    maxForMinimum: scen.maxForMinimum,
    modeledFee: scen.result.expected_fee,
    currentOffer: null,
    binding: false,
    counter: null,
  }
  const track = offerTrack(fScen, null, price !== null ? [{ key: 'price', label: 'Your price', value: price, cls: 'scenario' }] : [])

  const columns: Array<{ key: string; label: string; o: ScenarioOutcome; def: string }> = [
    { key: 'system', label: 'System', o: sys, def: 'Current decision' },
    ...SCENARIO_PRESETS.filter((p) => p.key !== 'base').map((p) => ({ key: p.key, label: p.label, o: scenarioOutcome(presetInputs(base, p.key)), def: p.definition })),
    ...(preset === 'custom' ? [{ key: 'custom', label: 'Custom', o: scenarioOutcome(custom), def: 'Your assumptions' }] : []),
  ]

  const prices = priceSteps(Math.min(sys.result.minimum_offer || sys.result.recommended_offer, scen.result.minimum_offer || scen.result.recommended_offer) || base.valuation_mid * 0.4, Math.max(sys.result.effective_ceiling ?? 0, scen.result.effective_ceiling ?? 0) || base.valuation_mid * 0.7, 8)
  const repairRows = [-20000, -10000, 0, 10000, 20000, 30000].map((dv) => inputs.repairs + dv).filter((r) => r >= 0)
  const grid = sensitivityGrid(inputs, prices, repairRows)
  const nearestPrice = prices.reduce((best, p) => (Math.abs(p - scen.price) < Math.abs(best - scen.price) ? p : best), prices[0])
  const probes = d.scenario?.sensitivity ?? []
  const probeMax = Math.max(1, ...probes.map((p) => Math.abs(p.delta)))
  const supported = d.valuation
  const valueVsBand = supported?.low && supported?.high
    ? inputs.valuation_mid < supported.low ? 'below the supported value range' : inputs.valuation_mid > supported.high ? 'above the supported value range' : 'inside the supported value range'
    : null

  return (
    <div className="dr-mode dr-scenario">
      <div className="dr-scenario__banner" role="note">
        <Icon name="shield" size={14} />
        <b>Scenario</b>
        <span>Exploratory — not saved, not sent. The current decision is unchanged.</span>
        {!d.scenario?.replayable && d.scenario?.reason === 'replay_differs_from_stored' ? <em>The stored offer ({usd(d.offer?.recommended)}) came from earlier engine arithmetic; this baseline is today’s policy on the same inputs ({usd(sys.result.recommended_offer)}).</em> : null}
        <LCButton size="sm" variant="quiet" icon="refresh-cw" onClick={reset} disabled={!changed}>Reset to system</LCButton>
      </div>

      <div className="dr-scenario__grid">
        <Plane id="assumptions" eyebrow="Assumptions" title={preset === 'custom' ? 'Custom' : SCENARIO_PRESETS.find((p) => p.key === preset)?.label ?? 'Base'} under="flow">
          <LCSegmented
            label="Scenario preset"
            value={preset}
            onChange={(v) => {
              if (v === 'custom') setCustom(inputs)
              setPreset(v)
            }}
            options={[...SCENARIO_PRESETS.map((p) => ({ value: p.key as PresetKey, label: p.label })), { value: 'custom' as PresetKey, label: 'Custom' }]}
            className="dr-presets"
          />
          <p className="dr-quiet">{preset === 'custom' ? 'Your assumptions — move any lever.' : SCENARIO_PRESETS.find((p) => p.key === preset)?.definition}{preset === 'conservative' || preset === 'upside' ? ' (the engine’s recorded sensitivity probes, applied together).' : ''}</p>
          <div className="dr-levers">
            {levers.map((l) => {
              const v = inputs[l.key] as number
              const moved = Math.abs(v - (base[l.key] as number)) > 0.5
              return (
                <label key={l.key} className={cx('dr-lever', moved && 'is-moved')}>
                  <span className="dr-lever__head"><span>{l.label}</span><b className="lc-num">{l.fmt(v)}</b>{moved ? <em>system {l.fmt(base[l.key] as number)}</em> : null}</span>
                  <input type="range" className="dr-range" min={l.min} max={l.max} step={l.step} value={Math.round(v)} onChange={(e) => lever(l.key, Number(e.target.value))} style={{ ['--p' as string]: `${((v - l.min) / (l.max - l.min || 1)) * 100}%` }} aria-describedby={`hint-${l.key}`} />
                  <span className="dr-lever__hint" id={`hint-${l.key}`}>{l.hint}</span>
                </label>
              )
            })}
            <label className={cx('dr-lever is-price', price !== null && 'is-moved')}>
              <span className="dr-lever__head"><span>Purchase price</span><b className="lc-num">{usd(scen.price, { exact: true })}</b>{price !== null ? <em>engine {usd(scen.result.recommended_offer, { exact: true })}</em> : <em>= engine offer</em>}</span>
              <input type="range" className="dr-range" min={priceMin} max={priceMax} step={500} value={Math.round(scen.price)} onChange={(e) => setPrice(Number(e.target.value))} style={{ ['--p' as string]: `${((scen.price - priceMin) / (priceMax - priceMin || 1)) * 100}%` }} />
              <span className="dr-lever__hint">What if we pay a different price? Spread = buyer ceiling − price.</span>
            </label>
          </div>
          <p className="dr-quiet">Not in the engine, so not modeled here: holding, closing and financing costs.</p>
        </Plane>

        <Plane id="outcome" eyebrow="Scenario outcome" title={<>Engine offer <span className="lc-num">{usd(scen.result.recommended_offer)}</span><Tag kind="scenario" /></>} headerLabel="Scenario outcome" under={scen.zone === 'below' ? 'crit' : scen.zone === 'minimum' ? 'attn' : 'ok'}>
          <div className="dr-outcome">
            <div className={cx('dr-outcome__spread', `is-${scen.zone}`)}>
              <span>At {usd(scen.price)} the modeled spread is</span>
              <b className="lc-num">{usd(scen.spread)}</b>
              <em>{scen.zone === 'target' ? `keeps the ${usd(scen.result.target_margin)} target` : scen.zone === 'minimum' ? `clears the ${usd(scen.result.protected_margin)} minimum, below target` : `below the ${usd(scen.result.protected_margin)} minimum — the deal stops working here`}</em>
            </div>
            <dl className="dr-kv is-2">
              <div><dt>Buyer ceiling</dt><dd className="lc-num">{usd(scen.result.effective_ceiling)} <Delta a={sys.result.effective_ceiling} b={scen.result.effective_ceiling} /></dd></div>
              <div><dt>Engine range</dt><dd className="lc-num">{usd(scen.result.minimum_offer)} – {usd(scen.result.recommended_offer)} <Delta a={sys.result.recommended_offer} b={scen.result.recommended_offer} /></dd></div>
              <div><dt>Modeled fee at engine offer</dt><dd className="lc-num">{usd(scen.result.expected_fee)} <Delta a={sys.result.expected_fee} b={scen.result.expected_fee} /></dd></div>
              <div><dt>Max price · target margin</dt><dd className="lc-num">{usd(scen.maxForTarget)}</dd></div>
              <div><dt>Break-even · minimum margin</dt><dd className="lc-num">{usd(scen.maxForMinimum)}</dd></div>
              <div><dt>Margin policy</dt><dd className="lc-num">{Math.round(scen.result.margin_pct * 100)}% · target {usd(scen.result.target_margin)}</dd></div>
              <div><dt>Fee gate</dt><dd className={scen.feeGate ? 'is-ok' : 'is-crit'}>{scen.feeGate ? 'Clears minimum' : 'Fails minimum'}</dd></div>
              <div><dt>Valuation gate</dt><dd className={scen.valuationGate ? 'is-ok' : 'is-attn'}>{scen.valuationGate ? '≥ 80 — passes' : `${Math.round(inputs.valuation_confidence)} < 80`}</dd></div>
              {ask ? <div><dt>Gap to the {usd(ask)} ask</dt><dd className="lc-num">{usd(ask - scen.price)}</dd></div> : null}
              {valueVsBand ? <div><dt>Value vs evidence</dt><dd>{valueVsBand}</dd></div> : null}
            </dl>
            {track ? <OfferBand track={track} selected={null} onSelect={() => {}} caption="Scenario band — the engine arithmetic on these assumptions; the authorized range is the negotiation’s and is not re-evaluated here." /> : null}
            <p className="dr-quiet">Terms on these inputs: −{scen.result.terms.confidence_haircut_pct}% confidence haircut · −{scen.result.terms.motivation_discount_pct}% motivation · +{scen.result.terms.demand_premium_pct}% demand. The decision tier is not re-evaluated in a scenario.</p>
          </div>
        </Plane>

        <Plane id="compare" eyebrow="Comparison" title="System vs scenarios" depth={1}>
          <table className="dr-table dr-compare">
            <thead><tr><th />{columns.map((c) => <th key={c.key} className={cx(c.key === 'system' && 'is-system', c.key === preset && 'is-active')}><LCTooltip content={c.def}><span>{c.label}</span></LCTooltip></th>)}</tr></thead>
            <tbody>
              <Row label="Value" cells={columns.map((c) => usd(c.o.inputs.valuation_mid))} />
              <Row label="Repairs" cells={columns.map((c) => usd(c.o.inputs.repairs))} />
              <Row label="Valuation conf." cells={columns.map((c) => String(Math.round(c.o.inputs.valuation_confidence)))} />
              <Row label="Buyer ceiling" cells={columns.map((c) => usd(c.o.result.effective_ceiling))} />
              <Row label="Engine offer" strong cells={columns.map((c) => usd(c.o.result.recommended_offer))} />
              <Row label="Floor" cells={columns.map((c) => usd(c.o.result.minimum_offer))} />
              <Row label="Modeled fee" cells={columns.map((c) => usd(c.o.result.expected_fee))} />
              <Row label="Target margin" cells={columns.map((c) => usd(c.o.result.target_margin))} />
              <Row label="Fee gate" cells={columns.map((c) => (c.o.feeGate ? 'Clears' : 'Fails'))} tones={columns.map((c) => (c.o.feeGate ? 'ok' : 'crit'))} />
              {ask ? <Row label="Gap to ask" cells={columns.map((c) => usd(ask - c.o.result.recommended_offer))} /> : null}
            </tbody>
          </table>
        </Plane>
      </div>

      <Plane id="sensitivity" eyebrow="Sensitivity" title="Purchase price × repairs → modeled spread" under="exec"
        aside={<div className="dr-legend"><span><i className="k-zone-target" />Keeps target</span><span><i className="k-zone-minimum" />Clears minimum</span><span><i className="k-zone-below" />Below minimum</span></div>}>
        <div className="dr-matrix-wrap">
          <table className="dr-matrix">
            <thead>
              <tr><th className="dr-matrix__corner">Repairs ↓ · Price →</th>{prices.map((p) => <th key={p} className={cx(p === nearestPrice && 'is-mark')}>{usd(p)}</th>)}</tr>
            </thead>
            <tbody>
              {grid.map((row, ri) => (
                <tr key={repairRows[ri]}>
                  <th className={cx(repairRows[ri] === inputs.repairs && 'is-mark')}>{usd(repairRows[ri])}{repairRows[ri] === inputs.repairs ? <em> scenario</em> : null}</th>
                  {row.map((cell) => (
                    <td key={cell.price} data-zone={cell.zone} className={cx(cell.price === nearestPrice && cell.repairs === inputs.repairs && 'is-here')}>
                      <LCTooltip content={`Pay ${usd(cell.price, { exact: true })} with ${usd(cell.repairs)} repairs: ceiling ${usd(cell.ceiling)} − price = ${usd(cell.spread, { exact: true })}`}>
                        <span className="lc-num">{usd(cell.spread)}</span>
                      </LCTooltip>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {probes.length ? (
          <div className="dr-probes">
            <span className="dr-eyebrow">Engine sensitivity · offer change, one input at a time (recorded probes)</span>
            <ul>
              {probes.map((p) => (
                <li key={p.key}>
                  <span>{p.label}</span>
                  <span className="dr-probes__track" aria-hidden="true"><i className={p.delta >= 0 ? 'is-up' : 'is-down'} style={{ width: `${(Math.abs(p.delta) / probeMax) * 50}%` }} /></span>
                  <b className={cx('lc-num', p.delta > 0 && 'is-up', p.delta < 0 && 'is-down')}>{p.delta ? usd(p.delta, { signed: true }) : '±$0'}</b>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Plane>
    </div>
  )
}

function Delta({ a, b }: { a: number | null; b: number | null }) {
  if (a === null || b === null) return null
  const dv = b - a
  if (Math.abs(dv) < 50) return null
  return <em className={cx('dr-delta', dv > 0 ? 'is-up' : 'is-down')}>{usd(dv, { signed: true })}</em>
}

function Row({ label, cells, strong, tones }: { label: string; cells: Array<string | null>; strong?: boolean; tones?: Array<'ok' | 'crit' | null> }) {
  return (
    <tr className={cx(strong && 'is-key')}>
      <th>{label}</th>
      {cells.map((c, i) => <td key={i} className="lc-num" data-tone={tones?.[i] || undefined}>{c ?? '—'}</td>)}
    </tr>
  )
}
