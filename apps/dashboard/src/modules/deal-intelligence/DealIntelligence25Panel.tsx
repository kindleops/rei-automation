import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import { formatCurrency, formatInteger, formatPercent } from '../../shared/formatters'
import { buildPropertyExternalLinks } from '../../domain/inbox/inbox-normalization'
import { useDealIntelligenceDossier } from '../../domain/deal-intelligence/useDealIntelligenceDossier'
import type { DealIntelligenceDossier } from '../../domain/deal-intelligence/deal-intelligence.types'
import { getBackendBaseUrl } from '../../lib/api/backendClient'
import './deal-intelligence-25.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const fmtMoney = (value: number | null | undefined) => (value !== null && value !== undefined && value > 0 ? formatCurrency(value) : null)
const fmtPct = (value: number | null | undefined) => (value !== null && value !== undefined && value >= 0 ? formatPercent(value) : null)
const fmtScore = (value: number | null | undefined) => (value !== null && value !== undefined ? String(Math.round(value * 10) / 10) : null)
const has = (v: unknown) => v !== null && v !== undefined && v !== ''

type MediaTab = 'street' | 'aerial'
type MediaMode = 'embed' | 'image' | 'unavailable' | 'loading'

interface DealIntelligence25PanelProps {
  threadKey?: string
  propertyId?: string
  prospectId?: string
  masterOwnerId?: string
  canonicalE164?: string
  fallbackAddress?: string | null
}

async function resolveInteractiveEmbed(type: MediaTab, dossier: DealIntelligenceDossier | null, address?: string | null) {
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

const DetailSection = ({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="nx-di25-detail">
      <button type="button" className="nx-di25-detail__toggle" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open ? <div className="nx-di25-detail__body">{children}</div> : null}
    </section>
  )
}

const GlassRow = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => {
  if (!has(value)) return null
  return (
    <div className={cls('nx-di25-glass-row', tone && `is-${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const ScoreChip = ({ label, value, tone = 'default' }: { label: string; value: string | null; tone?: string }) => {
  if (!value) return null
  return (
    <div className={cls('nx-di25-score-chip', `is-${tone}`)}>
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
  const { dossier, loading, error, runDecisionEngine, engineRunning, engineProgress } = useDealIntelligenceDossier({
    threadKey,
    propertyId,
    prospectId,
    masterOwnerId,
    canonicalE164,
  })

  const [mediaTab, setMediaTab] = useState<MediaTab>('street')
  const [mediaMode, setMediaMode] = useState<MediaMode>('loading')
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [addrCopied, setAddrCopied] = useState(false)

  const address = dossier?.property?.full_address || fallbackAddress || null
  const links = useMemo(() => buildPropertyExternalLinks(address), [address])
  const snap = dossier?.decision_snapshot
  const baseline = dossier?.baseline_scores
  const property = dossier?.property
  const owner = dossier?.master_owner
  const prospect = dossier?.prospect
  const phone = dossier?.phone
  const engineAvailable = snap?.engine_available === true

  const flags = property?.property_flags || []
  const visibleFlags = flags.slice(0, 3)
  const overflowCount = property?.property_flags_overflow ?? Math.max(0, flags.length - 3)

  const storedMediaUrl = mediaTab === 'street' ? property?.street_view_url : property?.satellite_url

  useEffect(() => {
    let cancelled = false
    let embedFallbackTimer: ReturnType<typeof setTimeout> | null = null

    const loadMedia = async () => {
      setMediaMode('loading')
      setMediaUrl(null)

      const stored = mediaTab === 'street' ? property?.street_view_url : property?.satellite_url
      const embed = await resolveInteractiveEmbed(mediaTab, dossier, address)

      if (cancelled) return

      if (embed) {
        setMediaUrl(embed)
        setMediaMode('embed')
        if (stored) {
          embedFallbackTimer = setTimeout(() => {
            if (!cancelled) {
              setMediaUrl(stored)
              setMediaMode('image')
            }
          }, 3500)
        }
        return
      }

      if (stored) {
        setMediaUrl(stored)
        setMediaMode('image')
        return
      }

      setMediaMode('unavailable')
    }

    void loadMedia()
    return () => {
      cancelled = true
      if (embedFallbackTimer) clearTimeout(embedFallbackTimer)
    }
  }, [mediaTab, dossier, address, property?.street_view_url, property?.satellite_url])

  const handleMediaEmbedError = () => {
    if (storedMediaUrl) {
      setMediaUrl(storedMediaUrl)
      setMediaMode('image')
      return
    }
    setMediaMode('unavailable')
    setMediaUrl(null)
  }

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

  const unitsLabel = property?.units && property.units > 1 ? `${property.units} units` : null

  return (
    <div className="nx-deal-compact-shell">
      {/* A. Media */}
      <div className="nx-di25-media nx-property-hero-shell">
        <div className="nx-di25-media__tabs">
          <button type="button" className={cls('nx-di25-media__tab', mediaTab === 'street' && 'is-active')} onClick={() => setMediaTab('street')}>Street View</button>
          <button type="button" className={cls('nx-di25-media__tab', mediaTab === 'aerial' && 'is-active')} onClick={() => setMediaTab('aerial')}>Aerial</button>
        </div>
        <div className="nx-di25-media__surface nx-property-hero__media">
          {mediaMode === 'loading' ? <div className="nx-di25-media__state">Loading view…</div> : null}
          {mediaMode === 'embed' && mediaUrl ? (
            <iframe
              title={mediaTab === 'street' ? 'Street View' : 'Aerial View'}
              src={mediaUrl}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              onError={handleMediaEmbedError}
            />
          ) : null}
          {mediaMode === 'image' && mediaUrl ? (
            <img src={mediaUrl} alt={mediaTab === 'street' ? 'Street View' : 'Aerial View'} className="nx-di25-media__img" />
          ) : null}
          {mediaMode === 'unavailable' ? <div className="nx-di25-media__state">View unavailable</div> : null}
          <div className="nx-di25-media__gradient" />
        </div>
        <div className="nx-di25-media__actions">
          {links.zillow ? <a href={links.zillow} target="_blank" rel="noopener noreferrer">Zillow</a> : null}
          {links.realtor ? <a href={links.realtor} target="_blank" rel="noopener noreferrer">Realtor</a> : null}
          {links.googleSearch ? <a href={links.googleSearch} target="_blank" rel="noopener noreferrer">Google</a> : null}
          <button type="button" onClick={copyAddress}>{addrCopied ? 'Copied' : 'Copy Address'}</button>
        </div>
      </div>

      {/* B. Property identity */}
      <section className="nx-di25-identity">
        <h2>{address || 'Property unknown'}</h2>
        <div className="nx-di25-identity__meta">
          {property?.market ? <span className="nx-di25-badge">{property.market}</span> : null}
          {property?.property_type ? <span className="nx-di25-badge is-type">{property.property_type}</span> : null}
          {unitsLabel ? <span className="nx-di25-badge">{unitsLabel}</span> : null}
          {property?.condition ? <span className="nx-di25-badge is-condition">{property.condition}</span> : null}
        </div>
        {visibleFlags.length ? (
          <div className="nx-di25-flags">
            {visibleFlags.map((flag) => <span key={flag} className="nx-di25-flag">{flag}</span>)}
            {overflowCount > 0 ? <span className="nx-di25-flag is-overflow">+{overflowCount}</span> : null}
          </div>
        ) : null}
      </section>

      {/* C. Decision hero */}
      <section className="nx-di25-hero">
        <div className="nx-di25-hero__head">
          <div className="nx-di25-hero__score">
            <span>Acquisition Score</span>
            <strong>{fmtScore(snap?.acquisition_score) ?? '—'}</strong>
          </div>
          {engineAvailable && snap?.decision_tier ? (
            <span className="nx-di25-tier">{snap.decision_tier.replace(/_/g, ' ')}</span>
          ) : (
            <span className="nx-di25-tier is-baseline">Baseline Intelligence</span>
          )}
        </div>

        <div className="nx-di25-baseline">
          <span className="nx-di25-baseline__label">{baseline?.label || 'Baseline Property Intelligence'}</span>
          <div className="nx-di25-baseline__grid">
            <ScoreChip label="Acq" value={fmtScore(baseline?.acquisition_score)} tone="heat" />
            <ScoreChip label="Strength" value={fmtScore(baseline?.deal_strength_score)} tone="strength" />
            <ScoreChip label="Motivation" value={fmtScore(baseline?.motivation_score)} tone="motivation" />
            <ScoreChip label="Distress" value={fmtScore(baseline?.distress_score)} tone="distress" />
            <ScoreChip label="AI" value={fmtScore(baseline?.ai_score)} tone="ai" />
          </div>
        </div>

        <div className="nx-di25-hero__metrics">
          <div className="nx-di25-metric-tile">
            <span>Value</span>
            <strong>{fmtMoney(snap?.value) ?? '—'}</strong>
          </div>
          <div className="nx-di25-metric-tile">
            <span>Equity</span>
            <strong>{fmtMoney(snap?.equity_amount) ?? fmtPct(snap?.equity_percentage) ?? '—'}</strong>
          </div>
          <div className="nx-di25-metric-tile">
            <span>Repairs</span>
            <strong>{fmtMoney(snap?.repair_estimate) ?? '—'}</strong>
          </div>
          <div className="nx-di25-metric-tile">
            <span>Risk</span>
            <strong className="is-risk">{snap?.largest_risk?.label ?? '—'}</strong>
          </div>
        </div>

        {engineAvailable ? (
          <div className="nx-di25-engine-results">
            <div className="nx-di25-engine-results__offer">
              <span>Recommended Cash Offer</span>
              <strong>{fmtMoney(snap?.recommended_cash_offer) ?? '—'}</strong>
            </div>
            <GlassRow label="Valuation Range" value={
              snap?.valuation_range?.low || snap?.valuation_range?.high
                ? `${fmtMoney(snap.valuation_range.low) ?? '—'} – ${fmtMoney(snap.valuation_range.high) ?? '—'}`
                : null
            } />
            <GlassRow label="Best Strategy" value={snap?.best_strategy} />
            <GlassRow label="Assignment Fee" value={fmtMoney(snap?.expected_assignment_fee)} />
            <GlassRow label="Confidence" value={snap?.confidence ? `${snap.confidence}%` : null} />
            <GlassRow label="Buyer Demand / Liquidity" value={
              snap?.buyer_demand_score || snap?.liquidity_score
                ? `${snap.buyer_demand_score ?? '—'} / ${snap.liquidity_score ?? '—'}`
                : null
            } />
            {snap?.engine_computed_at ? (
              <div className="nx-di25-engine-ts">Engine run {String(snap.engine_computed_at).slice(0, 16).replace('T', ' ')}</div>
            ) : null}
          </div>
        ) : (
          <div className="nx-di25-engine-cta">
            <p>Full Decision Engine Not Run</p>
            <button type="button" className="nx-di25-engine-btn" disabled={engineRunning} onClick={() => void runDecisionEngine()}>
              {engineRunning ? 'Running Full Engine…' : 'Run Full Decision Engine'}
            </button>
          </div>
        )}

        {engineRunning ? (
          <div className="nx-di25-engine-overlay">
            <div className="nx-di25-engine-overlay__panel">
              <span className="nx-di25-engine-overlay__title">Decision Engine</span>
              <ul>
                {engineProgress.map((step) => (
                  <li key={step.stage} className={cls(step.status === 'done' && 'is-done', step.status === 'running' && 'is-running')}>
                    {step.label}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <div className="nx-di25-next-action">
          <span>Next Action</span>
          <strong>{snap?.recommended_next_action ?? 'Review property intelligence'}</strong>
        </div>
      </section>

      {/* Visible snapshot strip */}
      <section className="nx-deal-compact-summary">
        <div className="nx-deal-compact-summary__metrics nx-di25-snapshot-strip">
          <div className="nx-di25-strip-item">
            <span>Buyer Market</span>
            <strong className={cls('nx-di25-signal', dossier?.buyer_market?.signal ? `is-${String(dossier.buyer_market.signal).toLowerCase().replace(/\s+/g, '-')}` : false)}>
              {String(dossier?.buyer_market?.signal || 'Resolving…')}
            </strong>
          </div>
          <div className="nx-di25-strip-item">
            <span>Owner Priority</span>
            <strong>{fmtScore(snap?.owner_priority ?? (owner?.priority_score as number | undefined)) ?? '—'}</strong>
          </div>
          <div className="nx-di25-strip-item">
            <span>Comps</span>
            <strong>{dossier?.comps?.comp_count ? formatInteger(dossier.comps.comp_count as number) : '—'}</strong>
          </div>
          <div className="nx-di25-strip-item">
            <span>Strategy</span>
            <strong>{snap?.best_strategy ?? (engineAvailable ? '—' : 'Run Engine')}</strong>
          </div>
        </div>
      </section>

      {/* Visible seller strip */}
      <section className="nx-di25-seller-strip">
        <div className="nx-di25-seller-strip__head">
          <strong>{String(owner?.display_name || prospect?.name || 'Seller')}</strong>
          {owner?.owner_type ? <span className="nx-di25-badge">{String(owner.owner_type)}</span> : null}
        </div>
        <div className="nx-di25-seller-strip__grid">
          <GlassRow label="Phone" value={String(phone?.number || '')} />
          <GlassRow label="Age" value={prospect?.age ? String(prospect.age) : null} />
          <GlassRow label="Occupation" value={String(prospect?.occupation || prospect?.occupation_group || '')} />
          <GlassRow label="Income" value={String(prospect?.household_income || '')} />
          <GlassRow label="Contactability" value={owner?.contactability_score ? `${owner.contactability_score}` : null} tone="good" />
          <GlassRow label="Contact Window" value={String(owner?.contact_window || prospect?.contact_window || phone?.contact_window || '')} />
          <GlassRow label="Portfolio" value={fmtMoney(owner?.portfolio_value as number | undefined)} />
          <GlassRow label="Ownership" value={owner?.ownership_years ? `${Math.round(Number(owner.ownership_years))} yrs` : null} />
        </div>
      </section>

      {/* Visible property detail strip */}
      <section className="nx-di25-property-strip">
        <div className="nx-di25-property-strip__grid">
          <GlassRow label="Beds / Baths" value={property?.bedrooms || property?.bathrooms ? `${property?.bedrooms ?? '—'} / ${property?.bathrooms ?? '—'}` : null} />
          <GlassRow label="Sq Ft" value={property?.square_feet ? formatInteger(property.square_feet) : null} />
          <GlassRow label="Year Built" value={property?.year_built} />
          <GlassRow label="Loan Balance" value={fmtMoney(property?.loan_balance) ?? (property?.loan_balance === 0 ? '$0' : null)} />
          <GlassRow label="Ownership" value={property?.ownership_years ? `${Math.round(property.ownership_years)} yrs` : null} />
        </div>
      </section>

      {/* Accordions for supporting detail */}
      <DetailSection title="Market & Buyers">
        <GlassRow label="Coverage Level" value={String(dossier?.buyer_market?.geographic_level_used || '')} />
        <GlassRow label="Buyers" value={dossier?.buyer_market?.buyer_count ? formatInteger(dossier.buyer_market.buyer_count as number) : null} />
        <GlassRow label="Purchases" value={dossier?.buyer_market?.purchase_count ? formatInteger(dossier.buyer_market.purchase_count as number) : null} />
        <GlassRow label="Corporate" value={dossier?.buyer_market?.corporate_buyer_count ? formatInteger(dossier.buyer_market.corporate_buyer_count as number) : null} />
        <GlassRow label="Median Price" value={fmtMoney(dossier?.buyer_market?.median_purchase_price as number | undefined)} />
        <GlassRow label="PPSF" value={dossier?.buyer_market?.ppsf ? `$${Math.round(Number(dossier.buyer_market.ppsf))}` : null} />
        <GlassRow label="Liquidity" value={dossier?.buyer_market?.liquidity_score ? String(dossier.buyer_market.liquidity_score) : null} />
        <GlassRow label="Velocity" value={dossier?.buyer_market?.velocity_score ? String(dossier.buyer_market.velocity_score) : null} />
        {dossier?.buyer_market?.status === 'no_coverage' && Array.isArray(dossier.buyer_market.fallback_attempted) ? (
          <div className="nx-di25-fallback-note">Attempted: {(dossier.buyer_market.fallback_attempted as string[]).join(' → ')}</div>
        ) : null}
      </DetailSection>

      <DetailSection title="Comps">
        <GlassRow label="Comp Count" value={dossier?.comps?.comp_count as number | undefined} />
        <GlassRow label="Weighted Usable" value={dossier?.comps?.weighted_comp_count as number | undefined} />
        <GlassRow label="Median Sale" value={fmtMoney(dossier?.comps?.median_sale as number | undefined)} />
        <GlassRow label="PPSF / PPU" value={
          dossier?.comps?.median_ppsf
            ? `$${Math.round(Number(dossier.comps.median_ppsf))} PPSF`
            : dossier?.comps?.median_ppu
              ? `$${Math.round(Number(dossier.comps.median_ppu))} PPU`
              : null
        } />
        <GlassRow label="Range" value={
          dossier?.comps?.valuation_low || dossier?.comps?.valuation_high
            ? `${fmtMoney(dossier.comps.valuation_low as number) ?? '—'} – ${fmtMoney(dossier.comps.valuation_high as number) ?? '—'}`
            : null
        } />
        <GlassRow label="Confidence" value={dossier?.comps?.confidence ? `${dossier.comps.confidence}%` : null} />
        {(dossier?.comps?.records as Array<Record<string, unknown>> | undefined)?.slice(0, 4).map((comp) => (
          <div key={String(comp.id)} className="nx-di25-comp-card">
            <strong>{String(comp.address || 'Comp')}</strong>
            <span>{fmtMoney(comp.sale_price as number)} · {comp.sale_date ? String(comp.sale_date).slice(0, 10) : '—'}</span>
          </div>
        ))}
      </DetailSection>

      <DetailSection title="Seller & Owner Detail">
        <GlassRow label="Prospect" value={String(prospect?.name || '')} />
        <GlassRow label="Net Assets" value={String(prospect?.net_asset_value || '')} />
        <GlassRow label="Language" value={String(prospect?.language || '')} />
        <GlassRow label="Portfolio Equity" value={fmtMoney(owner?.portfolio_equity as number | undefined)} />
        <GlassRow label="Units" value={owner?.total_units ? String(owner.total_units) : null} />
        <GlassRow label="Seller Tags" value={String(owner?.seller_tags || '')} />
      </DetailSection>

      <DetailSection title="Activity">
        {(dossier?.activity_timeline || []).slice(0, 6).map((event) => (
          <GlassRow key={`${event.type}-${event.timestamp}`} label={String(event.label || event.type)} value={String(event.timestamp || '').slice(0, 16).replace('T', ' ')} />
        ))}
      </DetailSection>

      {dossier?.census?.status === 'not_loaded' ? (
        <div className="nx-di25-census-empty">{String(dossier.census.label || 'Census enrichment not loaded')}</div>
      ) : null}
    </div>
  )
}