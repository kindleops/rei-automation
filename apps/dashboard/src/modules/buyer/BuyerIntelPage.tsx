import { useState } from 'react'
import type { BuyerModel, BuyerProfile } from './buyer.adapter'
import { Icon } from '../../shared/icons'

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const intentClass: Record<BuyerProfile['intent'], string> = {
  active: 'is-active',
  passive: 'is-passive',
  watching: 'is-watching',
  dormant: 'is-dormant',
}

const intentIcon: Record<BuyerProfile['intent'], string> = {
  active: 'zap',
  passive: 'eye',
  watching: 'clock',
  dormant: 'pause',
}

export const BuyerIntelPage = ({ data }: { data: BuyerModel }) => {
  const [selectedId, setSelectedId] = useState<string | null>(data.buyers[0]?.id ?? null)
  const [filterIntent, setFilterIntent] = useState<string>('all')
  const selected = data.buyers.find((b) => b.id === selectedId) ?? null
  const buyerMatches = data.matches.filter((m) => m.buyerId === selectedId)

  const filtered = filterIntent === 'all'
    ? data.buyers
    : data.buyers.filter(b => b.intent === filterIntent)

  return (
    <div className="nx-buyer">
      <header className="nx-surface-header">
        <div className="nx-surface-header__title">
          <Icon className="nx-surface-icon" name="users" />
          <h1>Buyer Intelligence</h1>
        </div>
        <div className="nx-surface-header__stats">
          <span className="nx-badge nx-badge--success">{data.activeBuyerCount} active</span>
          <span className="nx-badge nx-badge--primary">{data.totalBudget} total budget</span>
          <span className="nx-badge nx-badge--muted">{data.matches.length} matches</span>
        </div>
      </header>

      <div className="nx-buyer__filters">
        {['all', 'active', 'passive', 'watching', 'dormant'].map((intent) => (
          <button
            key={intent}
            type="button"
            className={classes('nx-filter-pill', filterIntent === intent && 'is-active')}
            onClick={() => setFilterIntent(intent)}
          >
            {intent === 'all' ? `All (${data.buyers.length})` : `${intent.charAt(0).toUpperCase() + intent.slice(1)} (${data.buyers.filter(b => b.intent === intent).length})`}
          </button>
        ))}
      </div>

      <div className="nx-buyer__body">
        <aside className="nx-buyer__list">
          {filtered.map((buyer) => (
            <button
              key={buyer.id}
              type="button"
              className={classes(
                'nx-buyer-row',
                selectedId === buyer.id && 'is-selected',
                buyer.intent === 'active' && 'is-hot-buyer',
              )}
              onClick={() => setSelectedId(buyer.id)}
            >
              <div className="nx-buyer-row__top">
                <div className="nx-buyer-row__name-wrap">
                  <Icon name={intentIcon[buyer.intent] as any} className="nx-buyer-row__intent-icon" />
                  <strong>{buyer.name}</strong>
                </div>
                <span className={classes('nx-intent-badge', intentClass[buyer.intent])}>
                  {buyer.intent.toUpperCase()}
                </span>
              </div>
              <div className="nx-buyer-row__stats">
                <span>{buyer.budgetLabel}</span>
                <span>Score {buyer.matchScore}</span>
                <span>{buyer.acquisitionsYTD} YTD</span>
              </div>
              <div className="nx-buyer-row__markets">
                {buyer.marketLabels.map((m) => (
                  <span key={m} className="nx-micro-tag">{m}</span>
                ))}
              </div>
            </button>
          ))}
        </aside>

        <main className="nx-buyer__detail">
          {selected ? (
            <div className="nx-buyer-detail">
              <div className="nx-buyer-detail__hero">
                <div className="nx-buyer-detail__hero-top">
                  <h2>{selected.name}</h2>
                  <div className="nx-buyer-detail__tags">
                    <span className={classes('nx-intent-badge nx-intent-badge--lg', intentClass[selected.intent])}>
                      <Icon name={intentIcon[selected.intent] as any} className="nx-intent-icon" />
                      {selected.intent.toUpperCase()}
                    </span>
                    {selected.preApproved && (
                      <span className="nx-badge nx-badge--success">Pre-Approved</span>
                    )}
                  </div>
                </div>
                <span className="nx-buyer-detail__activity">
                  Last activity {selected.lastActivityLabel}
                </span>
              </div>

              <div className="nx-buyer-detail__kpi-grid">
                <div className="nx-kpi-mini">
                  <span>Budget</span>
                  <strong>{selected.budgetLabel}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Match Score</span>
                  <strong className="nx-kpi-highlight">{selected.matchScore}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Acquisitions YTD</span>
                  <strong>{selected.acquisitionsYTD}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Avg Days to Close</span>
                  <strong>{selected.avgDaysToClose}</strong>
                </div>
              </div>

              <section className="nx-buyer-detail__section">
                <h3>Target Markets</h3>
                <div className="nx-tag-row">
                  {selected.marketLabels.map((m) => (
                    <span key={m} className="nx-tag nx-tag--interactive">{m}</span>
                  ))}
                </div>
              </section>

              <section className="nx-buyer-detail__section">
                <h3>Target Property Types</h3>
                <div className="nx-tag-row">
                  {selected.targetPropertyTypes.map((t) => (
                    <span key={t} className="nx-tag">{t}</span>
                  ))}
                </div>
              </section>

              <section className="nx-buyer-detail__section">
                <h3>Target ZIPs</h3>
                <div className="nx-tag-row">
                  {selected.targetZips.map((z) => (
                    <span key={z} className="nx-tag nx-tag--mono">{z}</span>
                  ))}
                </div>
              </section>

              {selected.notes && (
                <section className="nx-buyer-detail__section">
                  <h3>Notes</h3>
                  <p className="nx-buyer-detail__notes">{selected.notes}</p>
                </section>
              )}

              {buyerMatches.length > 0 && (
                <section className="nx-buyer-detail__section">
                  <h3>Property Matches ({buyerMatches.length})</h3>
                  <div className="nx-match-list">
                    {buyerMatches.map((match) => (
                      <div key={`${match.buyerId}-${match.leadId}`} className="nx-match-card">
                        <div className="nx-match-card__header">
                          <strong>{match.leadAddress}</strong>
                          <span className={classes('nx-match-score', match.matchScore >= 80 && 'is-high')}>
                            {match.matchScore}%
                          </span>
                        </div>
                        <div className="nx-match-card__meta">
                          <span>{match.leadOwnerName}</span>
                          <span>{match.propertyType}</span>
                          <span>{match.marketLabel}</span>
                          <span>{match.offerLabel}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div className="nx-empty-state nx-empty-state--large">
              <Icon className="nx-empty-icon" name="users" />
              <p>Select a buyer profile</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
