import { useMemo } from 'react'
import type { PurchaseEvent, RankedBuyer } from './buyer-match-v4.types'
import { buildBuyerDossier } from './buildBuyerDossier'
import { formatBuyerClassLabel } from './buyerFilters'
import {
  fmtCurrency,
  fmtDate,
  fmtMiles,
  fmtRange,
  humanContactReadiness,
} from './formatters'

interface Props {
  buyer: RankedBuyer | null
  events: PurchaseEvent[]
  shortlisted: boolean
  onToggleShortlist: () => void
}

export function BuyerDossier({ buyer, events, shortlisted, onToggleShortlist }: Props) {
  const dossier = useMemo(
    () => (buyer ? buildBuyerDossier(buyer, events) : null),
    [buyer, events],
  )

  if (!buyer || !dossier) {
    return (
      <aside className="bmv4-dossier bmv4-dossier--empty">
        <h3>Buyer Dossier</h3>
        <p>Select an eligible buyer family to inspect identity, activity windows, buy box, bid intelligence, and contacts.</p>
      </aside>
    )
  }

  const b = dossier.buyer
  const isInst = b.institutionalStatus === 'VERIFIED_INSTITUTIONAL'
  const ps = dossier.purchaseStats

  return (
    <aside className="bmv4-dossier">
      <header className="bmv4-dossier__header">
        <div>
          <h3 className="bmv4-dossier__name">{b.buyerName}</h3>
          <p className="bmv4-dossier__meta">
            {formatBuyerClassLabel(b.buyerClass ?? b.buyerArchetype)}
            {b.institutionalSubtype ? ` · ${b.institutionalSubtype}` : ''}
            {isInst && <span className="bmv4-badge is-inst">Verified Institutional</span>}
          </p>
        </div>
        <div className="bmv4-dossier__scores">
          <span className={`bmv4-grade is-${(b.matchGrade ?? 'd').toLowerCase().replace('+', 'plus')}`}>{b.matchGrade}</span>
          <span className="bmv4-tabular">Score {b.matchScore ?? '—'}</span>
        </div>
        <div className="bmv4-dossier__bid bmv4-tabular">
          Likely bid {fmtRange(b.likelyBidLow, b.likelyBidHigh)}
        </div>
        <div className="bmv4-dossier__actions">
          <span className={`bmv4-contact is-${b.contactReadiness.toLowerCase()}`}>
            {humanContactReadiness(b.contactReadiness)}
          </span>
          <button type="button" className={`bmv4-btn is-ghost${shortlisted ? ' is-on' : ''}`} onClick={onToggleShortlist}>
            {shortlisted ? 'Shortlisted' : 'Add to shortlist'}
          </button>
        </div>
      </header>

      <section className="bmv4-dossier__section">
        <h4>Activity windows</h4>
        <table className="bmv4-window-table bmv4-tabular">
          <thead>
            <tr><th>Window</th><th>Unique assets</th><th>Events</th><th>Package assets</th></tr>
          </thead>
          <tbody>
            <tr><td>30 days</td><td>{ps.count30}</td><td>{ps.events30}</td><td>—</td></tr>
            <tr><td>60 days</td><td>{ps.count60}</td><td>—</td><td>—</td></tr>
            <tr><td>90 days</td><td>{ps.count90}</td><td>—</td><td>—</td></tr>
            <tr><td>180 days</td><td>{ps.count180}</td><td>{ps.events180}</td><td>—</td></tr>
            <tr><td>365 days</td><td>{ps.count365}</td><td>—</td><td>—</td></tr>
            <tr><td>Lifetime</td><td>{ps.lifetime}</td><td>—</td><td>{ps.packageAssets || '—'}</td></tr>
          </tbody>
        </table>
        <dl className="bmv4-dossier__dl is-grid-3">
          <div><dt>Local ZIP</dt><dd className="bmv4-tabular">{ps.localZipPurchases}</dd></div>
          <div><dt>Radius</dt><dd className="bmv4-tabular">{ps.radiusPurchases}</dd></div>
          <div><dt>Nearest</dt><dd>{fmtMiles(ps.nearestMiles)}</dd></div>
          <div><dt>Last purchase</dt><dd>{fmtDate(ps.lastPurchase)}</dd></div>
          <div><dt>Single-asset %</dt><dd className="bmv4-tabular">{ps.singleAssetPct != null ? `${ps.singleAssetPct}%` : '—'}</dd></div>
          <div><dt>Package %</dt><dd className="bmv4-tabular">{ps.packagePct != null ? `${ps.packagePct}%` : '—'}</dd></div>
        </dl>
      </section>

      <section className="bmv4-dossier__section">
        <h4>Match thesis</h4>
        <ul className="bmv4-dossier__list">
          {dossier.matchThesis.map((t) => <li key={t}>{t}</li>)}
        </ul>
      </section>

      <section className="bmv4-dossier__section">
        <h4>Buy box</h4>
        <dl className="bmv4-dossier__dl">
          {dossier.buyBox.map((row) => (
            <div key={row.label}>
              <dt>{row.label}{row.inferred ? ' (inferred)' : ''}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {b.legalEntities && b.legalEntities.length > 0 && (
        <section className="bmv4-dossier__section">
          <h4>Legal entities</h4>
          <ul className="bmv4-dossier__list">
            {b.legalEntities.map((le) => (
              <li key={le.entityId}>{le.legalName} · {le.purchaseCount} purchases · {le.relationshipType}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="bmv4-dossier__section">
        <h4>Recent purchases</h4>
        {dossier.events.length === 0 ? (
          <p className="bmv4-muted">No verified purchase events for this family.</p>
        ) : (
          <table className="bmv4-dossier__table">
            <thead>
              <tr><th>Date</th><th>Address</th><th>Consideration</th><th>Scope</th></tr>
            </thead>
            <tbody>
              {dossier.events.slice(0, 8).map((e) => (
                <tr key={e.eventId}>
                  <td>{fmtDate(e.purchaseDate)}</td>
                  <td>{e.address}</td>
                  <td className="bmv4-tabular">
                    {e.transactionScope !== 'SINGLE_ASSET'
                      ? `${fmtCurrency(e.totalConsideration)} pkg`
                      : fmtCurrency(e.propertyAllocatedConsideration ?? e.purchasePrice)}
                  </td>
                  <td>{e.transactionScope?.replace(/_/g, ' ') ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="bmv4-dossier__section">
        <h4>Bid intelligence</h4>
        <dl className="bmv4-dossier__dl">
          <div><dt>Low</dt><dd className="bmv4-tabular">{fmtCurrency(b.likelyBidLow)}</dd></div>
          <div><dt>Base</dt><dd className="bmv4-tabular">{fmtCurrency(b.likelyBidBase)}</dd></div>
          <div><dt>High</dt><dd className="bmv4-tabular">{fmtCurrency(b.likelyBidHigh)}</dd></div>
          <div><dt>Qualified median</dt><dd className="bmv4-tabular">{fmtCurrency(ps.medianPrice)}</dd></div>
          <div><dt>Basis</dt><dd>{dossier.bidBasis}</dd></div>
        </dl>
      </section>

      <section className="bmv4-dossier__section">
        <h4>Contacts</h4>
        <dl className="bmv4-dossier__dl">
          <div><dt>Status</dt><dd>{humanContactReadiness(b.contactReadiness)}</dd></div>
          <div><dt>Enrichment</dt><dd>{b.contactReadiness === 'ENRICHMENT_REQUIRED' ? 'Required before outreach' : 'Not required'}</dd></div>
        </dl>
      </section>

      <section className="bmv4-dossier__section">
        <h4>Sources</h4>
        <p className="bmv4-muted">Verified purchase records · Public-record acquisitions · Buyer match projection · Refreshed from canonical read layer.</p>
      </section>
    </aside>
  )
}