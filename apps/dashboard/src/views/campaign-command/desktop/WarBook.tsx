import { memo, useMemo } from 'react'
import { LCEmpty, LCError, LCRail, LCSkeleton, LCStatus, LCTooltip } from '../../../shared/lc'
import { readCoverage } from '../composer/composer-api'
import type { ComposerCoverage, CoverageMarket, CoverageStatus } from '../composer/composer-types'
import type { BookCampaign, CampaignIntel } from './war-room-api'
import { useResource } from './war-room-hooks'
import type { Mission } from './war-room-model'
import { coverageMarkets, instrumentOf, lifecycleSteps, pct } from './war-book'
import './war-book.css'

/**
 * CAMPAIGN BOOK planes (R8.3): the lifecycle rail, the room instrument and
 * Sender Coverage. Read-only. Coverage is the canonical routing engine's
 * answer (GET /composer?part=coverage → readAudienceSenderCoverage) for this
 * campaign's audience markets — the same read the Composer's Delivery layer
 * uses; nothing here routes, reserves or sends.
 */

const nf = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'))

export const LifecycleRail = memo(function LifecycleRail({ status, mission, book }: { status: string | null; mission: Mission; book: BookCampaign | null }) {
  const steps = useMemo(() => lifecycleSteps(status, mission, book), [status, mission, book])
  return <LCRail steps={steps} label="Campaign lifecycle" compact className="cc3-life" />
})

export const RoomInstrument = memo(function RoomInstrument({ book, intel, loading }: { book: BookCampaign | null; intel: CampaignIntel | null; loading: boolean }) {
  const i = useMemo(() => instrumentOf(book, intel), [book, intel])
  const healthWord = { ok: 'Healthy', attn: 'Watch', crit: 'At risk', neutral: 'Too early' }[i.health]
  const cells: Array<{ key: string; label: string; value: string; sub?: string; hint: string; tone?: 'crit' | 'attn' }> = [
    { key: 'today', label: 'Sent today', value: nf(i.sentToday), hint: 'Sellers a message left us for today' },
    { key: 'sent', label: 'Sellers reached', value: nf(i.sent), hint: 'Sellers a message left us for, all time' },
    { key: 'delivery', label: 'Delivery', value: pct(i.deliveryRate), sub: i.delivered !== null ? `${nf(i.delivered)} delivered` : undefined, hint: 'Carrier-confirmed delivered ÷ sellers reached' },
    { key: 'reply', label: 'Reply rate', value: pct(i.replyRate), sub: i.replied !== null ? `${nf(i.replied)} replied` : undefined, hint: 'Sellers who replied ÷ sellers delivered' },
    { key: 'filtered', label: 'Carrier filtered', value: nf(i.filtered), hint: i.filtered === null ? 'Arrives with the campaign’s delivery read' : 'Messages the carrier filtered', tone: i.filtered && i.sent && i.filtered / i.sent > 0.05 ? 'attn' : undefined },
    { key: 'optout', label: 'Opt-outs', value: nf(i.optOut), sub: i.optOutRate !== null ? pct(i.optOutRate) : undefined, hint: 'Sellers who asked to stop', tone: i.optOutRate !== null && i.optOutRate > 0.05 ? 'crit' : i.optOutRate !== null && i.optOutRate > 0.02 ? 'attn' : undefined },
    { key: 'held', label: 'Held from cohort', value: nf(i.held), hint: 'Targets held out (suppression, DNC, no sender, quarantine)' },
  ]
  return (
    <section className="cc3-inst-room" aria-label="Campaign instrument" data-health={i.health} aria-busy={loading || undefined}>
      <div className="cc3-inst-room__health">
        <span className="cc3-inst-room__eyebrow">Health</span>
        <LCStatus tone={i.health === 'neutral' ? 'neutral' : i.health} label={healthWord} />
        <small>{i.healthWhy}</small>
      </div>
      <ul className="cc3-inst-room__cells">
        {cells.map((c) => (
          <li key={c.key} data-tone={c.tone}>
            <LCTooltip content={c.hint}>
              <span className="cc3-inst-room__cell" tabIndex={0}>
                <small>{c.label}</small>
                <b className="lc-num">{c.value}</b>
                {c.sub ? <em className="lc-num">{c.sub}</em> : null}
              </span>
            </LCTooltip>
          </li>
        ))}
      </ul>
    </section>
  )
})

/* ── Sender Coverage ───────────────────────────────────────────────────── */

const COVERAGE_TONE: Record<CoverageStatus, 'ok' | 'exec' | 'attn' | 'crit'> = { LOCAL: 'ok', REGIONAL: 'exec', DEGRADED: 'attn', UNCOVERED: 'crit' }
const COVERAGE_WORD: Record<CoverageStatus, string> = { LOCAL: 'Local', REGIONAL: 'Regional', DEGRADED: 'Degraded', UNCOVERED: 'Uncovered' }

async function loadCoverage(key: string, signal: AbortSignal): Promise<ComposerCoverage> {
  const r = await readCoverage(JSON.parse(key), signal)
  if (!r.ok) throw new Error(r.message || r.error)
  return r.data
}

function CoverageRow({ m }: { m: CoverageMarket }) {
  const reasons = m.unavailable.flatMap((u) => u.reasons.map((r) => r.reason))
  const why = reasons.length ? `${reasons.length} number${reasons.length === 1 ? '' : 's'} unavailable: ${[...new Set(reasons)].slice(0, 3).join(', ').replace(/_/g, ' ')}` : null
  return (
    <li className="cc3-cov__row" data-cov={m.coverage}>
      <span className="cc3-cov__market"><b>{m.label || m.market}</b><small>{m.serving_pool ? `served by ${m.serving_pool}${m.serving_tier ? ` · ${m.serving_tier}` : ''}` : 'no serving pool'}</small></span>
      <LCStatus tone={COVERAGE_TONE[m.coverage]} label={COVERAGE_WORD[m.coverage]} quiet={m.coverage === 'LOCAL'} />
      <span className="cc3-cov__num lc-num" title="Healthy numbers serving this market">{nf(m.healthy_numbers)}<small> nums</small></span>
      <span className="cc3-cov__num lc-num" title="Daily capacity of those numbers">{nf(m.daily_capacity)}<small>/day</small></span>
      <span className="cc3-cov__num lc-num" title="Targets in this market">{nf(m.targets)}<small> targets</small></span>
      {why ? <span className="cc3-cov__why">{why}</span> : null}
    </li>
  )
}

export const CoveragePlane = memo(function CoveragePlane({ markets, enabled }: { markets: Record<string, number> | null; enabled: boolean }) {
  const list = useMemo(() => coverageMarkets(markets), [markets])
  const key = list.length ? JSON.stringify(list) : null
  const cov = useResource('cc3-coverage', key, loadCoverage, { pollMs: 300_000, enabled: enabled && Boolean(key) })
  const data = cov.data
  const counts = useMemo(() => {
    const c: Record<CoverageStatus, number> = { LOCAL: 0, REGIONAL: 0, DEGRADED: 0, UNCOVERED: 0 }
    for (const m of data?.markets ?? []) c[m.coverage] += m.targets
    return c
  }, [data])
  const total = data?.totals.targets ?? 0
  return (
    <section className="cc3-plane cc3-cov" aria-label="Sender coverage">
      <header className="cc3-cov__head">
        <span className="cc3-cov__title">Sender coverage</span>
        <span className="cc3-cov__engine">{data ? (data.engine === 'sender_routing_v2' ? 'Sender Routing 2.0' : data.engine === 'legacy_router' ? 'Legacy router' : 'Routing engine') : 'Routing engine'} · audience markets</span>
      </header>
      {!markets ? (
        <LCSkeleton shape="rows" count={3} label="Audience markets loading" />
      ) : !list.length ? (
        <LCEmpty compact title="No audience markets" body="The audience read carries no market for these targets." />
      ) : !enabled ? (
        <LCEmpty compact title="Coverage not read" body="Demo data is on screen, so the routing engine is not asked." />
      ) : cov.error && !data ? (
        <LCError compact what="Coverage didn’t load" detail={cov.error} onRetry={cov.refresh} />
      ) : !data ? (
        <LCSkeleton shape="rows" count={3} label="Coverage loading" />
      ) : (
        <>
          <div className="cc3-cov__sum">
            <span className="cc3-cov__big lc-num">{nf(data.totals.distinct_healthy_numbers)}<small> healthy numbers</small></span>
            <span className="cc3-cov__big lc-num">{nf(data.totals.distinct_daily_capacity)}<small> sends / day</small></span>
            {total > 0 ? (
              <span className="cc3-cov__bar" role="img" aria-label={`Targets by coverage: ${(Object.keys(counts) as CoverageStatus[]).map((k) => `${COVERAGE_WORD[k]} ${counts[k]}`).join(', ')}`}>
                {(Object.keys(counts) as CoverageStatus[]).map((k) => counts[k] ? <i key={k} data-cov={k} style={{ flexGrow: counts[k] }} title={`${COVERAGE_WORD[k]} · ${nf(counts[k])} targets`} /> : null)}
              </span>
            ) : null}
          </div>
          <ul className="cc3-cov__list lc-scroll">
            {data.markets.map((m) => <CoverageRow key={`${m.market_id ?? m.market}`} m={m} />)}
          </ul>
          {data.v2_preview ? <p className="cc3-cov__note">{data.v2_preview.label}</p> : null}
        </>
      )}
    </section>
  )
})
