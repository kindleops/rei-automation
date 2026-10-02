import { LCTooltip } from '../../../shared/lc'
import { engineSourceFactor, type SaleTypeVerdict } from '../../../domain/comp-intelligence/comp-sale-type'
import './comp-evidence-media.css'

/** One badge per comp: how the sale happened, with the facts behind it on hover. */
export function SaleTypeBadge({ v, withBuyer = false }: { v: SaleTypeVerdict; withBuyer?: boolean }) {
  const buyer = withBuyer && v.type === 'mls' && (v.buyer === 'investor' || v.buyer === 'institutional') ? v.buyerLabel : withBuyer && v.type === 'investor' && v.buyer === 'institutional' ? 'Institutional' : null
  return (
    <LCTooltip content={<span>{v.label}{v.evidence.length ? <> — {v.evidence.join(' · ')}</> : null}</span>}>
      <span className="cst" data-type={v.type} tabIndex={0} aria-label={`${v.label}${buyer ? `, ${buyer}` : ''}`}>
        {v.short}
        {buyer ? <span className="cst__buyer">{buyer}</span> : null}
      </span>
    </LCTooltip>
  )
}

/** The inspector's sale-type block: type, buyer, the recorded facts, and how the engine weighs the source. */
export function SaleTypeEvidence({ v, engineSource, rules, weighted }: {
  v: SaleTypeVerdict
  engineSource?: string | null
  rules?: { mlsFactor: number; otherFactor: number } | null
  /** the engine actually weighed this sale (stored or live verdict) */
  weighted: boolean
}) {
  const f = weighted ? engineSourceFactor(engineSource, rules) : null
  return (
    <div className="cst-evidence">
      <div className="cst-evidence__head">
        <SaleTypeBadge v={v} />
        {v.buyerLabel ? <span className="cst" data-type={v.buyer === 'individual' ? 'public_record' : 'investor'}>{v.buyerLabel}</span> : null}
      </div>
      {v.evidence.length ? <ul>{v.evidence.map((e) => <li key={e}>{e}</li>)}</ul> : null}
      {f ? (
        <p className="cst-evidence__engine lc-num">
          The engine weighs this sale as <b>{f.mls ? 'MLS' : 'non-MLS'}</b> — source factor <b>×{f.factor}</b>{f.mls ? '' : ` (MLS sales get ×${rules?.mlsFactor ?? 1})`}.
        </p>
      ) : null}
    </div>
  )
}
