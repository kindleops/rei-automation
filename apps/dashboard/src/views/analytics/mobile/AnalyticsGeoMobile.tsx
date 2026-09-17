import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import {
  loadKpiDashboardSummary,
  loadKpiTimeSeries,
  loadMarketPerformance,
  loadStatePerformance,
  STATE_NAMES,
  type KpiFilters,
  type KpiSummary,
  type KpiTimeRange,
  type MarketPerformance,
  type StatePerformance,
  type TimeSeriesPoint,
} from '../../../lib/data/kpiDashboardData'
import { GeoChoropleth } from './GeoChoropleth'
import { TouchTrendChart } from './TouchTrendChart'
import {
  GEO_METRICS,
  MIN_VOLUME_FOR_RATE,
  getGeoMetric,
  metricCount,
  metricRate,
  type GeoMetricId,
} from './geo-metric'
import './analytics-geo-mobile.css'

/**
 * KPI INTELLIGENCE — the geographic drill-down (§7).
 *
 * What mobile got before this was `MetricsRail25`: the war room's 25% desktop KPI
 * rail, which is a vertical stack of tiles and no map at all. Correct as a narrow
 * desktop pane, and not an intelligence surface on a phone.
 *
 * The model here is the one §7 specifies — UNITED STATES → STATE → MARKET → METRIC —
 * with the map as the primary instrument rather than a thumbnail. One selected metric
 * drives the choropleth, the trend and every row, so drilling never changes the
 * question being asked, only the geography it is asked of.
 *
 * Every number comes from ONE endpoint (/api/cockpit/metrics/war-room) whose
 * `source_audit` names the table behind each metric. Nothing here is computed from a
 * constant, and a metric the endpoint reports as unavailable is absent rather than
 * zero — the fabricated `stateData` that used to feed the old USA map is exactly what
 * this replaces.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const RANGES: Array<{ id: KpiTimeRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'last_7_days', label: '7d' },
  { id: 'last_30_days', label: '30d' },
]

const pct = (value: number | null | undefined) =>
  value == null ? '—' : `${Math.round(value * 10) / 10}%`

const int = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString()

export const AnalyticsGeoMobile = () => {
  const [range, setRange] = useState<KpiTimeRange>('last_7_days')
  const [metricId, setMetricId] = useState<GeoMetricId>('sent')
  const [selectedState, setSelectedState] = useState<string | null>(null)
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null)

  const [summary, setSummary] = useState<KpiSummary | null>(null)
  const [states, setStates] = useState<StatePerformance[]>([])
  const [markets, setMarkets] = useState<MarketPerformance[]>([])
  const [series, setSeries] = useState<TimeSeriesPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const metric = getGeoMetric(metricId)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    const filters: KpiFilters = { timeRange: range }

    void Promise.all([
      loadKpiDashboardSummary(filters),
      loadStatePerformance(filters),
      loadMarketPerformance(filters),
      loadKpiTimeSeries(filters),
    ])
      .then(([nextSummary, nextStates, nextMarkets, nextSeries]) => {
        if (!live) return
        setSummary(nextSummary)
        setStates(nextStates)
        setMarkets(nextMarkets)
        setSeries(nextSeries)
        /**
         * The summary carries its own failure reason. Surfacing it is the difference
         * between "the business was quiet" and "the metrics service could not be
         * read" — the loader already refuses to return zeroes for an outage, and
         * this refuses to render them as an empty state.
         */
        setError(nextSummary.unavailable ? `Metrics unavailable — ${nextSummary.unavailable}.` : null)
      })
      .catch((err: unknown) => {
        if (!live) return
        setError(err instanceof Error ? err.message : 'Metrics could not be read.')
      })
      .finally(() => { if (live) setLoading(false) })

    return () => { live = false }
  }, [range])

  /** Drilling out of a state must drop the market with it. */
  const selectState = useCallback((abbr: string | null) => {
    setSelectedState(abbr)
    setSelectedMarket(null)
  }, [])

  const stateRow = useMemo(
    () => states.find((row) => row.state === selectedState) ?? null,
    [states, selectedState],
  )

  const stateMarkets = useMemo(
    () => markets
      .filter((row) => !selectedState || row.state === selectedState)
      .sort((left, right) => metricCount(right, metric) - metricCount(left, metric)),
    [markets, selectedState, metric],
  )

  const marketRow = useMemo(
    () => markets.find((row) => row.market === selectedMarket) ?? null,
    [markets, selectedMarket],
  )

  const rankedStates = useMemo(
    () => [...states].sort((left, right) => metricCount(right, metric) - metricCount(left, metric)),
    [states, metric],
  )

  const level: 'nation' | 'state' | 'market' =
    selectedMarket ? 'market' : selectedState ? 'state' : 'nation'

  const nationalValue = summary
    ? Number(summary[metric.countKey === 'sent' ? 'sentCount'
      : metric.countKey === 'delivered' ? 'deliveredCount'
        : metric.countKey === 'replied' ? 'repliedCount'
          : metric.countKey === 'positive' ? 'positiveReplies'
            : 'optOutCount'] ?? NaN)
    : NaN

  return (
    <div className="geo" data-analytics="geo-mobile" data-level={level}>
      <header className="geo__bar">
        <nav className="geo__crumbs" aria-label="Geographic scope">
          <button type="button" className={cls(level === 'nation' && 'is-current')} onClick={() => selectState(null)}>
            United States
          </button>
          {selectedState ? (
            <>
              <i aria-hidden>/</i>
              <button
                type="button"
                className={cls(level === 'state' && 'is-current')}
                onClick={() => setSelectedMarket(null)}
              >
                {STATE_NAMES[selectedState] ?? selectedState}
              </button>
            </>
          ) : null}
          {selectedMarket ? (
            <>
              <i aria-hidden>/</i>
              <span className="is-current">{selectedMarket.replace(/,\s*[A-Z]{2}$/, '')}</span>
            </>
          ) : null}
        </nav>

        <div className="geo__ranges" role="group" aria-label="Time range">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={cls(range === option.id && 'is-active')}
              aria-pressed={range === option.id}
              onClick={() => setRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {/* The metric rail drives EVERY level below it. */}
      <div className="geo__metrics" role="tablist" aria-label="Metric">
        {GEO_METRICS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={metricId === option.id}
            className={cls('geo__metric', metricId === option.id && 'is-active', option.inverse && 'is-inverse')}
            onClick={() => setMetricId(option.id)}
          >
            {option.shortLabel}
          </button>
        ))}
      </div>

      <div className="geo__scroll">
        {error ? (
          <div className="geo__state is-error" role="status">
            <strong>Metrics unavailable</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {level !== 'market' ? (
          <GeoChoropleth
            states={states}
            metric={metric}
            selectedState={selectedState}
            onSelectState={selectState}
            loading={loading && states.length === 0}
          />
        ) : null}

        {/* ── The headline for the current scope ──────────────────────────── */}
        <section className="geo__headline">
          {level === 'nation' ? (
            <>
              <span>{metric.label} · nationwide</span>
              <strong>{Number.isFinite(nationalValue) ? int(nationalValue) : '—'}</strong>
              <small>
                {states.length > 0
                  ? `${states.length} ${states.length === 1 ? 'state' : 'states'} with activity`
                  : loading ? 'Reading state activity…' : 'No state-level activity in this window'}
              </small>
            </>
          ) : level === 'state' && stateRow ? (
            <>
              <span>{metric.label} · {stateRow.stateName}</span>
              <strong>{int(metricCount(stateRow, metric))}</strong>
              <small>
                {stateMarkets.length} {stateMarkets.length === 1 ? 'market' : 'markets'}
                {stateRow.topMarket && stateRow.topMarket !== '—' ? ` · top ${stateRow.topMarket}` : ''}
              </small>
            </>
          ) : level === 'market' && marketRow ? (
            <>
              <span>{metric.label} · {marketRow.market}</span>
              <strong>{int(metricCount(marketRow, metric))}</strong>
              <small>{marketRow.state}</small>
            </>
          ) : (
            <>
              <span>{metric.label}</span>
              <strong>—</strong>
              <small>No data for this scope in this window</small>
            </>
          )}
        </section>

        {/* ── Rate, with an honest volume gate ────────────────────────────── */}
        {metric.rateKey ? (
          <section className="geo__rate">
            {(() => {
              const row = level === 'market' ? marketRow : level === 'state' ? stateRow : null
              if (level === 'nation') {
                const value = metric.rateKey === 'deliveryRate' ? summary?.deliveryRate
                  : metric.rateKey === 'replyRate' ? summary?.replyRate
                    : metric.rateKey === 'positiveRate' ? summary?.positiveRate
                      : summary?.optOutRate
                return (
                  <div className="geo__rate-row">
                    <span>{metric.rateLabel}</span>
                    <b>{pct(value)}</b>
                  </div>
                )
              }
              if (!row) return null
              const rate = metricRate(row, metric)
              return (
                <div className="geo__rate-row">
                  <span>{metric.rateLabel}</span>
                  {rate != null ? <b>{pct(rate)}</b> : (
                    /* A 100% reply rate on two sends is arithmetically correct and
                       operationally false. Below the volume floor the rate is
                       withheld and the reason is given. */
                    <em>Not enough volume ({int(row.sent)} sent, needs {MIN_VOLUME_FOR_RATE})</em>
                  )}
                </div>
              )
            })()}
          </section>
        ) : null}

        {/* ── Trend, nationwide only: the endpoint publishes ONE series ───── */}
        {level === 'nation' ? (
          <section className="geo__section">
            <h4>Daily trend</h4>
            <TouchTrendChart points={series} metric={metric} loading={loading && series.length === 0} />
            <p className="geo__note">
              Drag across the chart to read any day. The series is nationwide — the
              war-room endpoint publishes one daily series, not one per state.
            </p>
          </section>
        ) : null}

        {/* ── The drill list ──────────────────────────────────────────────── */}
        {level === 'nation' ? (
          <section className="geo__section">
            <h4>States</h4>
            {rankedStates.length === 0 ? (
              <p className="geo__empty">
                {loading ? 'Reading state activity…' : 'No state reported activity in this window.'}
              </p>
            ) : (
              <div className="geo__rows">
                {rankedStates.map((row) => (
                  <button key={row.state} type="button" className="geo__row" onClick={() => selectState(row.state)}>
                    <span className="geo__row-abbr">{row.state}</span>
                    <span className="geo__row-copy">
                      <strong>{row.stateName}</strong>
                      <small>{row.topMarket !== '—' ? row.topMarket : 'No market named'}</small>
                    </span>
                    <span className="geo__row-value">
                      <b>{int(metricCount(row, metric))}</b>
                      {metric.rateKey ? <em>{metricRate(row, metric) != null ? pct(metricRate(row, metric)) : '—'}</em> : null}
                    </span>
                    <Icon name="chevron-right" size={13} />
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {level === 'state' ? (
          <section className="geo__section">
            <h4>Markets</h4>
            {stateMarkets.length === 0 ? (
              <p className="geo__empty">
                No market inside {STATE_NAMES[selectedState ?? ''] ?? selectedState} reported activity in this window.
              </p>
            ) : (
              <div className="geo__rows">
                {stateMarkets.map((row) => (
                  <button
                    key={row.market}
                    type="button"
                    className="geo__row"
                    onClick={() => setSelectedMarket(row.market)}
                  >
                    <span className="geo__row-copy">
                      <strong>{row.market}</strong>
                      <small>{row.recommendation !== 'No Data' ? row.recommendation : 'No recommendation'}</small>
                    </span>
                    <span className="geo__row-value">
                      <b>{int(metricCount(row, metric))}</b>
                      {metric.rateKey ? <em>{metricRate(row, metric) != null ? pct(metricRate(row, metric)) : '—'}</em> : null}
                    </span>
                    <Icon name="chevron-right" size={13} />
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {/* ── Market detail: every metric at once, for one market ─────────── */}
        {level === 'market' && marketRow ? (
          <>
            <section className="geo__section">
              <h4>Delivery</h4>
              <div className="geo__strip">
                <div><span>Sent</span><b>{int(marketRow.sent)}</b></div>
                <div><span>Delivered</span><b>{int(marketRow.delivered)}</b></div>
                <div><span>Replies</span><b>{int(marketRow.replied)}</b></div>
              </div>
              <div className="geo__strip">
                <div><span>Positive</span><b>{int(marketRow.positive)}</b></div>
                <div><span>Opt-outs</span><b>{int(marketRow.optOut)}</b></div>
                <div><span>Delivery</span><b>{metricRate(marketRow, getGeoMetric('delivered')) != null ? pct(marketRow.deliveryRate) : '—'}</b></div>
              </div>
            </section>

            <section className="geo__section">
              <h4>What is working here</h4>
              <dl className="geo__facts">
                <div><dt>Recommendation</dt><dd>{marketRow.recommendation}</dd></div>
                <div><dt>State</dt><dd>{STATE_NAMES[marketRow.state] ?? marketRow.state}</dd></div>
              </dl>
              {!metricRate(marketRow, metric) && metric.rateKey ? (
                <p className="geo__note">
                  Rates are withheld below {MIN_VOLUME_FOR_RATE} sends. This market has
                  {` ${int(marketRow.sent)}`}.
                </p>
              ) : null}
            </section>
          </>
        ) : null}

        {summary?.lastUpdated ? (
          <p className="geo__stamp">
            Read {new Date(summary.lastUpdated).toLocaleString()} · one endpoint, source-audited
          </p>
        ) : null}
      </div>
    </div>
  )
}
