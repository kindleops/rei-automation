import { LCTooltip } from '../../../shared/lc'
import type { CompBuyerType } from '../../../domain/comp-intelligence/comp-buyer-type'
import './buyer-type.css'

/**
 * THE buyer chip — exactly one per comp: "LLC investor", "Trust", "Individual",
 * "Owner-occupant", "Bank / REO" … (rule table in comp-buyer-type.ts). Solid
 * outline = recorded (deed / buyer index); dashed = inferred (owner of record).
 * Basis and evidence live on hover, never as extra words in the chip.
 */
export function BuyerTypeChip({ t, withName = false }: { t: CompBuyerType; withName?: boolean }) {
  const name = withName && t.name && t.isEntity ? t.name : null
  const tip = (
    <span className="cbt-tip">
      <b>{t.label}</b>
      <span>{t.basisLabel}{t.provenance === 'inferred' ? ' — inferred' : ''}</span>
      {t.evidence.map((e) => <span key={e}>· {e}</span>)}
    </span>
  )
  return (
    <LCTooltip content={tip}>
      <span className="cbt" data-chip={t.chip} data-entity={t.entity} data-use={t.use} data-prov={t.provenance} tabIndex={0}
        aria-label={`Buyer: ${t.label}. ${t.basisLabel}${t.provenance === 'inferred' ? ', inferred' : ''}`}>
        <span className="cbt__entity">{t.label}</span>
        {name ? <span className="cbt__name">{name}</span> : null}
      </span>
    </LCTooltip>
  )
}

/** "Buyer type on 38 of 52 comps · 21 entity · 17 individual" — the honest coverage line. */
export function BuyerTypeCoverageLine({ classified, total, entities, individuals, investor, ownerOccupant }: { classified: number; total: number; entities: number; individuals: number; investor: number; ownerOccupant: number }) {
  if (!total) return null
  return (
    <span className="cbt-cover lc-num">
      Buyer type on <b>{classified}</b> of {total} comps
      {classified ? <> · {entities} entity · {individuals} individual{investor ? ` · ${investor} investor` : ''}{ownerOccupant ? ` · ${ownerOccupant} owner-occupant` : ''}</> : null}
    </span>
  )
}
