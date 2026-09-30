/**
 * ANALYTICS · THE INTELLIGENCE LAB (desktop).
 *
 *   Level 0  the environment (the desktop backdrop under the pane)
 *   Level 1  the workspace plane: header · context bar · breadcrumb · mode
 *   Level 2  the metric inspector (right, collapsible)
 *   Level 3  filter builder / pickers (popovers)
 *   Level 4  VIEW RECORDS
 *
 * One server registry, one engine, one analytical context (in the URL). The
 * phone keeps its own Analytics surface; this renders only on the modern desktop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { LabRegistry, MetricDef, RecordCohort } from '../../../domain/analytics/analytics-lab-api'
import { fetchLabOverview, fetchLabRegistry } from '../../../domain/analytics/analytics-lab-api'
import { contextKey, useLabContext, useLabData } from './lab-state'
import { LabContextBar } from './LabContextBar'
import { LabOverview } from './LabOverview'
import { MetricInspector } from './MetricInspector'
import { RecordsDrawer } from './RecordsDrawer'
import { MODES, ModeAcquisition, ModeAutomation, ModeBuyers, ModeCampaigns, ModeCommunications, ModeFinancial, ModeGeography, ModePipeline } from './LabModes'
import { cls } from './LabUi'
import { fmtRangeShort } from './charts/chart-kit'
import './analytics-lab.css'

const readTheme = () => (typeof document === 'undefined' ? 'dark' : document.documentElement.getAttribute('data-nexus-theme') || 'dark')

export function AnalyticsLab() {
  const [ctx, act] = useLabContext()
  const [theme, setTheme] = useState(readTheme)
  const [inspect, setInspect] = useState<string | null>(null)
  const [records, setRecords] = useState<{ cohort: RecordCohort; title: string } | null>(null)
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    return () => mo.disconnect()
  }, [])

  const reg = useLabData<LabRegistry>('registry', (signal) => fetchLabRegistry(signal))
  const registry = reg.data
  const defs = useMemo<Record<string, MetricDef>>(() => Object.fromEntries((registry?.metrics || []).map((m) => [m.id, m])), [registry])
  const dims = useMemo(() => registry?.dimensions || {}, [registry])
  const ovKey = `ov|${contextKey({ ...ctx, mode: 'overview', groupBy: null })}`
  const ov = useLabData(ovKey, (signal) => fetchLabOverview({ ...ctx, groupBy: null }, signal))
  const data = ov.data

  const onRecords = useCallback((cohort: RecordCohort, title: string) => setRecords({ cohort, title }), [])
  const onInspect = useCallback((id: string) => setInspect(id), [])

  const period = data ? fmtRangeShort(data.period.start, data.period.end, ctx.tz) : ''
  const modeProps = { ctx, act, defs, dims, overview: data, theme, onInspect, onRecords }
  const failed = ov.error && !data

  return (
    <div className={cls('alab', inspect && 'has-inspector', ov.loading && data && 'is-refreshing')} data-theme={theme}>
      <div className="alab__main">
        <header className="alab-head">
          <div className="alab-head__title">
            <span className="lab-eyebrow"><i className={cls('lab-live', ov.loading && 'is-syncing')} />Analytics · the intelligence lab</span>
            <h1>{ctx.segment.length ? ctx.segment[ctx.segment.length - 1].label || ctx.segment[ctx.segment.length - 1].value : 'The machine'}</h1>
            <p>{data ? <>{period} · {data.strip[0]?.cur.value !== null && data.strip[0]?.cur.value !== undefined ? `${data.strip[0].cur.value.toLocaleString('en-US')} sellers reached` : ''}{data.metrics.reply_rate?.cur.value !== null && data.metrics.reply_rate?.cur.value !== undefined ? ` · ${(data.metrics.reply_rate.cur.value * 100).toFixed(1)}% replied` : ''} · definitions {data.version}</> : reg.error ? `Registry unavailable (${reg.error})` : 'Reading the machine…'}</p>
          </div>
          <nav className="alab-modes" role="tablist" aria-label="Analysis mode">
            {MODES.map((m) => (
              <button key={m.key} type="button" role="tab" aria-selected={ctx.mode === m.key} className={cls(ctx.mode === m.key && 'is-on', 'badge' in m && m.badge === 'unavailable' && 'is-unavailable')} onClick={() => act.setMode(m.key)} title={'badge' in m ? m.badge : undefined}>
                {m.label}{'badge' in m ? <em>{m.badge}</em> : null}
              </button>
            ))}
          </nav>
        </header>

        <LabContextBar ctx={ctx} act={act} registry={registry} envelope={data} loading={ov.loading} onRefresh={ov.reload} />

        {ctx.segment.length ? (
          <nav className="alab-crumbs" aria-label="Analytical breadcrumb">
            <button type="button" onClick={() => act.popSegmentTo(0)}><Icon name="globe" />All</button>
            {ctx.segment.map((s, i) => (
              <span key={`${s.dim}-${i}`} className="alab-crumbs__step">
                <Icon name="chevron-right" />
                <button type="button" onClick={() => act.popSegmentTo(i + 1)} className={cls(i === ctx.segment.length - 1 && 'is-here')} title={dims[s.dim]?.label}>
                  <em>{dims[s.dim]?.label || s.dim}</em>{s.label || s.value}
                </button>
              </span>
            ))}
            <button type="button" className="alab-crumbs__clear" onClick={() => act.popSegmentTo(Math.max(0, ctx.segment.length - 1))} aria-label="Up one level"><Icon name="arrow-down-left" />Up</button>
          </nav>
        ) : null}

        <main className="alab-body">
          {failed ? (
            <div className="lab-empty is-error">
              <Icon name="alert-circle" />
              <b>Analytics couldn’t load</b>
              <p>{ov.error}. Nothing is shown rather than estimated numbers.</p>
              <button type="button" className="lab-ctl" onClick={ov.reload}><Icon name="refresh-cw" />Try again</button>
            </div>
          ) : !data || !registry ? (
            <div className="alab-boot" aria-busy="true"><i /><i /><i /><span>Reading the machine’s telemetry…</span></div>
          ) : ctx.mode === 'overview' ? <LabOverview ctx={ctx} act={act} data={data} defs={defs} dims={dims} onInspect={onInspect} onRecords={onRecords} />
            : ctx.mode === 'acquisition' ? <ModeAcquisition {...modeProps} />
              : ctx.mode === 'pipeline' ? <ModePipeline {...modeProps} />
                : ctx.mode === 'campaigns' ? <ModeCampaigns {...modeProps} />
                  : ctx.mode === 'communications' ? <ModeCommunications {...modeProps} />
                    : ctx.mode === 'geography' ? <ModeGeography {...modeProps} />
                      : ctx.mode === 'automation' ? <ModeAutomation {...modeProps} />
                        : ctx.mode === 'buyers' ? <ModeBuyers {...modeProps} />
                          : <ModeFinancial />}
        </main>
      </div>

      {inspect && registry ? (
        <MetricInspector
          id={inspect} ctx={ctx} act={act} registry={registry} envelope={data}
          known={data?.metrics[inspect] || null}
          onClose={() => setInspect(null)} onRecords={onRecords} onInspect={onInspect}
        />
      ) : null}
      {records ? <RecordsDrawer ctx={ctx} cohort={records.cohort} title={records.title} onClose={() => setRecords(null)} /> : null}
    </div>
  )
}

export default AnalyticsLab
