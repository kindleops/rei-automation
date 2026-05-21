import { useState } from 'react'
import type { StatsModel } from './stats.adapter'
import { Icon } from '../../shared/icons'
import { TemplateAnalytics } from './TemplateAnalytics'
import './stats-premium.css'

export const StatsPage = ({ data }: { data: StatsModel }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'templates'>('overview');

  // Use data to satisfy TS or remove if truly not needed, 
  // but usually we want to keep it for future integration.
  console.log('Stats data loaded:', !!data); 

  return (
    <div className="nx-premium-stats">
      <nav className="nx-stats-tabs">
        <button 
          className={`nx-stats-tab ${activeTab === 'overview' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button 
          className={`nx-stats-tab ${activeTab === 'templates' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('templates')}
        >
          Template Analytics
        </button>
      </nav>

      {activeTab === 'templates' ? (
        <TemplateAnalytics />
      ) : (
        <>
          <header className="nx-stats-header">
            <div className="nx-stats-header__title">
              <p className="cc-eyebrow">Nexus Intelligence</p>
              <h1>KPI Analytics</h1>
            </div>
            <div className="nx-stats-filters">
              <select className="nx-stats-filter-select">
                <option>All Markets</option>
                <option>Dallas</option>
                <option>Houston</option>
                <option>Phoenix</option>
              </select>
              <select className="nx-stats-filter-select">
                <option>Last 7 Days</option>
                <option>Last 30 Days</option>
                <option>This Month</option>
                <option>All Time</option>
              </select>
              <button className="nx-quick-filter-btn is-active">
                <Icon name="filter" style={{ width: 12, marginRight: 6 }} />
                Advanced Filters
              </button>
            </div>
          </header>

          <section className="nx-kpi-grid">
            <div className="nx-kpi-card">
              <span className="nx-kpi-card__label">Reply Rate</span>
              <span className="nx-kpi-card__value">32.4%</span>
              <span className="nx-kpi-card__change is-up">
                <Icon name="trending-up" style={{ width: 12 }} /> +4.2%
              </span>
            </div>
            <div className="nx-kpi-card">
              <span className="nx-kpi-card__label">Stop Rate</span>
              <span className="nx-kpi-card__value">4.1%</span>
              <span className="nx-kpi-card__change is-down">
                <Icon name="trending-up" style={{ width: 12, transform: 'rotate(180deg)' }} /> -0.8%
              </span>
            </div>
            <div className="nx-kpi-card">
              <span className="nx-kpi-card__label">Positive Interest</span>
              <span className="nx-kpi-card__value">12.8%</span>
              <span className="nx-kpi-card__change is-up">
                <Icon name="trending-up" style={{ width: 12 }} /> +1.5%
              </span>
            </div>
            <div className="nx-kpi-card">
              <span className="nx-kpi-card__label">Conversion Rate</span>
              <span className="nx-kpi-card__value">2.4%</span>
              <span className="nx-kpi-card__change is-up">
                <Icon name="trending-up" style={{ width: 12 }} /> +0.2%
              </span>
            </div>
          </section>

          <div className="nx-stats-charts">
            <section className="nx-chart-container">
              <div className="nx-chart-container__header">
                <h3 className="nx-chart-container__title">Stage Conversion</h3>
                <div className="nx-stats-filters">
                  <button className="nx-inline-button">Volume</button>
                  <button className="nx-inline-button is-active">Percentage</button>
                </div>
              </div>
              <div className="nx-chart-placeholder">
                <div className="nx-chart-bar" style={{ height: '100%' }}></div>
                <div className="nx-chart-bar" style={{ height: '85%' }}></div>
                <div className="nx-chart-bar" style={{ height: '60%' }}></div>
                <div className="nx-chart-bar" style={{ height: '40%' }}></div>
                <div className="nx-chart-bar" style={{ height: '25%' }}></div>
                <div className="nx-chart-bar" style={{ height: '10%' }}></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 11, color: 'var(--text-3)' }}>
                <span>Inbound</span>
                <span>Qualified</span>
                <span>Needs Offer</span>
                <span>Offer Sent</span>
                <span>Negotiation</span>
                <span>Closed</span>
              </div>
            </section>

            <section className="nx-chart-container">
              <div className="nx-chart-container__header">
                <h3 className="nx-chart-container__title">Queue Health</h3>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                    <span>Response Speed</span>
                    <span style={{ color: 'var(--tone-success)' }}>Excellent</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2 }}>
                    <div style={{ width: '92%', height: '100%', background: 'var(--tone-success)', borderRadius: 2 }}></div>
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                    <span>AI Draft Accuracy</span>
                    <span style={{ color: 'var(--tone-primary)' }}>High</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2 }}>
                    <div style={{ width: '84%', height: '100%', background: 'var(--tone-primary)', borderRadius: 2 }}></div>
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                    <span>Lead Motivation</span>
                    <span style={{ color: 'var(--tone-warning)' }}>Neutral</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2 }}>
                    <div style={{ width: '56%', height: '100%', background: 'var(--tone-warning)', borderRadius: 2 }}></div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <section className="nx-alerts-feed">
            <div className="nx-chart-container__header">
              <h3 className="nx-chart-container__title">Real-time Performance Alerts</h3>
              <button className="nx-inline-button">View All</button>
            </div>
            <div className="nx-alert-item is-urgent">
              <div className="nx-alert-item__icon"><Icon name="alert" style={{width: 16}} /></div>
              <div className="nx-alert-item__content">
                <div className="nx-alert-item__title">High Stop Rate in Dallas</div>
                <div className="nx-alert-item__desc">Stop rate exceeded 8% in M-Dallas-NW. Suggest reviewing campaign copy.</div>
                <div className="nx-alert-item__time">2 minutes ago</div>
              </div>
            </div>
            <div className="nx-alert-item is-info">
              <div className="nx-alert-item__icon"><Icon name="zap" style={{width: 16}} /></div>
              <div className="nx-alert-item__content">
                <div className="nx-alert-item__title">Hot Lead Detected</div>
                <div className="nx-alert-item__desc">AI identified high motivation in thread with Robert Chen. Scheduled follow-up.</div>
                <div className="nx-alert-item__time">14 minutes ago</div>
              </div>
            </div>
            <div className="nx-alert-item is-info">
              <div className="nx-alert-item__icon"><Icon name="trending-up" style={{width: 16}} /></div>
              <div className="nx-alert-item__content">
                <div className="nx-alert-item__title">Market Performance Up</div>
                <div className="nx-alert-item__desc">Houston North market showing 15% increase in positive interest over 24h.</div>
                <div className="nx-alert-item__time">1 hour ago</div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

