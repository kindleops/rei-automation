/**
 * ANALYTICS 4.0 — shared read hooks (each one canonical query, shared through
 * the store) and the metric formatters the sections pass to their charts.
 *
 * THE BUYER CORPUS'S WINDOW.
 *
 * Recorded buyer purchases come from a corpus with a DATA-THROUGH date (in
 * production, Jul 28) that ends before the seller data. When the analysed
 * period lies (partly) after it, the period's buyer figures are "not yet
 * recorded", never zero. To still show where buyer demand IS, the Lab reads
 * the corpus's own latest 90 days and labels it as such — a different window,
 * named, never presented as current.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LabQuery, MetricDef } from '../../../domain/analytics/analytics-lab-api'
import { fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import type { BuyersResult, MoneyResult, StagesResult } from './intel-model'
import type { IntelContext } from './intel-state'
import { serverContext } from './intel-state'

const DAY = 86_400_000

export type BuyerWindow = {
  /** the period's own figures (may be "not yet recorded") */
  period: BuyersResult | null
  /** figures to draw demand with: the period's when it is covered, else the corpus's latest 90 days */
  shown: BuyersResult | null
  window: 'period' | 'latest' | null
  start: string | null
  end: string | null
  through: string | null
  loading: boolean
  error: string | null
}

export function useBuyerWindow(ctx: IntelContext, enabled = true): BuyerWindow {
  const q1 = useIntel<LabQuery>(enabled ? paths.query(serverContext(ctx, { metric: 'reply_rate', groupBy: null }), 'buyers') : null)
  const period = (q1.data?.result as unknown as BuyersResult | null) || null
  const through = period?.dataThrough || null
  const needLatest = Boolean(period && through && period.coverage !== 'full')
  // the latest 90 recorded days, ending the day after DATA THROUGH (the end instant is exclusive)
  const end = through ? new Date(Date.parse(`${through.slice(0, 10)}T00:00:00Z`) + DAY).toISOString() : null
  const start = end ? new Date(Date.parse(end) - 90 * DAY).toISOString() : null
  const q2 = useIntel<LabQuery>(enabled && needLatest && start && end
    ? paths.query(serverContext({ ...ctx, filters: [], segment: [], range: { preset: 'custom', start, end }, compare: { mode: 'previous' } }, { metric: 'reply_rate', groupBy: null }), 'buyers')
    : null)
  const latest = (q2.data?.result as unknown as BuyersResult | null) || null
  return {
    period,
    shown: needLatest ? latest : period,
    window: !period ? null : needLatest ? 'latest' : 'period',
    start: needLatest ? start : null,
    end: needLatest ? end : null,
    through,
    loading: q1.loading || (needLatest && q2.loading),
    error: q1.error || q2.error,
  }
}

export const fmtThrough = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—')

/** Stage evidence (period) + the canonical pipeline read model (now). */
export function usePipelineData() {
  const { ctx } = useLab()
  const stagesQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: 'stage_advancements', groupBy: null }), 'stages'))
  const moneyQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: 'reply_rate', groupBy: null }), 'money'))
  return {
    stagesQ, moneyQ,
    stages: (stagesQ.data?.result as unknown as StagesResult | null) || null,
    money: (moneyQ.data?.result as unknown as MoneyResult | null) || null,
  }
}

export const metricFormat = (def: MetricDef | undefined) => (v: number | null) => fmtMetric(def, v)
export const metricTick = (def: MetricDef | undefined) => (v: number) => (def?.unit === 'rate' ? `${Math.round(v * 100)}%` : def?.unit === 'duration_min' ? `${Math.round(v)}m` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v * 10) / 10))

/** The live content width of an element (ResizeObserver; state set only from the observer). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect()
    ro.current = null
    if (!el) return
    ro.current = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width || 0)
      setW((prev) => (Math.abs(prev - next) >= 1 ? next : prev))
    })
    ro.current.observe(el)
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])
  return [ref, w]
}
