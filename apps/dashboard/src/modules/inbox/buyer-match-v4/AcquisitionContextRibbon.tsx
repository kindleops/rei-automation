import type { BuyerMatchSubjectContext, BuyerMatchV4Projection } from './buyer-match-v4.types'
import {
  fmtBuyerExit,
  fmtCurrencyLabel,
  fmtExecutionState,
  fmtMarketValue,
  fmtStrategy,
} from './formatters'

interface Props {
  subject: BuyerMatchSubjectContext
  projection?: BuyerMatchV4Projection | null
}

export function AcquisitionContextRibbon({ subject, projection }: Props) {
  const acq = projection?.subject?.acquisitionContext
  const source = acq?.source ?? 'UNAVAILABLE'
  const v3Available =
    source === 'ACQUISITION_ENGINE_V3' ||
    subject.marketValue != null ||
    subject.buyerExitBase != null ||
    subject.strategy != null ||
    subject.executionState != null

  return (
    <section className="bmv4-acq-context" aria-label="Acquisition context">
      <div className="bmv4-acq-context__head">
        <span className="bmv4-eyebrow">Acquisition Context</span>
        <span className="bmv4-acq-context__source">
          {v3Available ? 'Acquisition Engine V3' : 'Context unavailable'}
        </span>
      </div>
      <dl className="bmv4-acq-context__grid">
        <div><dt>Asset lane</dt><dd>{subject.assetLane ?? 'Data required'}</dd></div>
        <div><dt>Subtype</dt><dd>{subject.propertySubtype ?? 'Data required'}</dd></div>
        <div><dt>Units / SF</dt><dd>{subject.units ?? '—'} / {subject.buildingSquareFeet?.toLocaleString() ?? '—'}</dd></div>
        <div>
          <dt>Market value</dt>
          <dd>{fmtMarketValue(subject.marketValue ?? acq?.marketValue, source)}</dd>
        </div>
        <div>
          <dt>Buyer exit</dt>
          <dd>{fmtBuyerExit(subject.buyerExitLow ?? acq?.buyerExitLow, subject.buyerExitBase ?? acq?.buyerExitBase, subject.buyerExitHigh ?? acq?.buyerExitHigh)}</dd>
        </div>
        <div><dt>Strategy</dt><dd>{fmtStrategy(subject.strategy ?? acq?.strategy)}</dd></div>
        <div><dt>Repairs</dt><dd>{fmtCurrencyLabel(subject.repairEstimate, 'Not yet underwritten')}</dd></div>
        <div><dt>Execution</dt><dd>{fmtExecutionState(subject.executionState ?? acq?.executionState)}</dd></div>
      </dl>
      {subject.majorBuyerFacingRisks && subject.majorBuyerFacingRisks.length > 0 && (
        <div className="bmv4-acq-context__risks">
          <span className="bmv4-eyebrow">Buyer-facing risks</span>
          <ul>{subject.majorBuyerFacingRisks.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
    </section>
  )
}