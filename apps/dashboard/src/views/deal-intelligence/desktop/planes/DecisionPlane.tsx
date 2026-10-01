import { Icon } from '../../../../shared/icons'
import { cx, LCButton, LCCounter, LCTooltip } from '../../../../shared/lc'
import { ago, dateShort, usd } from '../di-format'
import type { ConfidenceModel, DecisionState, OfferFigures, OfferTrack, SpectrumModel, ThesisLine } from '../di-model'
import type { DiDecision, DiSelection } from '../di-types'
import { Figure, Meter, Tag } from '../di-ui'
import { OfferBand, Spectrum, SpectrumLegend } from './Spectrum'
import { ThesisPlane } from './ThesisMoney'

const TONE_UNDER: Record<string, 'ok' | 'attn' | 'flow' | 'neutral' | 'crit' | 'exec'> = { go: 'ok', hold: 'attn', alt: 'flow', wait: 'neutral', stop: 'crit', none: 'exec' }

export interface DecisionPlaneProps {
  d: DiDecision
  state: DecisionState
  figures: OfferFigures
  spectrum: SpectrumModel | null
  track: OfferTrack | null
  conf: ConfidenceModel | null
  thesis: ThesisLine[]
  selection: DiSelection | null
  onSelect: (s: DiSelection) => void
  now: number
  engine: { canRun: boolean; running: boolean; onRun: () => void }
}

/**
 * THE ACQUISITION DECISION — the dominant object. One financial thesis:
 * the verdict and whether the machine may act, the engine value, the
 * supported value, the engine and authorized offer, the seller's number,
 * equity and confidence — then every one of them on the spectrum.
 */
export function DecisionPlane({ d, state, figures: f, spectrum, track, conf, thesis, selection, onSelect, now, engine }: DecisionPlaneProps) {
  const v = d.valuation
  const marker = selection?.type === 'marker' ? selection.key : null
  const pick = (key: string) => onSelect({ type: 'marker', key })
  const actual = d.actuals
  const authorizedRange = state.authority.range
  const equityPct = d.economics.equityPercent
  return (
    <section className="dr-plane dr-hero is-d3" data-plane="decision" data-under={TONE_UNDER[state.tone]} data-tone={state.tone} aria-label="Acquisition decision">
      {d.subject.isCanary ? <div className="dr-canary"><Icon name="flag" size={12} /> Test property — not a real deal</div> : null}

      <div className="dr-hero__verdict">
        <div className="dr-verdict" data-tone={state.tone}>
          <span className="dr-verdict__dot" aria-hidden="true" />
          <span className="dr-verdict__tier">{state.label}</span>
        </div>
        <div className="dr-authority" data-kind={state.authority.kind}>
          <Icon name={state.authority.kind === 'may_present' ? 'check' : state.authority.kind === 'withheld' ? 'shield' : state.authority.kind === 'review' ? 'user' : 'clock'} size={13} />
          <span className="dr-authority__title">{state.authority.title}</span>
          {state.authority.kind === 'may_present' && authorizedRange ? <b className="lc-num">{usd(authorizedRange[0])} – {usd(authorizedRange[1])}</b> : null}
          {state.authority.detail ? <span className="dr-authority__detail">{state.authority.detail}</span> : null}
        </div>
        <div className="dr-hero__meta">
          {state.nextMove ? <span className="dr-next"><Icon name="arrow-up-right" size={11} />Next: {state.nextMove}</span> : null}
          {state.computedAt ? <LCTooltip content={`Last analyzed ${dateShort(state.computedAt, now)} · engine ${d.lineage.engineVersion ?? '—'}`}><span className="dr-hero__age">{ago(state.computedAt, now)}</span></LCTooltip> : null}
        </div>
      </div>

      {actual ? (
        <div className="dr-actuals" role="note">
          <Tag kind="actual" />
          <span>Closed {dateShort(actual.closedAt, now)}</span>
          <span>Contract <b className="lc-num">{usd(actual.contractPrice) ?? '—'}</b></span>
          <span>Buyer <b className="lc-num">{usd(actual.buyerPrice) ?? '—'}</b></span>
          <span>Fee <b className="lc-num">{usd(actual.assignmentFee) ?? '—'}</b></span>
          <em>{actual.evidence.join(' · ')}</em>
        </div>
      ) : null}

      {state.analyzed ? (
        <div className="dr-hero__numbers">
          <button type="button" className={cx('dr-engine', marker === 'engine' && 'is-selected')} onClick={() => pick('engine')} aria-label="Engine value — open its evidence">
            <span className="dr-engine__label">Engine value <Tag kind="modeled" /></span>
            <span className="dr-engine__value lc-num">{v?.mid ? <LCCounter value={v.mid} prefix="$" /> : '—'}</span>
            <span className="dr-engine__basis">weighted value of {d.comps?.selected ?? 0} qualified comp{d.comps?.selected === 1 ? '' : 's'}{v?.confidence !== null && v?.confidence !== undefined ? ` · valuation confidence ${Math.round(v.confidence)}` : ''}</span>
          </button>
          <div className="dr-hero__figures">
            <Figure label="Supported value" tag="supported" value={v?.low && v?.high ? `${usd(v.low)} – ${usd(v.high)}` : '—'} basis="engine evidence range" onClick={() => pick('supported')} selected={marker === 'supported'} />
            <Figure
              label="Engine offer"
              tag="modeled"
              value={f.engineFloor && f.engineRec ? `${usd(f.engineFloor)} – ${usd(f.engineRec)}` : f.engineRec ? usd(f.engineRec) : '—'}
              basis={authorizedRange ? <>authorized to <b className="lc-num">{usd(authorizedRange[1])}</b></> : 'a recommendation, not an offer'}
              tone="exec"
              onClick={() => pick('offer')}
              selected={marker === 'offer'}
            />
            <Figure
              label="Seller ask"
              tag={f.ask ? 'seller' : null}
              value={f.ask ? usd(f.ask) : <span className="dr-none">Not captured</span>}
              basis={f.ask && f.gapToRec !== null ? `${usd(Math.abs(f.gapToRec))} ${f.gapToRec > 0 ? 'above' : 'below'} engine offer` : f.ask ? 'seller said' : 'the seller has not named a price'}
              tone={f.ask ? 'attn' : null}
              onClick={() => pick('ask')}
              selected={marker === 'ask'}
            />
            <Figure label="Equity" tag="estimated" value={equityPct !== null ? `${Math.round(equityPct)}%` : '—'} basis={d.economics.equityEstimate !== null ? `${usd(d.economics.equityEstimate)} on record` : 'not on record'} onClick={() => onSelect({ type: 'money', key: 'equity' })} selected={selection?.type === 'money' && selection.key === 'equity'} />
            <button type="button" className={cx('dr-fig is-md is-link dr-conf-fig', selection?.type === 'confidence' && 'is-selected')} onClick={() => onSelect({ type: 'confidence', key: conf?.largest?.key ?? 'valuation' })}>
              <span className="dr-fig__label">Confidence</span>
              <span className="dr-fig__value lc-num">{conf?.overall ?? '—'}<small>/100</small></span>
              <Meter value={conf?.overall ?? null} threshold={85} label="Overall confidence" tone="exec" />
              <span className="dr-fig__basis">{conf?.largest ? <>largest gap: <b>{conf.largest.label.toLowerCase()}</b> (−{conf.largest.lost})</> : 'decomposition not recorded'}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="dr-hero__unanalyzed">
          <div>
            <b>The decision engine has never priced this property.</b>
            <p>There is no valuation, offer range or strategy yet.{v?.avm ? ` The only value on record is the ${usd(v.avm)} AVM (provider estimate).` : ''}</p>
          </div>
          {engine.canRun ? <LCButton variant="primary" icon="zap" loading={engine.running} onClick={engine.onRun}>Run decision engine</LCButton> : <span className="dr-none">A conversation is needed to run the engine from here.</span>}
        </div>
      )}

      {spectrum ? (
        <div className="dr-hero__spectrum">
          <div className="dr-hero__band-head">
            <span className="dr-eyebrow">Valuation spectrum</span>
            <SpectrumLegend model={spectrum} />
          </div>
          <Spectrum model={spectrum} selected={marker} onSelect={pick} />
        </div>
      ) : null}

      {track ? (
        <div className="dr-hero__offerband">
          <div className="dr-hero__band-head">
            <span className="dr-eyebrow">Offer band</span>
            <div className="dr-legend">
              <span><i className="k-zone-target" />Keeps target margin</span>
              <span><i className="k-zone-minimum" />Clears minimum</span>
              <span><i className="k-zone-below" />Below minimum</span>
              {track.authorized ? <span><i className="k-auth" />Authorized</span> : null}
            </div>
          </div>
          <OfferBand
            track={track}
            selected={marker}
            onSelect={pick}
            caption={f.maxForMinimum && f.authCeiling && f.authCeiling > f.maxForMinimum
              ? `The authorized ceiling (${usd(f.authCeiling)}) sits above ${usd(f.maxForMinimum)} — the highest price that still clears the ${usd(f.minMargin)} minimum margin.`
              : f.maxForTarget ? `At or below ${usd(f.maxForTarget)} the modeled spread keeps the ${usd(f.targetMargin)} target margin.` : undefined}
          />
        </div>
      ) : null}

      {thesis.length ? <ThesisPlane lines={thesis} dec={d.decision.status === 'available' ? d.decision : null} embedded /> : null}
    </section>
  )
}
