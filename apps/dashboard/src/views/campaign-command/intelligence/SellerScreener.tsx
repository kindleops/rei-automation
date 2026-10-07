import { useEffect, useMemo, useState } from 'react'
import { LCButton, LCError, LCIconButton, LCSegmented, LCSelect, LCSkeleton, LCTabs, LCTooltip, cx, type LCSelectOption } from '../../../shared/lc'
import { readDiscovery, readScreenerCatalog, runScreener, type IntelResult } from './intelligence-api'
import {
  RANK_SOURCE_LABEL, SOURCE_LABEL, TIER_ORDER, TIER_SHORT, buildExpression, catalogReason, coverageVerdict, fmtN, histogramBars, opNeedsValue, opsForType, share, situationLabel,
  type BuilderRow,
} from './intelligence-model'
import type { CatalogMetric, DiscoveryResult, Histogram, ScreenerCatalog, ScreenerOp, ScreenerResult } from './intelligence-types'
import { SellerIntelligencePanel } from './SellerIntelligencePanel'
import './intelligence.css'

/**
 * SELLER SCREENER (Acquisition OS §69 / §13) + CAMPAIGN DISCOVERY (§16).
 * Read-only: builds a stacked-targeting expression over the metrics the
 * server exposes (a metric below its production coverage threshold is shown
 * disabled with its coverage, never silently offered), runs it, and shows
 * who matched, where, how they score and why. MI never launches anything —
 * there is no launch here (§68).
 */

let seq = 0
const rid = () => `r${(seq += 1)}`

const DEFAULT_ALL: Array<Omit<BuilderRow, 'id'>> = [
  { metric: 'state', op: 'in', value: 'TX' },
  { metric: 'opportunity_tier', op: 'in', value: 'A, B' },
  { metric: 'equity_percent', op: 'gte', value: '35' },
  { metric: 'mobile_reachable', op: 'is_true', value: '' },
  { metric: 'days_since_outbound', op: 'gte', value: '90' },
]
const DEFAULT_ANY: Array<Omit<BuilderRow, 'id'>> = [
  { metric: 'tax_pain', op: 'gte', value: '30' },
  { metric: 'landlord_fatigue', op: 'gte', value: '50' },
]

const STATES = ['TX', 'FL', 'MN', 'CA', 'AZ', 'GA', 'IL', 'MO', 'IN', 'PA', 'NV', 'OH', 'TN', 'NC']
type Tab = 'results' | 'discovery'
type Asset = 'all' | 'sfr' | 'mf_2_4' | 'mf_5_plus'

function Hist({ title, h }: { title: string; h: Histogram }) {
  const bars = histogramBars(h.buckets)
  const total = h.buckets.reduce((a, b) => a + b.n, 0)
  return (
    <section className="aqi-block">
      <h4 className="aqi-eyebrow">{title}</h4>
      <div className="aqi-hist" role="img" aria-label={`${title} histogram`}>
        {bars.map((b) => (
          <LCTooltip key={b.lo} content={`${b.lo}–${b.hi}: ${share(b.n, total).text}`}>
            <span className="aqi-hist__col"><i style={{ height: `${Math.max(b.n ? 4 : 0, b.h * 100)}%` }} /><em className="aqi-num">{b.lo}</em></span>
          </LCTooltip>
        ))}
      </div>
      {h.unknown ? <p className="aqi-foot">Unknown: <span className="aqi-num">{fmtN(h.unknown)}</span></p> : null}
    </section>
  )
}

function RowEditor({ row, catalog, onChange, onRemove }: { row: BuilderRow; catalog: CatalogMetric[]; onChange: (r: BuilderRow) => void; onRemove: () => void }) {
  const metric = catalog.find((m) => m.key === row.metric) ?? null
  const options: LCSelectOption[] = catalog.map((m) => ({
    value: m.key,
    label: m.label,
    group: SOURCE_LABEL[m.source] ?? m.source,
    hint: m.coverage ? share(m.coverage.known, m.coverage.total).pct ?? undefined : 'not measured',
    disabled: !m.exposed,
  }))
  const ops = opsForType(metric?.type ?? 'text')
  return (
    <li className={cx('aqi-cond', metric && !metric.exposed && 'is-off')}>
      <LCSelect value={row.metric} onChange={(v) => { const m = catalog.find((x) => x.key === v); onChange({ ...row, metric: v, op: opsForType(m?.type ?? 'text')[0].value, value: '' }) }} options={options} label="Metric" variant="field" size="sm" menuWidth={300} />
      <LCSelect value={row.op} onChange={(v) => onChange({ ...row, op: v as ScreenerOp })} options={ops.map((o) => ({ value: o.value, label: o.label }))} label="Operator" variant="field" size="sm" />
      {opNeedsValue(row.op) ? (
        <input className="aqi-input aqi-num" value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} aria-label={`${metric?.label ?? 'Value'} value`} placeholder={metric?.type === 'number' ? '0–100' : 'a, b'} inputMode={metric?.type === 'number' ? 'decimal' : 'text'} />
      ) : <span className="aqi-cond__fill" />}
      <LCIconButton icon="x" label="Remove condition" size="sm" onClick={onRemove} />
      {metric ? <LCTooltip content={metric.exposed ? coverageVerdict(metric.coverage ? { ...metric.coverage, threshold: metric.threshold, exposed: true } : null) : catalogReason(metric) ?? ''}><span className={cx('aqi-cond__cov aqi-num', !metric.exposed && 'is-attn')}>{metric.coverage ? share(metric.coverage.known, metric.coverage.total).pct : '—'}</span></LCTooltip> : null}
    </li>
  )
}

export function SellerScreener({ onClose }: { onClose?: () => void }) {
  const [catalog, setCatalog] = useState<IntelResult<ScreenerCatalog> | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    const ctl = new AbortController()
    readScreenerCatalog(ctl.signal).then((r) => { if (!ctl.signal.aborted) setCatalog(r) })
    return () => ctl.abort()
  }, [nonce])
  const [all, setAll] = useState<BuilderRow[]>(() => DEFAULT_ALL.map((r) => ({ ...r, id: rid() })))
  const [any, setAny] = useState<BuilderRow[]>(() => DEFAULT_ANY.map((r) => ({ ...r, id: rid() })))
  const [result, setResult] = useState<{ running: boolean; res: IntelResult<ScreenerResult> | null }>({ running: false, res: null })
  const [tab, setTab] = useState<Tab>('results')
  const [selected, setSelected] = useState<string | null>(null)
  const [scope, setScope] = useState<{ state: string; asset: Asset }>({ state: 'TX', asset: 'all' })
  const [disc, setDisc] = useState<{ key: string; res: IntelResult<DiscoveryResult> } | null>(null)
  const discKey = `${scope.state}|${scope.asset}`
  useEffect(() => {
    if (tab !== 'discovery') return
    const ctl = new AbortController()
    readDiscovery({ state: scope.state, asset: scope.asset === 'all' ? undefined : scope.asset, limit: 20 }, ctl.signal).then((r) => { if (!ctl.signal.aborted) setDisc({ key: discKey, res: r }) })
    return () => ctl.abort()
  }, [tab, discKey, scope.state, scope.asset])

  const metrics = useMemo(() => (catalog?.ok ? catalog.data.metrics : []), [catalog])
  const expression = useMemo(() => buildExpression(all, any, metrics), [all, any, metrics])
  const blocked = metrics.length ? [...all, ...any].filter((r) => metrics.find((m) => m.key === r.metric && !m.exposed)) : []

  const run = () => {
    setResult({ running: true, res: result.res })
    runScreener({ expression, max_scan: 25000, seller_limit: 40 }).then((res) => setResult({ running: false, res }))
  }

  if (catalog && !catalog.ok && catalog.off) {
    return <div className="aqi aqi-scr is-off"><p className="aqi-muted">Seller Screener is off (SELLER_SCREENER).</p></div>
  }
  const r = result.res?.ok ? result.res.data : null
  const fixture = Boolean((catalog?.ok && catalog.data.fixture) || r?.fixture || (disc?.res.ok && disc.res.data.fixture))
  const discNow = disc?.key === discKey ? disc.res : null

  return (
    <div className="aqi aqi-scr" aria-label="Seller Screener">
      <header className="aqi-scr__head">
        <div>
          <span className="aqi-eyebrow">Seller Screener · stacked targeting</span>
          <h2 className="aqi-scr__title">Who should we contact, where, and why</h2>
          {catalog?.ok ? <p className="aqi-foot aqi-num">Coverage measured on {fmtN(catalog.data.coverage_sample.rows)} sellers · {catalog.data.coverage_sample.method}</p> : null}
        </div>
        <div className="aqi-scr__headr">
          {fixture ? <span className="aqi-fixture">FIXTURE · offline extract 2026-10-07</span> : null}
          <LCTabs<Tab> items={[{ id: 'results', label: 'Screener', count: r?.matched ?? null }, { id: 'discovery', label: 'Discovery' }]} value={tab} onChange={setTab} label="Screener view" />
          {onClose ? <LCIconButton icon="close" label="Close Screener" onClick={onClose} /> : null}
        </div>
      </header>

      {tab === 'results' ? (
        <div className={cx('aqi-scr__body', selected && 'has-inspector')}>
          <aside className="aqi-builder" aria-label="Conditions">
            {!catalog ? <LCSkeleton shape="lines" count={6} label="Reading metric coverage" /> : !catalog.ok ? (
              <LCError what="Metric coverage didn’t load" detail={catalog.off ? undefined : catalog.message} onRetry={() => setNonce((x) => x + 1)} compact />
            ) : (
              <>
                <span className="aqi-sub">All of</span>
                <ul className="aqi-conds">{all.map((row) => <RowEditor key={row.id} row={row} catalog={metrics} onChange={(n) => setAll((xs) => xs.map((x) => (x.id === row.id ? n : x)))} onRemove={() => setAll((xs) => xs.filter((x) => x.id !== row.id))} />)}</ul>
                <LCButton size="sm" variant="ghost" icon="plus" onClick={() => setAll((xs) => [...xs, { id: rid(), metric: 'market_quality', op: 'gte', value: '' }])}>Add condition</LCButton>
                <div className="aqi-anygroup">
                  <span className="aqi-sub">…and any of</span>
                  <ul className="aqi-conds">{any.map((row) => <RowEditor key={row.id} row={row} catalog={metrics} onChange={(n) => setAny((xs) => xs.map((x) => (x.id === row.id ? n : x)))} onRemove={() => setAny((xs) => xs.filter((x) => x.id !== row.id))} />)}</ul>
                  <LCButton size="sm" variant="ghost" icon="plus" onClick={() => setAny((xs) => [...xs, { id: rid(), metric: 'tax_pain', op: 'gte', value: '' }])}>Add alternative</LCButton>
                </div>
                {blocked.length ? <p className="aqi-foot is-attn">{blocked.length} condition{blocked.length === 1 ? '' : 's'} use a metric below its coverage threshold — the server will refuse it.</p> : null}
                <LCButton variant="primary" icon="filter" onClick={run} loading={result.running} block>Screen sellers</LCButton>
                <p className="aqi-foot aqi-muted">Read-only. Unknown values never match and are counted separately.</p>
              </>
            )}
          </aside>

          <section className="aqi-results" aria-label="Screener results">
            {!result.res && !result.running ? <p className="aqi-muted aqi-results__idle">Set the conditions, then screen. Nothing is read until you do.</p> : null}
            {result.running && !r ? <LCSkeleton shape="lines" count={8} label="Screening sellers" /> : null}
            {result.res && !result.res.ok && !result.res.off ? (
              <LCError what={result.res.error === 'metric_not_exposed' ? 'A metric is below its coverage threshold' : 'The screener didn’t run'} detail={result.res.refused?.map((x) => `${x.metric}: ${x.reason}`).join(' · ') || result.res.message} onRetry={run} compact />
            ) : null}
            {r ? (
              <>
                <div className="aqi-kpis">
                  <div><span>Matched</span><b className="aqi-num">{fmtN(r.matched)}</b><em className="aqi-num">of {fmtN(r.scanned)} scanned{r.truncated ? ' · scan capped' : ''}</em></div>
                  {TIER_ORDER.map((t) => <div key={t}><span>{TIER_SHORT[t]}</span><b className={cx('aqi-num', `is-tier-${t}`)}>{fmtN(r.tiers[t] ?? 0)}</b><em className="aqi-num">{share(r.tiers[t] ?? 0, r.matched).pct ?? '—'}</em></div>)}
                  <div><span>Excluded · unknown</span><b className="aqi-num">{fmtN(r.unknown_rows)}</b><em>{Object.entries(r.unknown_excluded).map(([k, v]) => `${metrics.find((m) => m.key === k)?.label ?? k} ${fmtN(v)}`).join(' · ') || '—'}</em></div>
                </div>
                <div className="aqi-results__grid">
                  <section className="aqi-block">
                    <h4 className="aqi-eyebrow">ZIP distribution</h4>
                    <table className="aqi-table">
                      <thead><tr><th>ZIP</th><th>Market</th><th className="is-n">Sellers</th><th className="is-n">Tier A</th><th className="is-n">Known equity</th><th className="is-n">H / L / ?</th><th>Market quality</th></tr></thead>
                      <tbody>{r.zips.slice(0, 10).map((z) => (
                        <tr key={z.zip}><td className="aqi-num">{z.zip}</td><td>{z.market ?? '—'}</td><td className="is-n aqi-num">{fmtN(z.count)}</td><td className="is-n aqi-num">{fmtN(z.tier_a)}</td><td className="is-n aqi-num">{z.median_equity_percent_known === null ? 'unknown' : `${Math.round(z.median_equity_percent_known)}% · n ${fmtN(z.equity_known ?? 0)}`}</td><td className="is-n aqi-num">{z.equity_class ? `${fmtN(z.equity_class.high)} / ${fmtN(z.equity_class.low)} / ${fmtN(z.equity_class.unknown)}` : '—'}</td><td><span className={cx('aqi-mq', `is-${z.market_label}`)}>{z.market_quality ?? '—'} · {z.market_label}</span></td></tr>
                      ))}</tbody>
                    </table>
                  </section>
                  <div className="aqi-results__side">
                    <Hist title="Rank v2 score (within tier)" h={r.score_distribution.rank_score} />
                    <Hist title="Forced-sale pressure" h={r.score_distribution.forced_sale_pressure} />
                  </div>
                </div>
                <section className="aqi-block">
                  <h4 className="aqi-eyebrow">Top sellers · v2 order</h4>
                  <ul className="aqi-sellers">
                    {r.sellers.slice(0, 24).map((s) => (
                      <li key={s.property_id}>
                        <button type="button" className={cx('aqi-seller', selected === s.property_id && 'is-selected')} onClick={() => setSelected(s.property_id)} aria-pressed={selected === s.property_id}>
                          <span className={cx('aqi-tier', `is-${s.tier}`)}>{s.tier === 'UNKNOWN' ? '?' : s.tier}</span>
                          <span className="aqi-seller__main">
                            <b>{situationLabel(s.seller_situation)}</b>
                            <em className="aqi-num">{s.market ?? '—'} · {s.zip ?? '—'} · {s.property_type ?? '—'}</em>
                          </span>
                          <span className="aqi-seller__rank aqi-num">{s.rank?.score === null || s.rank?.score === undefined ? '—' : s.rank.score.toFixed(1)}<em>{s.rank ? RANK_SOURCE_LABEL[s.rank.rank_source] : ''}</em></span>
                          <span className="aqi-why">{s.why.slice(0, 5).map((w) => <span key={w.code} className={cx('aqi-why__chip', `is-${w.kind}`)}>{w.label}</span>)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            ) : null}
          </section>

          {selected ? (
            <aside className="aqi-inspector" aria-label="Seller intelligence">
              <div className="aqi-inspector__bar"><span className="aqi-eyebrow">Seller intelligence</span><LCIconButton icon="close" label="Close seller intelligence" size="sm" onClick={() => setSelected(null)} /></div>
              <SellerIntelligencePanel propertyId={selected} />
            </aside>
          ) : null}
        </div>
      ) : (
        <div className="aqi-disc">
          <div className="aqi-disc__bar">
            <LCSelect value={scope.state} onChange={(v) => setScope((s) => ({ ...s, state: v }))} options={STATES.map((s) => ({ value: s, label: s }))} label="State" prefix="State" variant="quiet" size="sm" />
            <LCSegmented<Asset> options={[{ value: 'all', label: 'All' }, { value: 'sfr', label: 'SFR' }, { value: 'mf_2_4', label: 'MF 2–4' }, { value: 'mf_5_plus', label: 'MF 5+' }]} value={scope.asset} onChange={(a) => setScope((s) => ({ ...s, asset: a }))} label="Asset" size="sm" />
            <span className="aqi-foot aqi-muted">Ranked by (tier A + ½ tier B) × ZIP market quality, reachable sellers only. Discovery never launches anything.</span>
          </div>
          {!discNow ? <LCSkeleton shape="lines" count={8} label="Ranking ZIPs" /> : !discNow.ok ? (
            discNow.off ? <p className="aqi-muted">Seller Screener is off (SELLER_SCREENER).</p> : <LCError what="Discovery didn’t load" detail={discNow.message} compact />
          ) : (
            <>
              <p className="aqi-foot aqi-num">{fmtN(discNow.data.zips_considered)} ZIP × asset lanes considered · {fmtN(discNow.data.scanned)} sellers scanned{discNow.data.truncated ? ' · scan capped' : ''}</p>
              <ol className="aqi-disc__list">
                {discNow.data.zips.map((z, i) => (
                  <li key={`${z.zip}|${z.asset}`} className="aqi-zipc">
                    <span className="aqi-zipc__rank aqi-num">{String(i + 1).padStart(2, '0')}</span>
                    <div className="aqi-zipc__main">
                      <b>{z.market ?? z.state} <span className="aqi-num">{z.zip}</span> <em>{z.asset.replace(/_/g, ' ')}</em></b>
                      <p>{z.headline.split(' · ').slice(1).join(' · ')}</p>
                    </div>
                    <dl className="aqi-zipc__terms aqi-num">
                      <div><dt>Tier A</dt><dd className="is-tier-A">{fmtN(z.tiers.A)}</dd></div>
                      <div><dt>Tier B</dt><dd>{fmtN(z.tiers.B)}</dd></div>
                      <div><dt>Reachable</dt><dd>{fmtN(z.reachable)}</dd></div>
                      <div><dt>High contact</dt><dd>{z.contact_high === undefined ? '—' : fmtN(z.contact_high)}</dd></div>
                      <div><dt>Known equity</dt><dd>{z.median_equity_percent_known === null ? 'unknown' : `${Math.round(z.median_equity_percent_known)}%`}</dd></div>
                      <div><dt>Liquidity</dt><dd>{z.market_terms?.liquidity ?? '—'}</dd></div>
                      <div><dt>Buyers</dt><dd>{z.market_terms?.buyer_depth ?? '—'}</dd></div>
                      <div><dt>Investor</dt><dd>{z.market_terms?.investor_activity ?? '—'}</dd></div>
                      <div><dt>Quality</dt><dd className={cx(`is-${z.market_label}`)}>{z.market_quality ?? 'assumed 50'}</dd></div>
                      <div><dt>Score</dt><dd className="is-score">{z.discovery_score.toFixed(1)}</dd></div>
                    </dl>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  )
}
