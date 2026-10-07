import { useEffect, useState } from 'react'
import { LCButton, LCError, LCSheet, LCSkeleton } from '../../../shared/lc'
import { readQualityReport, type IntelResult } from './intelligence-api'
import type { QualityReport } from './intelligence-types'
import { CampaignQualityReport } from './CampaignQualityReport'
import { SellerScreener } from './SellerScreener'
import { SellerIntelligencePanel } from './SellerIntelligencePanel'
import './intelligence.css'

/**
 * The Composer's SELLER INTELLIGENCE section: the Campaign Quality Report for
 * the composition's eligible cohort (same id set as Offer Ready), the Seller
 * Screener sheet and the per-property Seller Intelligence read.
 * Behind SELLER_SCREENER: when the server says it is off, this renders
 * NOTHING. Read-only — it never changes the composition or launches.
 */
export function ComposerIntelligence({ spec, specKey, active }: { spec: Record<string, unknown>; specKey: string; active: boolean }) {
  const [quality, setQuality] = useState<{ key: string; res: IntelResult<QualityReport> } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [screener, setScreener] = useState(false)
  const [property, setProperty] = useState<string | null>(null)
  const key = `${specKey}|${nonce}`
  useEffect(() => {
    if (!active) return
    const ctl = new AbortController()
    readQualityReport({ spec }, ctl.signal).then((res) => { if (!ctl.signal.aborted) setQuality({ key, res }) })
    return () => ctl.abort()
    // spec is derived from specKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active])
  const now = quality?.key === key ? quality.res : null
  // a server with the flag off answers once; from then on the section stays absent
  if (quality && !quality.res.ok && quality.res.off) return null
  if (!active) return null
  const report = now?.ok ? now.data : null
  return (
    <section className="aqi aqi-composer" aria-label="Seller intelligence">
      <header className="aqi-composer__head">
        <div>
          <span className="aqi-eyebrow">Seller intelligence · campaign quality report</span>
          <h3 className="aqi-composer__title">Is this audience worth texting?</h3>
        </div>
        <div className="aqi-composer__actions">
          {report?.fixture ? <span className="aqi-fixture">FIXTURE · offline extract 2026-10-07</span> : null}
          <LCButton size="sm" variant="secondary" icon="filter" onClick={() => setScreener(true)}>Open Seller Screener</LCButton>
        </div>
      </header>
      {!now ? <LCSkeleton shape="lines" count={6} label="Building the quality report" /> : null}
      {now && !now.ok && !now.off ? <LCError what="The quality report didn’t load" detail={now.message} onRetry={() => setNonce((x) => x + 1)} compact /> : null}
      {report ? <CampaignQualityReport report={report} onOpenProperty={setProperty} /> : null}

      <LCSheet open={screener} onOpenChange={setScreener} title="Seller Screener" width={1360} className="aqi-sheet">
        <SellerScreener onClose={() => setScreener(false)} />
      </LCSheet>
      <LCSheet open={property !== null} onOpenChange={(o) => { if (!o) setProperty(null) }} title="Seller intelligence" width={560} className="aqi-sheet">
        {property ? <SellerIntelligencePanel propertyId={property} /> : null}
      </LCSheet>
    </section>
  )
}
