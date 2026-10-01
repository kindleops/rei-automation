import { cx, LCTooltip } from '../../../../shared/lc'
import { usd } from '../di-format'
import type { BridgeStep, OfferFigures, ThesisLine } from '../di-model'
import type { DiAvailable, DiDecision, DiSelection } from '../di-types'
import { Plane, Tag, type MoneyTag } from '../di-ui'

/**
 * THE THESIS — the decision as an investment memo, every line a fact from
 * the payload. The engine's recorded reasoning summary is quoted as such;
 * nothing here is a model's private chain of thought.
 */
export function ThesisPlane({ lines, dec, embedded }: { lines: ThesisLine[]; dec: DiAvailable | null; embedded?: boolean }) {
  if (!lines.length) return null
  const reasons = (dec?.tierReasons ?? []).filter((r) => !/^Gate not met/i.test(r))
  const body = (
    <>
      <dl className="dr-thesis">
        {lines.map((l) => (
          <div key={l.key} className="dr-thesis__row" data-tone={l.tone || undefined}>
            <dt>{l.label}</dt>
            <dd>{l.text}</dd>
          </div>
        ))}
      </dl>
      {reasons.length || dec?.why ? (
        <div className="dr-thesis__recorded">
          <span className="dr-eyebrow">Recorded by the engine</span>
          {reasons.map((r) => <p key={r}>{r}</p>)}
          {dec?.why ? <p><b>{dec.conversationAngle ?? 'Conversation angle'}:</b> {dec.why}</p> : null}
        </div>
      ) : null}
    </>
  )
  if (embedded) {
    return (
      <div className="dr-hero__thesis" aria-label="Decision thesis">
        <span className="dr-eyebrow">Decision thesis</span>
        {body}
      </div>
    )
  }
  return (
    <Plane id="thesis" eyebrow="Decision thesis" title="Why the engine decided this" under="exec">
      {body}
    </Plane>
  )
}

const TAG_OF: Record<BridgeStep['tag'], MoneyTag> = { modeled: 'modeled', policy: 'policy', estimated: 'estimated', authorized: 'authorized', record: 'record' }

/**
 * MONEY — the engine's own chain from value to fee, as a bridge:
 *   engine value × buyer factor − repairs = buyer ceiling (modeled exit)
 *   buyer ceiling − engine offer = modeled assignment fee.
 * A modeled spread is not profit, an estimate is never shown as recorded,
 * and what the engine does not model (holding, closing, financing) is said.
 */
export function MoneyPlane({ d, bridge, f, selection, onSelect }: { d: DiDecision; bridge: { steps: BridgeStep[]; scaleMax: number } | null; f: OfferFigures; selection: DiSelection | null; onSelect: (s: DiSelection) => void }) {
  const at = d.economics.atOffer
  const debt = d.economics.debt
  return (
    <Plane id="money" eyebrow="Economic thesis" title="Value to fee, as the engine computes it" under="exec" aside={<span className="dr-quiet">all figures modeled unless tagged</span>}>
      {bridge ? (
        <ol className="dr-bridge" aria-label="Economic bridge">
          {bridge.steps.map((s) => {
            const left = (s.from / bridge.scaleMax) * 100
            const width = Math.max(0.6, ((s.to - s.from) / bridge.scaleMax) * 100)
            const sel = selection?.type === 'money' && selection.key === s.key
            return (
              <li key={s.key} className={cx('dr-bridge__row', `is-${s.kind}`, sel && 'is-selected')} data-key={s.key}>
                <button type="button" onClick={() => onSelect({ type: 'money', key: s.key })} aria-pressed={sel}>
                  <span className="dr-bridge__label">{s.label}<Tag kind={TAG_OF[s.tag]} /></span>
                  <span className="dr-bridge__track" aria-hidden="true"><i style={{ left: `${left}%`, width: `${width}%` }} /></span>
                  <span className="dr-bridge__value lc-num">{s.kind === 'minus' ? usd(s.value) : usd(s.value)}</span>
                  {s.note ? <span className="dr-bridge__note">{s.note}</span> : null}
                </button>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="dr-none">No engine offer on record — the value-to-fee chain does not exist yet.</p>
      )}
      {bridge ? (
        <div className="dr-money__marks">
          {f.targetMargin ? <LCTooltip content="The deal-specific target the offer was built against (assignment margin policy)"><span>Target margin <b className="lc-num">{usd(f.targetMargin)}</b><Tag kind="policy" /></span></LCTooltip> : null}
          {f.minMargin ? <LCTooltip content="The minimum economics floor — the fee gate's threshold"><span>Minimum margin <b className="lc-num">{usd(f.minMargin)}</b><Tag kind="policy" /></span></LCTooltip> : null}
          {f.maxForTarget ? <span>Max price for target <b className="lc-num">{usd(f.maxForTarget)}</b></span> : null}
          {f.maxForMinimum ? <span>Break-even vs minimum <b className="lc-num">{usd(f.maxForMinimum)}</b></span> : null}
          {at && debt.estOpenBalance ? <span data-tone={at.debtCovered ? 'ok' : 'crit'}>Engine offer {at.debtCovered ? 'covers' : 'does not cover'} the {usd(debt.estOpenBalance)} est. open debt</span> : null}
        </div>
      ) : null}
      <p className="dr-money__honest">Holding, closing and financing costs are not modeled by the engine and are not shown. Modeled figures are not profit; actuals appear only with closing evidence.</p>
    </Plane>
  )
}
