import type { NegotiationV3Desk } from '../../../../domain/deal-intelligence/deal-decision-api'
import { usd } from '../di-format'
import { Figure, Tag } from '../di-ui'

/**
 * §82 Negotiation v3 desk: seller ask, opening anchor, current LC position, target,
 * autonomous limit and ceiling, plus why. Operator-only. Rendered only when the API
 * includes `offer.negotiationV3` (server flag NEGOTIATION_ENGINE_V3, default OFF).
 * The UI renders domain state; it never decides a number.
 */
const ACTION_LABEL: Record<NegotiationV3Desk['nextMove']['action'], string> = {
  QUOTE: 'Quote',
  HOLD: 'Hold position',
  HUMAN: 'Needs you',
  CLOSE_UNREALISTIC: 'Close politely (too far apart)',
  NO_NUMBER: 'No number yet',
}

export function NegotiationPlane({ n }: { n: NegotiationV3Desk }) {
  const money = (v: number | null) => usd(v) ?? '—'
  const pu = n.perUnit
  const perUnit = (v: number | null | undefined) => (pu && v != null ? `${money(v)}/unit` : null)
  const next = n.nextMove
  const nextAmount = next.amount ?? next.proposal
  return (
    <section className="dr-plane is-d2" data-plane="negotiation" data-under={n.status === 'authorized' ? 'exec' : 'attn'} aria-label="Negotiation authority">
      <header className="dr-plane__head">
        <div className="dr-plane__titles">
          <span className="dr-eyebrow">Negotiation v3 · shadow</span>
          <h3 className="dr-plane__title">{n.status === 'authorized' ? 'How far we are authorized' : 'No autonomous number'}</h3>
        </div>
        <div className="dr-plane__aside"><span className="dr-quiet">{n.authority.source ?? 'no engine'} {n.authority.engine_version ?? ''}</span></div>
      </header>
      {n.status === 'authorized' ? (
        <>
          <div className="dr-money__marks" role="list" aria-label="Negotiation positions">
            <Figure label="Seller ask" value={money(n.ask)} tag="seller" size="sm" />
            <Figure label="Opening anchor" value={money(n.anchor)} tag="policy" basis={perUnit(pu?.anchor)} size="sm" />
            <Figure label="Current position" value={n.currentPosition ? money(n.currentPosition.amount) : n.quotesCaptured ? 'None quoted' : 'Not captured'} tag={n.currentPosition ? 'actual' : null} basis={n.currentPosition?.type ?? null} size="sm" />
            <Figure label="Target" value={money(n.target)} tag="policy" basis={perUnit(pu?.target)} size="sm" />
            <Figure label="Autonomous limit" value={money(n.autonomousLimit)} tag="authorized" basis={perUnit(pu?.autonomous_limit)} size="sm" />
            <Figure label="Ceiling" value={money(n.ceiling)} tag="authorized" basis={perUnit(pu?.ceiling)} size="sm" />
          </div>
          <p className="dr-quiet">
            Ladder {n.ladder.map((r) => money(r.amount)).join(' → ')} · above {money(n.autonomousLimit)} needs your approval · fair floor {money(n.fairFloor)}
            {pu ? ` · ${pu.units} units (${pu.unit_source ?? 'source unknown'})` : ''}
          </p>
        </>
      ) : (
        <p className="dr-none">
          Held: {n.authority.reasons.join(', ') || 'no authoritative offer'}.
          {n.engineReference?.ceiling != null ? <> Engine reference (not authoritative): max {money(n.engineReference.ceiling)}, offer {money(n.engineReference.recommended)} <Tag kind="modeled" /></> : null}
        </p>
      )}
      <p className="dr-quiet">
        Next: <b>{ACTION_LABEL[next.action]}</b>
        {nextAmount != null ? <> {money(nextAmount)}{next.proposal != null && next.amount == null ? ' (proposal)' : ''}</> : null}
        {next.quoteType ? ` · ${next.quoteType.replace(/_/g, ' ').toLowerCase()}` : ''} · rule {next.rule}
      </p>
      {n.why.length ? (
        <ul className="dr-quiet" aria-label="Why">
          {n.why.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      ) : null}
    </section>
  )
}
