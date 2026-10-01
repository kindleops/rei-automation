import { cx, LCTooltip } from '../../../../shared/lc'
import { usd } from '../di-format'
import { layoutLanes, type OfferTrack as OfferTrackModel, type SpectrumModel } from '../di-model'
import { useWidth } from '../useWidth'

const pctOf = (at: number) => `${Math.round(at * 10000) / 100}%`
/** Lanes 0/2 sit above the track, 1/3 below; the outer rows are 2/3. */
const sideOf = (lane: number) => (lane % 2 === 0 ? 'up' : 'down')
const rowOf = (lane: number) => (lane >= 2 ? 1 : 0)

/**
 * THE VALUATION SPECTRUM — every priced thing on one axis.
 *   comp range (adjusted min–max) · supported value (engine low–high) ·
 *   each qualified comp as a dot sized by its engine weight · the engine
 *   offer band · the authorized band · AVM · seller ask · buyer ceiling.
 * Every element is a control: hover for the exact figure and its basis,
 * select to open its evidence in the inspector.
 */
export function Spectrum({ model, selected, onSelect, compact }: { model: SpectrumModel; selected: string | null; onSelect: (key: string) => void; compact?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const lanes = layoutLanes(model.markers, width || 900, compact ? 92 : 108)
  const up = lanes.some((l) => l === 2) ? 2 : 1
  const down = lanes.some((l) => l === 3) ? 2 : lanes.some((l) => l === 1) ? 1 : 0
  return (
    <div className={cx('dr-spec', compact && 'is-compact')} ref={ref} style={{ ['--up' as string]: up, ['--down' as string]: down }}>
      <div className="dr-spec__stage">
        <div className="dr-spec__track">
          {model.ticks.map((t) => <span key={t.v} className="dr-spec__grid" style={{ left: pctOf(t.at) }} aria-hidden="true" />)}
          <span className="dr-spec__axis" aria-hidden="true" />
          {model.compRange ? (
            <LCTooltip content={`Comp range ${usd(model.compRange.low)} – ${usd(model.compRange.high)} · adjusted min–max of qualified comps${model.compRange.clamped ? ' (extends past this scale)' : ''}`}>
              <button type="button" className={cx('dr-spec__comprange', selected === 'comps' && 'is-selected')} style={{ left: pctOf(model.compRange.from), width: pctOf(model.compRange.to - model.compRange.from) }} onClick={() => onSelect('comps')} aria-label="Comp range" />
            </LCTooltip>
          ) : null}
          {model.supported ? (
            <LCTooltip content={`Supported value ${usd(model.supported.low)} – ${usd(model.supported.high)} · the engine’s evidence range`}>
              <button type="button" className={cx('dr-spec__supported', selected === 'supported' && 'is-selected')} style={{ left: pctOf(model.supported.from), width: pctOf(model.supported.to - model.supported.from) }} onClick={() => onSelect('supported')} aria-label="Supported value range" />
            </LCTooltip>
          ) : null}
          {model.authorized ? (
            <LCTooltip content={`Authorized ${usd(model.authorized.floor)} – ${usd(model.authorized.ceiling)} · negotiation authority`}>
              <button type="button" className={cx('dr-spec__auth', selected === 'authorized' && 'is-selected')} style={{ left: pctOf(model.authorized.from), width: `max(4px, ${pctOf(model.authorized.to - model.authorized.from)})` }} onClick={() => onSelect('authorized')} aria-label="Authorized offer range" />
            </LCTooltip>
          ) : null}
          {model.offer ? (
            <LCTooltip content={`Engine offer ${usd(model.offer.floor)} – ${usd(model.offer.rec)} · floor to recommended`}>
              <button type="button" className={cx('dr-spec__offer', selected === 'offer' && 'is-selected')} style={{ left: pctOf(model.offer.from), width: `max(5px, ${pctOf(model.offer.to - model.offer.from)})` }} onClick={() => onSelect('offer')} aria-label="Engine offer range" />
            </LCTooltip>
          ) : null}
          {model.comps.map((c) => (
            <span key={c.id} className={cx('dr-spec__dot', c.clamped && 'is-clamped')} style={{ left: pctOf(c.at), ['--w' as string]: Math.max(0.15, Math.min(1, c.weight)) }} aria-hidden="true" />
          ))}
          {model.engine ? <span className="dr-spec__engine" style={{ left: pctOf(model.engine.at) }} aria-hidden="true" /> : null}
        </div>
        {model.markers.map((m, i) => {
          const lane = lanes[i] ?? 0
          const edge = m.at < 0.07 ? 'l' : m.at > 0.93 ? 'r' : null
          return (
            <LCTooltip key={m.key} content={`${m.label} ${usd(m.value, { exact: true })} · ${m.basis}${m.clamped ? ' · off this scale, shown at the edge' : ''}`}>
              <button
                type="button"
                className={cx('dr-pin', `is-${sideOf(lane)}`, rowOf(lane) && 'is-outer', edge && `edge-${edge}`, selected === m.key && 'is-selected', m.clamped && 'is-clamped')}
                data-cls={m.cls}
                style={{ left: pctOf(m.at) }}
                onClick={() => onSelect(m.key)}
                aria-label={`${m.label} ${usd(m.value, { exact: true })}`}
                aria-pressed={selected === m.key}
              >
                <span className="dr-pin__stem" aria-hidden="true" />
                <span className="dr-pin__dot" aria-hidden="true" />
                <span className="dr-pin__tag">
                  <b>{m.label}</b>
                  <em className="lc-num">{m.clamped ? `${m.at <= 0 ? '◂ ' : ''}${usd(m.value)}${m.at >= 1 ? ' ▸' : ''}` : usd(m.value)}</em>
                </span>
              </button>
            </LCTooltip>
          )
        })}
      </div>
      <div className="dr-spec__ticks" aria-hidden="true">
        {model.ticks.map((t) => <span key={t.v} style={{ left: pctOf(t.at) }}>{t.label}</span>)}
      </div>
    </div>
  )
}

export function SpectrumLegend({ model }: { model: SpectrumModel }) {
  return (
    <div className="dr-legend" aria-label="Spectrum legend">
      {model.supported ? <span><i className="k-supported" />Supported value</span> : null}
      {model.compRange ? <span><i className="k-comprange" />Comp range</span> : null}
      {model.comps.length ? <span><i className="k-dot" />Comps · size = weight</span> : null}
      {model.offer ? <span><i className="k-offer" />Engine offer</span> : null}
      {model.authorized ? <span><i className="k-auth" />Authorized</span> : null}
    </div>
  )
}

/**
 * THE OFFER BAND — the negotiation neighbourhood, zoomed: where each price
 * leaves the target margin, the minimum margin, or no spread at all; the
 * engine range, the authorized range and the seller's number on top.
 */
export function OfferBand({ track, selected, onSelect, caption }: { track: OfferTrackModel; selected: string | null; onSelect: (key: string) => void; caption?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const onScale = track.pins.filter((p) => !p.offScale)
  const lanes = layoutLanes(onScale, width || 700, 100)
  const up = lanes.some((l) => l === 2) ? 2 : 1
  const down = lanes.some((l) => l === 3) ? 2 : lanes.some((l) => l === 1) ? 1 : 0
  return (
    <div className="dr-band" ref={ref} style={{ ['--up' as string]: up, ['--down' as string]: down }}>
      <div className="dr-band__stage">
        <div className="dr-band__track">
          {track.ticks.map((t) => <span key={t.v} className="dr-spec__grid" style={{ left: pctOf((t.v - track.min) / (track.max - track.min)) }} aria-hidden="true" />)}
          {track.zones.map((z) => (
            <LCTooltip key={z.key} content={z.label}>
              <button type="button" className={cx('dr-band__zone', selected === `zone:${z.key}` && 'is-selected')} data-zone={z.key} style={{ left: pctOf(z.from), width: pctOf(z.to - z.from) }} onClick={() => onSelect(`zone:${z.key}`)} aria-label={z.label} />
            </LCTooltip>
          ))}
          {track.authorized ? <span className="dr-band__auth" style={{ left: pctOf(track.authorized.from), width: pctOf(track.authorized.to - track.authorized.from) }} aria-hidden="true" /> : null}
          {track.engine ? <span className="dr-band__engine" style={{ left: pctOf(track.engine.from), width: `max(4px, ${pctOf(track.engine.to - track.engine.from)})` }} aria-hidden="true" /> : null}
        </div>
        {onScale.map((p, i) => {
          const lane = lanes[i] ?? 0
          const edge = p.at < 0.08 ? 'l' : p.at > 0.92 ? 'r' : null
          return (
            <button
              key={p.key}
              type="button"
              className={cx('dr-pin is-band', `is-${sideOf(lane)}`, rowOf(lane) && 'is-outer', edge && `edge-${edge}`, selected === p.key && 'is-selected')}
              data-cls={p.cls}
              style={{ left: pctOf(p.at) }}
              onClick={() => onSelect(p.key)}
              aria-label={`${p.label} ${usd(p.value, { exact: true })}`}
              aria-pressed={selected === p.key}
            >
              <span className="dr-pin__stem" aria-hidden="true" />
              <span className="dr-pin__dot" aria-hidden="true" />
              <span className="dr-pin__tag"><b>{p.label}</b><em className="lc-num">{usd(p.value)}</em></span>
            </button>
          )
        })}
        {track.pins.filter((p) => p.offScale).map((p) => (
          <button key={p.key} type="button" className={cx('dr-band__off', `is-${p.offScale}`, selected === p.key && 'is-selected')} data-cls={p.cls} onClick={() => onSelect(p.key)}>
            {p.offScale === 'left' ? '◂ ' : ''}{p.label} <b className="lc-num">{usd(p.value)}</b>{p.offScale === 'right' ? ' ▸' : ''}
          </button>
        ))}
      </div>
      <div className="dr-spec__ticks is-band" aria-hidden="true">
        {track.ticks.map((t) => <span key={t.v} style={{ left: pctOf((t.v - track.min) / (track.max - track.min)) }}>{t.label}</span>)}
      </div>
      {caption ? <p className="dr-band__caption">{caption}</p> : null}
    </div>
  )
}
