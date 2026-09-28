/**
 * SELLER SIGNAL + MARKET PULSE.
 *
 * Seller signal is a deterministic read of the actual conversation
 * (conversation_signal_v1: response speed, volume, words, timing, urgency /
 * distress / hostility lexicons, stated prices). Every point shown comes with
 * the factor and, where there is one, the message that earned it. It is a
 * heuristic, and the card says so.
 *
 * Market pulse is recorded sales near the property for the same asset family
 * (deal_market_demand over the sold-comps model) — independent of Buyer Match.
 */
import { useState } from 'react'
import { Icon } from '../../../../shared/icons'
import type { DealDecision } from '../../../../domain/deal-intelligence/deal-decision-api'
import { ago, money, shortDate } from '../../../../domain/deal-intelligence/deal-decision-api'
import { cls, DdCard } from './dd-primitives'

const BAND: Record<string, { label: string; tone: string }> = {
  hot: { label: 'Hot', tone: 'var(--dd-crit)' },
  warm: { label: 'Warm', tone: 'var(--dd-high)' },
  engaged: { label: 'Engaged', tone: 'var(--dd-med)' },
  lukewarm: { label: 'Lukewarm', tone: 'var(--dd-wait)' },
  cold: { label: 'Cold', tone: 'var(--dd-low)' },
  hostile: { label: 'Hostile', tone: 'var(--dd-stop)' },
  opted_out: { label: 'Opted out', tone: 'var(--dd-stop)' },
  no_reply: { label: 'No reply yet', tone: 'var(--dd-low)' },
}

const minutes = (m: number | null | undefined) => {
  if (m === null || m === undefined) return '—'
  if (m < 1) return '<1m'
  if (m < 60) return `${Math.round(m)}m`
  if (m < 60 * 24) return `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`
  return `${Math.round(m / 1440)}d`
}

/** Semicircle gauge; the arc sweeps in and glows in the band colour. */
function Gauge({ score, tone }: { score: number | null; tone: string }) {
  const v = Math.max(0, Math.min(100, score ?? 0))
  const r = 70
  const len = Math.PI * r
  return (
    <svg className="ddx-gauge" viewBox="0 0 170 98" style={{ ['--g' as string]: tone }} aria-hidden="true">
      <defs>
        <linearGradient id="ddx-gauge-g" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="var(--dd-wait)" />
          <stop offset="0.55" stopColor="var(--dd-med)" />
          <stop offset="1" stopColor="var(--dd-crit)" />
        </linearGradient>
      </defs>
      <path d="M 15 88 A 70 70 0 0 1 155 88" className="ddx-gauge__track" />
      <path d="M 15 88 A 70 70 0 0 1 155 88" className="ddx-gauge__arc" strokeDasharray={len} strokeDashoffset={len * (1 - v / 100)} style={{ ['--len' as string]: len }} />
    </svg>
  )
}

export function SellerSignal({ d }: { d: DealDecision }) {
  const [all, setAll] = useState(false)
  const c = d.conversation
  if (!c) {
    return d.pipeline?.threadKey ? null : (
      <DdCard id="signal" title="Seller signal" icon="activity" meta="no conversation" defaultOpen={false}>
        <p className="ddx-empty">No seller conversation is linked to this property, so there is nothing to read motivation from yet.</p>
      </DdCard>
    )
  }
  const band = BAND[c.band] ?? BAND.cold
  const peak = Math.max(1, ...c.timing.hourBuckets)
  const lang = c.language
  const chips = [
    lang.urgency ? { k: 'Urgency', n: lang.urgency, tone: 'hot' } : null,
    lang.distress.financial ? { k: 'Financial strain', n: lang.distress.financial, tone: 'hot' } : null,
    lang.distress.legal ? { k: 'Legal', n: lang.distress.legal, tone: 'hot' } : null,
    lang.distress.life_event ? { k: 'Life event', n: lang.distress.life_event, tone: 'hot' } : null,
    lang.distress.property_burden ? { k: 'Property burden', n: lang.distress.property_burden, tone: 'hot' } : null,
    lang.priceMentions.length ? { k: 'Prices named', n: lang.priceMentions.length, tone: 'good' } : null,
    lang.positive ? { k: 'Positive', n: lang.positive, tone: 'good' } : null,
    lang.profanity ? { k: 'Profanity', n: lang.profanity, tone: 'warn' } : null,
    lang.hostility ? { k: 'Hostility', n: lang.hostility, tone: 'bad' } : null,
    lang.optOut ? { k: 'Opt-out', n: lang.optOut, tone: 'bad' } : null,
  ].filter(Boolean) as Array<{ k: string; n: number; tone: string }>
  const factors = [...c.factors].sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
  const shown = all ? factors : factors.slice(0, 5)
  const maxPts = Math.max(1, ...factors.map((f) => Math.abs(f.points)))

  return (
    <DdCard id="signal" title="Seller signal" icon="activity" meta={<><b style={{ color: band.tone }}>{band.label}</b> · {c.confidence} confidence</>}>
      <div className="ddx-signal">
        <div className="ddx-signal__gauge">
          <Gauge score={c.score} tone={band.tone} />
          <div className="ddx-signal__score">
            <b>{c.score ?? '—'}</b>
            <span style={{ color: band.tone }}>{band.label}</span>
          </div>
        </div>
        <div className="ddx-signal__stats">
          <div><span>Median reply</span><b>{minutes(c.responsiveness.medianReplyMinutes)}</b></div>
          <div><span>Reply rate</span><b>{c.responsiveness.replyRate !== null ? `${Math.round(c.responsiveness.replyRate * 100)}%` : '—'}</b></div>
          <div><span>Replies</span><b>{c.counts.inbound}{c.counts.distinctInbound < c.counts.inbound ? <small> · {c.counts.distinctInbound} distinct</small> : null}</b></div>
          <div><span>Words / msg</span><b>{c.counts.avgWordsPerInbound ?? '—'}</b></div>
          <div><span>Last reply</span><b>{ago(c.responsiveness.lastInboundAt) ?? '—'}</b></div>
          <div><span>Trend</span><b className={cls(c.responsiveness.trend === 'cooling' && 'is-down', c.responsiveness.trend === 'accelerating' && 'is-up')}>{c.responsiveness.trend ?? '—'}</b></div>
        </div>
      </div>
      {c.responsiveness.awaitingUs ? <div className="ddx-await"><Icon name="clock" /> Seller spoke last — the next move is ours.</div> : null}
      <div className="ddx-hours" aria-label="When the seller replies">
        <div className="ddx-hours__bars">
          {c.timing.hourBuckets.map((n, h) => (
            <i key={h} style={{ height: `${Math.max(6, (n / peak) * 100)}%`, opacity: n ? 1 : 0.25 }} className={cls(h >= 22 || h < 5 ? 'is-night' : h < 9 ? 'is-morning' : h < 17 ? 'is-day' : 'is-evening')} title={`${h}:00 · ${n}`} />
          ))}
        </div>
        <div className="ddx-hours__axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>
        <p className="ddx-note">
          Replies: {Math.round(c.timing.share.workday * 100)}% work hours · {Math.round(c.timing.share.evening * 100)}% evening · {Math.round(c.timing.share.lateNight * 100)}% late night
          {c.timing.timezoneSource === 'utc_fallback' ? ' (UTC — seller timezone unknown)' : ` (${c.timing.timezone?.replace('America/', '').replace('_', ' ')})`}
        </p>
      </div>
      {chips.length ? (
        <div className="ddx-chips">{chips.map((x) => <span key={x.k} className={`is-${x.tone}`}>{x.k}<b>{x.n}</b></span>)}</div>
      ) : null}
      <ul className="ddx-factors">
        {shown.map((f) => (
          <li key={f.key} className={cls(f.points >= 0 ? 'is-plus' : 'is-minus', f.cap !== undefined && 'is-cap')}>
            <div className="ddx-factors__row">
              <span>{f.label}</span>
              <i style={{ width: `${(Math.abs(f.points) / maxPts) * 100}%` }} />
              <b>{f.points > 0 ? `+${f.points}` : f.points}</b>
            </div>
            <em>{f.value}</em>
            {f.evidence?.quote ? <blockquote>“{f.evidence.quote}”<small>{shortDate(f.evidence.at)}</small></blockquote> : null}
          </li>
        ))}
      </ul>
      {factors.length > 5 ? <button type="button" className="ddx-more" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `All ${factors.length} factors`}</button> : null}
      <p className="ddx-note">Deterministic read of {c.counts.inbound} seller and {c.counts.outbound} outbound messages — response speed, volume, timing and language. A heuristic, not a prediction.</p>
    </DdCard>
  )
}

export function MarketPulse({ d }: { d: DealDecision }) {
  const m = d.market
  const mix = d.comps?.buyerMix ?? null
  if (!m || !m.ok) {
    return (
      <DdCard id="market" title="Market pulse" icon="trending-up" meta="unavailable" defaultOpen={false}>
        <p className="ddx-empty">{m?.error === 'subject_not_geocoded' ? 'This property has no coordinates, so nearby sales can’t be measured.' : 'Nearby sales couldn’t be loaded.'}</p>
      </DdCard>
    )
  }
  const o = m.overall
  const ivr = m.investorVsRetail
  const srcMax = Math.max(1, ...m.bySource.map((s) => s.count))
  const trendMax = Math.max(1, ...m.trend.map((t) => t.count))
  const priceVals = m.trend.map((t) => t.medianPrice ?? 0).filter(Boolean)
  const pMin = Math.min(...priceVals) * 0.9
  const pMax = Math.max(...priceVals) * 1.05
  const isMulti = ['multifamily', 'apartment'].includes(m.subject.family)
  const retail = ivr.retail.priced >= ivr.minSample ? ivr.retail : ivr.nonInvestor
  const retailLabel = ivr.retail.priced >= ivr.minSample ? 'Retail / MLS' : 'Non-investor'
  const disc = ivr.retail.priced >= ivr.minSample ? ivr.discountPct : ivr.discountVsNonInvestorPct
  return (
    <DdCard id="market" title="Market pulse" icon="trending-up" meta={`${m.totals.sales} ${m.subject.familyLabel.toLowerCase()} sales · ${m.radius.used} mi`}>
      <div className="ddx-mkt">
        <div className="ddx-mkt__hero">
          <span>Median sale</span>
          <b>{money(o.medianPrice) ?? '—'}</b>
          <em>{o.p25Price && o.p75Price ? `IQR ${money(o.p25Price)}–${money(o.p75Price)}` : `${m.totals.pricedSales} priced sales`}</em>
        </div>
        <div className="ddx-mkt__stats">
          <div><span>Sales</span><b>{m.totals.sales}</b></div>
          <div><span>$/sq ft</span><b>{o.medianPpsf ? `$${Math.round(o.medianPpsf)}` : '—'}</b></div>
          {isMulti ? <div><span>$/unit</span><b>{money(o.medianPpu) ?? '—'}</b></div> : <div><span>Median sq ft</span><b>{o.medianSqft ? Math.round(o.medianSqft).toLocaleString('en-US') : '—'}</b></div>}
        </div>
      </div>
      <p className="ddx-note">
        {m.subject.familyLabel}{m.unitsBand.applied && m.unitsBand.min ? ` (${m.unitsBand.min}–${m.unitsBand.max} units)` : ''} within {m.radius.used} mi{m.radius.widened ? ' (widened to reach enough sales)' : ''}, last {m.window.months} months.
        {m.window.dataThrough ? ` Sales recorded through ${shortDate(m.window.dataThrough)}.` : ''}{m.totals.excludedOutliers ? ` ${m.totals.excludedOutliers} outlier${m.totals.excludedOutliers === 1 ? '' : 's'} excluded.` : ''}
      </p>

      {m.bySource.length ? (
        <div className="ddx-bars">
          <span className="ddx-sub">By source</span>
          {m.bySource.map((s) => (
            <div key={s.source} className="ddx-bars__row">
              <span>{s.label}</span>
              <i style={{ width: `${(s.count / srcMax) * 100}%` }} />
              <b>{s.count}</b>
              <em>{money(s.medianPrice) ?? '—'}{s.medianPpsf ? ` · $${Math.round(s.medianPpsf)}/sf` : ''}</em>
            </div>
          ))}
        </div>
      ) : null}

      <div className="ddx-vs">
        <span className="ddx-sub">What investors pay</span>
        {ivr.investor.priced >= ivr.minSample && retail.priced >= ivr.minSample ? (
          <>
            <div className="ddx-vs__row is-inv"><span>Investors</span><i style={{ width: `${Math.min(100, ((ivr.investor.medianPrice ?? 0) / Math.max(ivr.investor.medianPrice ?? 1, retail.medianPrice ?? 1)) * 100)}%` }} /><b>{money(ivr.investor.medianPrice)}</b></div>
            <div className="ddx-vs__row is-ret"><span>{retailLabel}</span><i style={{ width: `${Math.min(100, ((retail.medianPrice ?? 0) / Math.max(ivr.investor.medianPrice ?? 1, retail.medianPrice ?? 1)) * 100)}%` }} /><b>{money(retail.medianPrice)}</b></div>
            {disc !== null ? <p className="ddx-vs__take"><b>{disc > 0 ? `${Math.round(disc * 100)}% below` : `${Math.round(-disc * 100)}% above`}</b> {retailLabel.toLowerCase()} — investor median {ivr.investor.priced} sales vs {retail.priced}</p> : null}
          </>
        ) : (
          <p className="ddx-note">
            Not enough buyer-identified sales nearby to compare investor and retail prices{o.buyerKnownShare !== null ? ` (${Math.round(o.buyerKnownShare * 100)}% of nearby sales have a buyer on record)` : ''}.
          </p>
        )}
        {mix && mix.total ? (
          <div className="ddx-mix">
            <div className="ddx-mix__bar" aria-hidden="true">
              <i className="is-co" style={{ flex: mix.company || 0.0001 }} />
              <i className="is-ind" style={{ flex: mix.individual || 0.0001 }} />
              <i className="is-unk" style={{ flex: mix.unknown || 0.0001 }} />
            </div>
            <p>
              Pricing comps: <b>{mix.company} of {mix.total}</b> bought by LLCs / entities{mix.companyMedian ? ` (median ${money(mix.companyMedian)})` : ''}
              {mix.individual ? `, ${mix.individual} by individuals${mix.individualMedian ? ` (${money(mix.individualMedian)})` : ''}` : ''}.
              {mix.mls && mix.publicRecord ? ` MLS ${money(mix.mlsMedian)} vs public record ${money(mix.publicRecordMedian)}.` : ''}
            </p>
          </div>
        ) : null}
      </div>

      {m.byBuyer.length && (o.buyerKnownShare ?? 0) > 0 ? (
        <div className="ddx-chips is-buyers">{m.byBuyer.map((b) => <span key={b.group}>{b.label}<b>{b.count}</b></span>)}</div>
      ) : null}

      {m.trend.length > 1 ? (
        <div className="ddx-trend2">
          <span className="ddx-sub">Quarterly volume & median</span>
          <div className="ddx-trend2__plot">
            {m.trend.map((t) => (
              <div key={t.quarter} className="ddx-trend2__col">
                <i style={{ height: `${Math.max(8, (t.count / trendMax) * 100)}%` }} />
                {t.medianPrice ? <em style={{ bottom: `calc(18px + ${(((t.medianPrice - pMin) / (pMax - pMin || 1)) * 62).toFixed(1)}%)` }} title={money(t.medianPrice) ?? ''} /> : null}
                <span>{t.quarter.replace(/^\d{2}(\d{2})-?/, '’$1 ')}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </DdCard>
  )
}
