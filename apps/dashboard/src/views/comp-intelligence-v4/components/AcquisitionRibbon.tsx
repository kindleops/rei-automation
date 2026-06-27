/**
 * Comp Intelligence V4 — compact Acquisition Decision Engine V3 ribbon.
 * Read-only projection of the canonical V3 decision. Never recomputes.
 * When V3 is unavailable, shows a single restrained line (Section 14).
 */

import type { V4DecisionRibbon } from '../state/types'
import { fmtMoneyShort } from '../adapters/format'

interface AcquisitionRibbonProps {
  decision: V4DecisionRibbon
  onViewUnderwriting: () => void
}

export function AcquisitionRibbon({ decision, onViewUnderwriting }: AcquisitionRibbonProps) {
  if (!decision.available) {
    return (
      <div className="civ4-ribbon civ4-ribbon--muted" role="note">
        <span className="civ4-ribbon__mode">{decision.executionLabel ?? 'Comp Research Mode'}</span>
        <span className="civ4-ribbon__note">{decision.unavailableNote}</span>
      </div>
    )
  }

  const cells: Array<{ label: string; value: string }> = [
    { label: 'Asset lane', value: decision.assetLaneLabel ?? '—' },
    {
      label: decision.valueClassificationLabel ?? 'Market value',
      value: fmtMoneyShort(decision.qualifiedMarketValue),
    },
    { label: 'Conservative exit', value: fmtMoneyShort(decision.conservativeBuyerExit) },
    { label: 'Shadow offer', value: fmtMoneyShort(decision.recommendedShadowOffer) },
    { label: 'Strategy', value: decision.primaryStrategyLabel ?? '—' },
    {
      label: 'Confidence',
      value: decision.confidence != null ? `${Math.round(decision.confidence * 100)}%` : '—',
    },
  ]

  return (
    <div className="civ4-ribbon" role="note" aria-label="Acquisition decision">
      <div className="civ4-ribbon__cells">
        {cells.map((c) => (
          <div key={c.label} className="civ4-ribbon__cell">
            <span className="civ4-ribbon__label">{c.label}</span>
            <span className="civ4-ribbon__value">{c.value}</span>
          </div>
        ))}
      </div>
      <div className="civ4-ribbon__actions">
        {decision.largestBlocker && (
          <span className="civ4-pill civ4-pill--warn" title="Largest blocker">
            {decision.largestBlocker}
          </span>
        )}
        <button type="button" className="civ4-btn civ4-btn--ghost" onClick={onViewUnderwriting}>
          View Underwriting
        </button>
      </div>
    </div>
  )
}
