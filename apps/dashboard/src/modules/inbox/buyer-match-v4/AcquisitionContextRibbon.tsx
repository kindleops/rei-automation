import type { BuyerMatchSubjectContext } from './buyer-match-v4.types'
import { fmtCurrency } from './formatters'

interface Props {
  subject: BuyerMatchSubjectContext
}

export function AcquisitionContextRibbon({ subject }: Props) {
  const v3Available =
    subject.marketValue != null ||
    subject.buyerExitBase != null ||
    subject.strategy != null ||
    subject.executionState != null

  return (
    <section className="bmv4-acq-context" aria-label="Acquisition Engine V3 context">
      <div className="bmv4-acq-context__head">
        <span className="bmv4-eyebrow">Acquisition Context</span>
        <span className="bmv4-acq-context__source">Acquisition Engine V3</span>
      </div>
      {!v3Available ? (
        <p className="bmv4-muted">Acquisition Engine V3 context unavailable for this property.</p>
      ) : (
        <dl className="bmv4-acq-context__grid">
          <div><dt>Asset lane</dt><dd>{subject.assetLane ?? '—'}</dd></div>
          <div><dt>Subtype</dt><dd>{subject.propertySubtype ?? '—'}</dd></div>
          <div><dt>Units / SF</dt><dd>{subject.units ?? '—'} / {subject.buildingSquareFeet?.toLocaleString() ?? '—'}</dd></div>
          <div><dt>Market value</dt><dd className="bmv4-tabular">{fmtCurrency(subject.marketValue)}</dd></div>
          <div><dt>Buyer exit</dt><dd className="bmv4-tabular">{fmtCurrency(subject.buyerExitLow)} – {fmtCurrency(subject.buyerExitHigh)}</dd></div>
          <div><dt>Strategy</dt><dd>{subject.strategy ?? '—'}</dd></div>
          <div><dt>Repairs</dt><dd className="bmv4-tabular">{fmtCurrency(subject.repairEstimate)}</dd></div>
          <div><dt>Execution</dt><dd>{subject.executionState ?? '—'}</dd></div>
        </dl>
      )}
      {subject.majorBuyerFacingRisks && subject.majorBuyerFacingRisks.length > 0 && (
        <div className="bmv4-acq-context__risks">
          <span className="bmv4-eyebrow">Buyer-facing risks</span>
          <ul>{subject.majorBuyerFacingRisks.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
    </section>
  )
}