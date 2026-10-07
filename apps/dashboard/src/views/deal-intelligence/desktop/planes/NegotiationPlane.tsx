import type { NegotiationV3Desk } from '../../../../domain/deal-intelligence/deal-decision-api'
import { usd } from '../di-format'
import { Figure, Tag } from '../di-ui'

/**
 * §82 Negotiation v3 desk: seller ask, opening anchor, current LC position, target,
 * autonomous limit and ceiling, plus the authority's grade and why. Operator-only.
 * Never blank (owner 10-07): the numbers always show; only AUTONOMOUS sending is
 * gated, by grade. Rendered only when the API includes `offer.negotiationV3`
 * (server flag NEGOTIATION_ENGINE_V3, default OFF). The UI never decides a number.
 */
const ACTION_LABEL: Record<NegotiationV3Desk['nextMove']['action'], string> = {
  QUOTE: 'Quote',
  HOLD: 'Hold position',
  HUMAN: 'Proposal for your review',
  CLOSE_UNREALISTIC: 'Close politely (too far apart)',
  NO_NUMBER: 'No number yet',
}

const LANE_LABEL: Record<string, string> = { sfr: 'SFR', mf24: 'MF 2–4', mf5: 'MF 5+' }

export function NegotiationPlane({ n }: { n: NegotiationV3Desk }) {
  const money = (v: number | null) => usd(v) ?? '—'
  const pu = n.perUnit
  const perUnit = (v: number | null | undefined) => (pu && v != null ? `${money(v)}/door` : null)
  const next = n.nextMove
  const nextAmount = next.amount ?? next.proposal
  const grade = n.grade ? `Grade ${n.grade}${n.fallbackRung != null ? ` · rung ${n.fallbackRung}` : ''}` : 'Ungraded'
  return (
    <section className="dr-plane is-d2" data-plane="negotiation" data-under={n.status === 'autonomous_eligible' ? 'exec' : 'attn'} aria-label="Negotiation authority">
      <header className="dr-plane__head">
        <div className="dr-plane__titles">
          <span className="dr-eyebrow">Negotiation v3 · shadow · {n.lane ? LANE_LABEL[n.lane] ?? n.lane : 'lane unresolved'}</span>
          <h3 className="dr-plane__title">{n.status === 'no_numbers' ? 'The offer authority returned no numbers' : n.status === 'autonomous_eligible' ? 'How far automation may go' : 'Numbers for your approval'}</h3>
        </div>
        <div className="dr-plane__aside"><span className="dr-quiet">{grade} · {n.authority.source ?? 'no engine'}</span></div>
      </header>
      {n.status !== 'no_numbers' ? (
        <>
          <div className="dr-money__marks" role="list" aria-label="Negotiation positions">
            <Figure label="Seller ask" value={money(n.ask)} tag="seller" size="sm" />
            <Figure label="Opening anchor" value={money(n.anchor)} tag="policy" basis={perUnit(pu?.anchor)} size="sm" />
            <Figure label="Current position" value={n.currentPosition ? money(n.currentPosition.amount) : n.quotesCaptured ? 'None quoted' : 'Not captured'} tag={n.currentPosition ? 'actual' : null} basis={n.currentPosition?.type ?? null} size="sm" />
            <Figure label="Target" value={money(n.target)} tag="modeled" basis={perUnit(pu?.target)} size="sm" />
            <Figure label="Autonomous limit" value={money(n.autonomousLimit)} tag="policy" basis={perUnit(pu?.autonomous_limit)} size="sm" />
            <Figure label="Ceiling" value={money(n.ceiling)} tag={n.authority.ok ? 'authorized' : 'modeled'} basis={perUnit(pu?.ceiling)} size="sm" />
          </div>
          <p className="dr-quiet">
            Ladder {n.ladder.map((r) => money(r.amount)).join(' → ')} · above {money(n.autonomousLimit)} needs your approval
            {n.anchorFloor != null ? ` · anchor floor ${money(n.anchorFloor)} (investor price ${money(n.investorPrice)} − ${Math.round((n.anchorFloorPolicy?.discount ?? 0) * 100)}%, ${n.anchorFloorPolicy?.basis ?? 'default'})` : ''}
            {pu ? ` · ${pu.units} doors (${pu.unit_source ?? 'source unknown'})` : ''}
            {pu?.band_low != null ? ` · investor band ${money(pu.band_low)}–${money(pu.band_high)}/door (internal — never disclosed)` : ''}
          </p>
          {!n.autonomy.eligible ? <p className="dr-quiet">Automation will not send these numbers: {n.autonomy.reasons.join(', ')} <Tag kind="policy">Gate</Tag></p> : null}
        </>
      ) : (
        <p className="dr-none">Held: {n.authority.reasons.join(', ') || 'no ceiling or offer from the authority'}.</p>
      )}
      <p className="dr-quiet">
        Next: <b>{ACTION_LABEL[next.action]}</b>
        {nextAmount != null ? <> {money(nextAmount)}{next.proposal != null && next.amount == null ? ' (proposal)' : ''}</> : null}
        {next.quoteType ? ` · ${next.quoteType.replace(/_/g, ' ').toLowerCase()}` : ''} · rule {next.rule}
      </p>
      {next.reply ? <p className="dr-quiet">Seller would read ({next.reply.branch.replace(/_/g, ' ')}): <q>{next.reply.text}</q></p> : null}
      {n.why.length ? (
        <ul className="dr-quiet" aria-label="Why">
          {n.why.slice(0, 10).map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      ) : null}
    </section>
  )
}
