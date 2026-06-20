import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import { formatCurrency, formatInteger, formatPercent } from '../../shared/formatters'
import { buildPropertyExternalLinks } from '../../domain/inbox/inbox-normalization'
import { useDealIntelligenceDossier } from '../../domain/deal-intelligence/useDealIntelligenceDossier'
import type { DealIntelligenceDossier } from '../../domain/deal-intelligence/deal-intelligence.types'
import { getBackendBaseUrl } from '../../lib/api/backendClient'
import './deal-intelligence-25.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const fmtMoney = (value: number | null | undefined) => (value && value > 0 ? formatCurrency(value) : null)
const fmtPct = (value: number | null | undefined) => (value && value > 0 ? formatPercent(value) : null)

type MediaTab = 'street' | 'aerial'

interface DealIntelligence25PanelProps {
  threadKey?: string
  propertyId?: string
  prospectId?: string
  masterOwnerId?: string
  canonicalE164?: string
  fallbackAddress?: string | null
}

async function resolveEmbedUrl(type: MediaTab, dossier: DealIntelligenceDossier | null, address?: string | null) {
  const lat = dossier?.property?.latitude
  const lng = dossier?.property?.longitude
  const qs = new URLSearchParams()
  qs.set('type', type === 'street' ? 'streetview' : 'aerial')
  if (lat && lng) {
    qs.set('lat', String(lat))
    qs.set('lng', String(lng))
  } else if (address) {
    qs.set('address', address)
  } else {
    return null
  }
  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/maps/embed?${qs.toString()}`)
    const payload = await res.json()
    return payload?.ok ? payload.embed_url : null
  } catch {
    return null
  }
}

const CollapsibleSection = ({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="nx-di25-section">
      <button type="button" className="nx-di25-section__toggle" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open ? <div className="nx-di25-section__body">{children}</div> : null}
    </section>
  )
}

const MetricRow = ({ label, value }: { label: string; value: React.ReactNode }) => {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="nx-di25-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export const DealIntelligence25Panel = ({
  threadKey,
  propertyId,
  prospectId,
  masterOwnerId,
  canonicalE164,
  fallbackAddress,
}: DealIntelligence25PanelProps) => {
  const {
    dossier,
    loading,
    error,
    runDecisionEngine,
    engineRunning,
    engineProgress,
  } = useDealIntelligenceDossier({
    threadKey,
    propertyId,
    prospectId,
    masterOwnerId,
    canonicalE164,
  })

  const [mediaTab, setMediaTab] = useState<MediaTab>('street')
  const [embedUrl, setEmbedUrl] = useState<string | null>(null)
  const [embedLoading, setEmbedLoading] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)

  const address = dossier?.property?.full_address || fallbackAddress || null
  const links = useMemo(() => buildPropertyExternalLinks(address), [address])
  const snapshot = dossier?.decision_snapshot
  const engineNotRun = dossier?.acquisition_decision?.status === 'not_run'
  const isLive = Boolean(
    dossier?.freshness?.acquisition_computed_at ||
    dossier?.freshness?.buyer_market_freshness ||
    dossier?.freshness?.comps_freshness,
  )

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setEmbedLoading(true)
      const stored = mediaTab === 'street' ? dossier?.property?.street_view_url : dossier?.property?.satellite_url
      if (stored) {
        if (!cancelled) {
          setEmbedUrl(stored)
          setEmbedLoading(false)
        }
        return
      }
      const url = await resolveEmbedUrl(mediaTab, dossier, address)
      if (!cancelled) {
        setEmbedUrl(url)
        setEmbedLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [mediaTab, dossier, address])

  const copyAddress = () => {
    if (!address) return
    navigator.clipboard.writeText(address).catch(() => undefined)
    setAddrCopied(true)
    setTimeout(() => setAddrCopied(false), 1400)
  }

  if (loading && !dossier) {
    return <div className="nx-deal-compact-shell nx-di25-loading">Loading deal intelligence…</div>
  }

  if (error && !dossier) {
    return <div className="nx-deal-compact-shell nx-di25-error">{error}</div>
  }

  const property = dossier?.property
  const unitsLabel = property?.units && property.units > 1 ? `${property.units} units` : null

  return (
    <div className="nx-deal-compact-shell">
      <div className="nx-di25-media nx-property-hero-shell">
        <div className="nx-di25-media__tabs">
          <button type="button" className={cls('nx-di25-media__tab', mediaTab === 'street' && 'is-active')} onClick={() => setMediaTab('street')}>
            Street View
          </button>
          <button type="button" className={cls('nx-di25-media__tab', mediaTab === 'aerial' && 'is-active')} onClick={() => setMediaTab('aerial')}>
            Aerial
          </button>
        </div>
        <div className="nx-di25-media__surface nx-property-hero__media">
          {embedLoading ? <div className="nx-di25-media__placeholder">Loading view…</div> : null}
          {!embedLoading && embedUrl ? (
            <iframe title={mediaTab === 'street' ? 'Street View' : 'Aerial View'} src={embedUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
          ) : null}
          {!embedLoading && !embedUrl ? <div className="nx-di25-media__placeholder">View unavailable</div> : null}
        </div>
        <div className="nx-di25-media__actions">
          {links.zillow ? <a href={links.zillow} target="_blank" rel="noopener noreferrer">Zillow</a> : null}
          {links.realtor ? <a href={links.realtor} target="_blank" rel="noopener noreferrer">Realtor</a> : null}
          {links.googleSearch ? <a href={links.googleSearch} target="_blank" rel="noopener noreferrer">Google</a> : null}
          <button type="button" onClick={copyAddress}>{addrCopied ? 'Copied' : 'Copy Address'}</button>
        </div>
      </div>

      <div className="nx-di25-identity">
        <h2>{address || 'Property unknown'}</h2>
        <div className="nx-di25-identity__meta">
          {property?.market ? <span>{property.market}</span> : null}
          {property?.property_type ? <span>{property.property_type}</span> : null}
          {unitsLabel ? <span>{unitsLabel}</span> : null}
          {isLive ? <span className="nx-di25-live">Live</span> : null}
        </div>
        {property?.property_flags?.length ? (
          <div className="nx-di25-flags">
            {property.property_flags.slice(0, 4).map((flag) => (
              <span key={flag} className="nx-di25-flag">{flag}</span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="nx-deal-compact-summary">
        <div className="nx-deal-compact-summary__metrics">
          <div className="nx-di25-snapshot-metric is-primary">
            <span>Acquisition Score</span>
            <strong>{snapshot?.acquisition_score ?? snapshot?.heat_score ?? '—'}</strong>
          </div>

          {engineNotRun ? (
            <div className="nx-di25-engine-cta">
              <p>Decision Engine Not Run</p>
              <button type="button" disabled={engineRunning} onClick={() => void runDecisionEngine()}>
                {engineRunning ? 'Running…' : 'Run Decision Engine'}
              </button>
              {engineRunning ? (
                <ul className="nx-di25-engine-progress">
                  {engineProgress.map((step) => (
                    <li key={step.stage} className={cls(step.status === 'done' && 'is-done')}>{step.label}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="nx-di25-snapshot-metric is-offer">
              <span>Recommended Cash Offer</span>
              <strong>{fmtMoney(snapshot?.recommended_cash_offer) ?? '—'}</strong>
            </div>
          )}

          <MetricRow
            label="Valuation Range"
            value={
              snapshot?.valuation_range?.low || snapshot?.valuation_range?.high
                ? `${fmtMoney(snapshot?.valuation_range?.low) ?? '—'} – ${fmtMoney(snapshot?.valuation_range?.high) ?? '—'}`
                : null
            }
          />
          <MetricRow label="Equity" value={fmtMoney(snapshot?.equity_amount) ?? fmtPct(snapshot?.equity_percentage)} />
          <MetricRow label="Best Strategy" value={snapshot?.best_strategy} />
          <MetricRow label="Expected Assignment Fee" value={fmtMoney(snapshot?.expected_assignment_fee)} />
          <MetricRow
            label="Buyer Demand / Liquidity"
            value={
              snapshot?.buyer_demand_score || snapshot?.liquidity_score
                ? `${snapshot?.buyer_demand_score ?? '—'} / ${snapshot?.liquidity_score ?? '—'}`
                : dossier?.buyer_market?.signal || null
            }
          />
          <MetricRow label="Largest Risk" value={snapshot?.largest_risk?.label} />
          <MetricRow label="Next Action" value={snapshot?.recommended_next_action} />
        </div>
      </div>

      <CollapsibleSection title="Market & Buyers">
        <MetricRow label="Market Signal" value={dossier?.buyer_market?.signal} />
        <MetricRow label="Geo Level" value={dossier?.buyer_market?.geographic_level_used} />
        <MetricRow label="Buyer Pool" value={dossier?.buyer_market?.buyer_count ? formatInteger(dossier.buyer_market.buyer_count) : null} />
        <MetricRow label="Purchases" value={dossier?.buyer_market?.purchase_count ? formatInteger(dossier.buyer_market.purchase_count) : null} />
        <MetricRow label="Median Price" value={fmtMoney(dossier?.buyer_market?.median_purchase_price)} />
        {dossier?.buyer_matches?.status === 'matched' ? (
          <MetricRow label="Matched Buyers" value={dossier?.buyer_matches?.matched_buyer_count as number | undefined} />
        ) : (
          <MetricRow label="Market Buyer Pool" value={dossier?.buyer_market?.buyer_count} />
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Seller & Owner">
        <MetricRow label="Owner" value={dossier?.master_owner?.display_name as string | undefined} />
        <MetricRow label="Owner Type" value={dossier?.master_owner?.owner_type as string | undefined} />
        <MetricRow label="Portfolio Value" value={fmtMoney(dossier?.master_owner?.portfolio_value as number | undefined)} />
        <MetricRow label="Properties" value={dossier?.master_owner?.property_count as number | undefined} />
        <MetricRow label="Prospect" value={dossier?.prospect?.name as string | undefined} />
        <MetricRow label="Phone" value={dossier?.phone?.number as string | undefined} />
      </CollapsibleSection>

      <CollapsibleSection title="Property Detail">
        <MetricRow label="Beds / Baths" value={property?.bedrooms || property?.bathrooms ? `${property?.bedrooms ?? '—'} / ${property?.bathrooms ?? '—'}` : null} />
        <MetricRow label="Sq Ft" value={property?.square_feet ? formatInteger(property.square_feet) : null} />
        <MetricRow label="Year Built" value={property?.year_built} />
        <MetricRow label="Condition" value={property?.condition} />
        <MetricRow label="Repairs" value={fmtMoney(property?.repair_estimate)} />
        <MetricRow label="ARV" value={fmtMoney(property?.arv)} />
      </CollapsibleSection>

      <CollapsibleSection title="Comps">
        <MetricRow label="Comp Count" value={dossier?.comps?.comp_count as number | undefined} />
        <MetricRow label="Median Sale" value={fmtMoney(dossier?.comps?.median_sale as number | undefined)} />
        <MetricRow label="Confidence" value={dossier?.comps?.confidence as number | undefined} />
      </CollapsibleSection>

      <CollapsibleSection title="Compliance">
        <MetricRow label="Suppressed" value={dossier?.compliance?.is_suppressed ? 'Yes' : null} />
      </CollapsibleSection>

      <CollapsibleSection title="Activity">
        {(dossier?.activity_timeline || []).slice(0, 8).map((event) => (
          <MetricRow key={`${event.type}-${event.timestamp}`} label={String(event.label || event.type)} value={String(event.timestamp || '').slice(0, 16)} />
        ))}
      </CollapsibleSection>

      {dossier?.census?.status === 'not_loaded' ? (
        <div className="nx-di25-census-empty">{String(dossier.census.label || 'Census enrichment not loaded')}</div>
      ) : null}
    </div>
  )
}