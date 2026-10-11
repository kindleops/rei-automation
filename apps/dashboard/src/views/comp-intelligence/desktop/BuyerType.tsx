import { LCTooltip } from '../../../shared/lc'
import type { CompBuyerType } from '../../../domain/comp-intelligence/comp-buyer-type'
import './buyer-type.css'

/**
 * One chip per comp: what kind of buyer (LLC · trust · company · bank ·
 * individual) and, where known, what for (investor · owner-occupant). A dashed
 * outline marks an INFERRED fact (owner of record / entity rule); a solid one
 * a recorded deed or buyer-index fact. Evidence and basis on hover.
 */
export function BuyerTypeChip({ t, withName = false }: { t: CompBuyerType; withName?: boolean }) {
  const name = withName && t.name && t.isEntity ? t.name : null
  const tip = (
    <span className="cbt-tip">
      <b>{t.entityLabel}{t.useLabel ? ` · ${t.useLabel}` : ''}</b>
      <span>{t.basisLabel}{t.provenance === 'inferred' ? ' — inferred' : ''}</span>
      {t.evidence.map((e) => <span key={e}>· {e}</span>)}
    </span>
  )
  return (
    <LCTooltip content={tip}>
      <span className="cbt" data-entity={t.entity} data-use={t.use} data-prov={t.provenance} tabIndex={0}
        aria-label={`Buyer: ${t.entityLabel}${t.useLabel ? `, ${t.useLabel}` : ''}. ${t.basisLabel}${t.provenance === 'inferred' ? ', inferred' : ''}`}>
        <span className="cbt__entity">{t.entity === 'unknown' ? 'Buyer unknown' : t.entityLabel}</span>
        {t.useLabel ? <span className="cbt__use">{t.useLabel}</span> : null}
        {name ? <span className="cbt__name">{name}</span> : null}
      </span>
    </LCTooltip>
  )
}

/** "38 of 52 comps have a buyer type · 21 entity · 17 individual" — the honest coverage line. */
export function BuyerTypeCoverageLine({ classified, total, entities, individuals, investor, ownerOccupant }: { classified: number; total: number; entities: number; individuals: number; investor: number; ownerOccupant: number }) {
  if (!total) return null
  return (
    <span className="cbt-cover lc-num">
      Buyer type on <b>{classified}</b> of {total} comps
      {classified ? <> · {entities} entity · {individuals} individual{investor ? ` · ${investor} investor` : ''}{ownerOccupant ? ` · ${ownerOccupant} owner-occupant` : ''}</> : null}
    </span>
  )
}
