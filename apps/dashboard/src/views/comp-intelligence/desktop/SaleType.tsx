import { LCTooltip } from '../../../shared/lc'
import { engineSourceFactor, type SaleTypeVerdict } from '../../../domain/comp-intelligence/comp-sale-type'
import './comp-evidence-media.css'

/**
 * THE channel chip — exactly one per comp: "MLS" or "Off market" (or "Channel
 * unknown"), with a forced-sale qualifier inside it when the record says so
 * ("Foreclosure / auction", "REO"). It never names the buyer: that is the
 * buyer chip beside it.
 */
export function SaleTypeBadge({ v }: { v: SaleTypeVerdict }) {
  return (
    <LCTooltip content={<span>{v.label}{v.qualifierLabel ? ` · ${v.qualifierLabel}` : ''}{v.evidence.length ? <> — {v.evidence.join(' · ')}</> : null}</span>}>
      <span className="cst" data-type={v.type} data-qualifier={v.qualifier ?? undefined} tabIndex={0} aria-label={`Channel: ${v.short}${v.qualifierLabel ? `, ${v.qualifierLabel}` : ''}`}>
        {v.short}
        {v.qualifierLabel ? <span className="cst__q">{v.qualifierLabel}</span> : null}
      </span>
    </LCTooltip>
  )
}

/** The inspector's channel block: the chip, the recorded facts, and how the engine weighs the source. */
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
