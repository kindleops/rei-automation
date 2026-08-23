import { useEffect, useState, type ReactNode } from 'react'

import { Icon } from '../../shared/icons'
import { formatDate, formatMoney } from '../../lib/data/propertyData'
import {
  loadBuyerIntelligence,
  type BuyerIntelligenceBuyer,
  type BuyerIntelligencePanel as PanelData,
  type ObservedBuyboxFit,
} from '../../lib/data/buyerIntelligenceData'
import type { PropertyRecord } from './property.types'

/**
 * Property Buyer Intelligence — Shadow.
 *
 * Observational only. This panel reports what W8C has independently observed
 * about buyers of this property. It deliberately offers no actions: no
 * outreach, no "send deal", no offer or campaign controls, and it does not
 * influence buyer-match ranking, MAO, pricing, or seller priority.
 *
 * Person buyers are shown as `person:anon_<hash>` handles — W8C mints raw
 * person IDs from an individual key, so the raw form never reaches the browser.
 * Company names are displayed because the serving contract permits them.
 *
 * Language rule: this is evidence, not a prediction. Nothing here should read
 * as "this buyer will buy this property".
 */

interface BuyerIntelligencePanelProps {
  property: PropertyRecord
}

const pctLabel = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`

const numLabel = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : String(value)

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="pi-intel-row">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

const Chip = ({ tone, children }: { tone: 'neutral' | 'evidence' | 'caution'; children: ReactNode }) => {
  const palette = {
    neutral: { color: 'rgba(255,255,255,0.55)', border: 'rgba(255,255,255,0.15)' },
    evidence: { color: '#C6FF4A', border: 'rgba(198,255,74,0.35)' },
    caution: { color: '#FFB800', border: 'rgba(255,184,0,0.35)' },
  }[tone]
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 7px',
        borderRadius: 3,
        border: `1px solid ${palette.border}`,
        color: palette.color,
        fontSize: 9,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

/** A person buyer is shown only by its redacted handle; never a name. */
const buyerLabel = (buyer: BuyerIntelligenceBuyer): string => {
  if (buyer.entityType === 'company' && buyer.displayName) return buyer.displayName
  if (buyer.buyerRef?.startsWith('person:')) return `Individual · ${buyer.buyerRef.replace('person:anon_', '')}`
  return buyer.buyerRef ?? 'Unresolved buyer'
}

const BuyerBlock = ({ buyer }: { buyer: BuyerIntelligenceBuyer }) => {
  const { behavior, buybox } = buyer
  return (
    <div
      style={{
        borderTop: '1px solid rgba(255,255,255,0.06)',
        padding: '10px 0 4px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>{buyerLabel(buyer)}</strong>
        <Chip tone="neutral">{buyer.entityType}</Chip>
        <Chip tone="evidence">
          {buyer.occurrenceCount} canonical {buyer.occurrenceCount === 1 ? 'acquisition' : 'acquisitions'}
        </Chip>
        {behavior?.archetype ? <Chip tone="neutral">{behavior.archetype.replace(/_/g, ' ')}</Chip> : null}
      </div>

      {buyer.resolutionMethod ? (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>
          Resolved via {buyer.resolutionMethod.replace(/_/g, ' ')}
          {buyer.resolutionConfidence !== null ? ` · confidence ${pctLabel(buyer.resolutionConfidence)}` : ''}
        </div>
      ) : null}

      <div className="pi-two-col-list">
        {buyer.acquisitions.slice(0, 3).map((a, i) => (
          <Row
            key={`${buyer.buyerRef}-acq-${i}`}
            label={a.acquiredOn ? formatDate(a.acquiredOn) : 'Undated acquisition'}
            value={a.acquisitionPrice ? formatMoney(a.acquisitionPrice) : 'Price not recorded'}
          />
        ))}
      </div>

      {behavior ? (
        <div className="pi-two-col-list" style={{ marginTop: 6 }}>
          <Row label="Acquisitions" value={numLabel(behavior.acquisitionCount)} />
          <Row label="Last acquisition" value={behavior.lastAcquisition ? formatDate(behavior.lastAcquisition) : '—'} />
          <Row label="Activity" value={`${behavior.activityStatus ?? '—'} · ${numLabel(behavior.activityScore)}`} />
          <Row label="Trailing 365d" value={numLabel(behavior.trailing365d)} />
          <Row
            label="Hold / flip"
            value={
              behavior.holdFlip.classification
                ? `${behavior.holdFlip.classification.replace(/_/g, ' ')}${
                    behavior.holdFlip.medianHoldDays ? ` · ~${behavior.holdFlip.medianHoldDays}d` : ''
                  }`
                : 'Not established'
            }
          />
          <Row
            label="Portfolio"
            value={
              behavior.portfolioState === 'unknown'
                ? 'Not captured'
                : behavior.portfolioState === 'empty'
                  ? 'Observed empty'
                  : `${numLabel(behavior.portfolioPropertyCount)} held`
            }
          />
          <Row label="Primary market" value={behavior.geography.primaryMarkets[0] ?? '—'} />
          <Row label="Median price" value={behavior.priceMedian ? formatMoney(behavior.priceMedian) : '—'} />
          <Row
            label="Evidence"
            value={`${numLabel(behavior.evidenceCount)} obs · ${
              behavior.evidenceCoveragePct === null ? '—' : `${behavior.evidenceCoveragePct}% coverage`
            }`}
          />
          <Row label="Behavior confidence" value={pctLabel(behavior.confidence)} />
        </div>
      ) : (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>No behavior profile for this buyer.</div>
      )}

      {buybox ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)', marginBottom: 4 }}>
            DERIVED BUYBOX · {buybox.evidenceDepth} ACQUISITIONS OF EVIDENCE
          </div>
          <div className="pi-two-col-list">
            {/* Robust band is primary: it is the band that actually held up on
                the temporal backtest. The core band is secondary context. */}
            <Row
              label="Price range (robust)"
              value={
                buybox.priceRobustLow !== null && buybox.priceRobustHigh !== null
                  ? `${formatMoney(buybox.priceRobustLow)} – ${formatMoney(buybox.priceRobustHigh)}`
                  : '—'
              }
            />
            <Row
              label="Core band (narrow, secondary)"
              value={
                buybox.priceCoreLow !== null && buybox.priceCoreHigh !== null
                  ? `${formatMoney(buybox.priceCoreLow)} – ${formatMoney(buybox.priceCoreHigh)}`
                  : '—'
              }
            />
            <Row label="Preferred counties" value={buybox.preferredCounties.join(', ') || '—'} />
            <Row label="Asset families" value={buybox.preferredAssetFamilies.join(', ') || '—'} />
            <Row
              label="Building sqft"
              value={
                buybox.buildingSqftP25 && buybox.buildingSqftP75
                  ? `${buybox.buildingSqftP25} – ${buybox.buildingSqftP75}`
                  : '—'
              }
            />
            <Row label="Buybox confidence" value={pctLabel(buybox.confidence)} />
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <Chip tone="caution">
            {buyer.buyboxStatus === 'insufficient_evidence'
              ? 'Insufficient history for buybox'
              : 'Buybox unavailable'}
          </Chip>
        </div>
      )}
    </div>
  )
}

const TIER_TONE: Record<string, 'neutral' | 'evidence' | 'caution'> = {
  zip: 'evidence', county: 'evidence', match: 'evidence', inside: 'evidence',
  state: 'neutral', compatible: 'neutral', partial: 'neutral', unknown: 'neutral',
  mismatch: 'caution', above: 'caution', below: 'caution',
}

const fitLabelTone = (label: string): 'neutral' | 'evidence' | 'caution' =>
  label.startsWith('strong') ? 'evidence' : label.startsWith('partial') ? 'neutral' : 'caution'

/**
 * One observed fit. Deliberately no action affordance — this reports what W8C
 * has observed, it does not propose contacting anyone.
 */
const FitRow = ({ fit }: { fit: ObservedBuyboxFit }) => {
  const name = fit.entityType === 'company' && fit.displayName
    ? fit.displayName
    : `Individual · ${fit.buyerRef.replace('person:anon_', '')}`
  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '7px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 11, minWidth: 34, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(fit.observedBuyboxFitScore)}
        </strong>
        <span style={{ fontSize: 11, flex: 1, minWidth: 120 }}>{name}</span>
        <Chip tone={fitLabelTone(fit.label)}>{fit.label}</Chip>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
        <Chip tone={TIER_TONE[fit.geographyTier] ?? 'neutral'}>geo {fit.geographyTier}</Chip>
        <Chip tone={TIER_TONE[fit.assetTier] ?? 'neutral'}>asset {fit.assetTier}</Chip>
        <Chip tone={TIER_TONE[fit.robustPriceTier] ?? 'neutral'}>price {fit.robustPriceTier}</Chip>
        <Chip tone="neutral">evidence {Math.round(fit.evidenceConfidence * 100)}% · {fit.evidenceDepth ?? '—'}</Chip>
      </div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.38)', marginTop: 3 }}>{fit.reasons.join(' · ')}</div>
    </div>
  )
}

export const BuyerIntelligencePanel = ({ property }: BuyerIntelligencePanelProps) => {
  const propertyId = property.propertyId ?? null
  // Single state object tagged with the id it belongs to. Deriving `loading`
  // from a stale tag avoids a synchronous setState in the effect body (which
  // would cascade renders) while still showing a loading state when the
  // selected property changes.
  const [resolved, setResolved] = useState<{ id: string | null; panel: PanelData | null }>({
    id: null,
    panel: null,
  })

  useEffect(() => {
    let cancelled = false
    loadBuyerIntelligence(propertyId).then((result) => {
      if (!cancelled) setResolved({ id: propertyId, panel: result })
    })
    return () => {
      cancelled = true
    }
  }, [propertyId])

  const loading = resolved.id !== propertyId
  const panel = loading ? null : resolved.panel

  const heading = (
    <div className="pi-panel-heading">
      <Icon name="users" />
      <div>
        <span>Buyer Intelligence — Shadow</span>
        <h2>Observed buyers of this property</h2>
      </div>
    </div>
  )

  if (loading) {
    return (
      <section className="pi-panel">
        {heading}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>Loading buyer intelligence…</div>
      </section>
    )
  }

  // Every non-available state renders quietly. The panel must never be the
  // reason a property page fails to load.
  if (!panel || panel.status === 'unavailable') {
    return (
      <section className="pi-panel">
        {heading}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
          Buyer Intelligence unavailable.
          {panel?.reason ? <span style={{ opacity: 0.7 }}> ({panel.reason.replace(/_/g, ' ')})</span> : null}
        </div>
      </section>
    )
  }

  if (panel.status === 'no_canonical_buyer_history') {
    return (
      <section className="pi-panel">
        {heading}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
          No canonical buyer history for this property.
        </div>
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 6 }}>
          Absence of evidence, not evidence of absence — W8C covers a subset of the corpus.
        </div>
      </section>
    )
  }

  const comparison = panel.reiComparison

  return (
    <section className="pi-panel">
      {heading}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <Chip tone="neutral">Shadow · observational</Chip>
        <Chip tone="evidence">
          {panel.occurrenceCount} canonical {panel.occurrenceCount === 1 ? 'occurrence' : 'occurrences'}
        </Chip>
        <Chip tone="neutral">
          {panel.buyerCount} {panel.buyerCount === 1 ? 'buyer' : 'buyers'}
        </Chip>
        {panel.buyersWithBuybox ? <Chip tone="evidence">{panel.buyersWithBuybox} with buybox</Chip> : null}
      </div>

      {panel.buyers.map((buyer) => (
        <BuyerBlock key={buyer.buyerRef} buyer={buyer} />
      ))}

      {panel.observedFits ? (
        <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 10, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)' }}>
              OBSERVED BUYBOX FITS
            </span>
            <Chip tone="caution">Shadow — does not affect buyer ranking</Chip>
          </div>
          {panel.observedFits.available && panel.observedFits.fits.length ? (
            <>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.32)', marginBottom: 2 }}>
                {panel.observedFits.eligibleCandidates} buyers with a derived buybox evaluated · ranked by observed
                fit, not likelihood to purchase
              </div>
              {panel.observedFits.fits.map((fit) => (
                <FitRow key={fit.buyerRef} fit={fit} />
              ))}
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              {panel.observedFits.reason === 'insufficient_subject_data'
                ? 'Not evaluable — insufficient subject data.'
                : panel.observedFits.available
                  ? 'No defensible buybox fits for this property.'
                  : 'Buybox fits unavailable.'}
            </div>
          )}
        </div>
      ) : null}

      {comparison?.available && comparison.candidateCount > 0 ? (
        <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
          <div style={{ fontSize: 10, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)', marginBottom: 4 }}>
            REI BUYER-MATCH · SIDE BY SIDE
          </div>
          <div className="pi-two-col-list">
            {comparison.rows.slice(0, 6).map((row) => (
              <Row
                key={row.reiBuyerEntityId}
                label={`${row.displayName ?? 'Candidate'}${row.matchGrade ? ` · ${row.matchGrade}` : ''}`}
                value={[
                  row.w8cPropertyEvidence ? 'W8C evidence: yes' : 'W8C evidence: no',
                  row.linkedByNameOnly
                    ? `buybox: ${row.linkedByNameOnly.w8cBuyboxAvailable ? 'yes' : 'no'}`
                    : row.nameAgreementAmbiguous
                      ? 'name match ambiguous'
                      : 'no name match',
                ].join(' · ')}
              />
            ))}
          </div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 6 }}>
            REI and W8C buyer identities are separate namespaces. Name agreement is an observational lead, not a
            confirmed identity match.
          </div>
        </div>
      ) : null}

      {panel.version?.modelVersion ? (
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.28)', marginTop: 10 }}>
          {panel.version.modelVersion}
          {panel.version.w8aVersion ? ` · ${panel.version.w8aVersion}` : ''}
          {panel.version.w8bVersion ? ` · ${panel.version.w8bVersion}` : ''}
        </div>
      ) : null}
    </section>
  )
}
