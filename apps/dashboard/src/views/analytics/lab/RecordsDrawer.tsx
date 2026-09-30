/**
 * VIEW RECORDS — the exact records behind a number (Level-4 plane).
 *
 * Server-paginated and server-sorted; the total IS the metric's numerator or
 * denominator for the slice, so the table and the KPI can never disagree.
 * Rows open in their canonical app (Inbox thread, Pipeline opportunity); the
 * whole cohort hands off to Map (focus set) and Entity Graph (explicit
 * property ids, where a campaign can be built with its normal review).
 * Analytics itself never changes anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, CSSProperties, ReactElement } from 'react'
import { List, type RowComponentProps } from 'react-window'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import type { LabContext, LabRecords, RecordCohort } from '../../../domain/analytics/analytics-lab-api'
import { fetchLabRecords, fmtCount } from '../../../domain/analytics/analytics-lab-api'
import { useLabData } from './lab-state'
import { cls, useDismiss } from './LabUi'

const WindowedList = List as ComponentType<Record<string, unknown>>
const ROW_H = 38
const COLS_KEY = 'anx:lab:cols:v1'
const EG_MAX = 400

type Props = { ctx: LabContext; cohort: RecordCohort; title: string; onClose: () => void }

function cellText(v: unknown, type: string) {
  if (v === null || v === undefined || v === '') return '—'
  if (type === 'time') return new Date(String(v)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  if (type === 'bool') return v ? 'Yes' : 'No'
  if (type === 'number') return typeof v === 'number' ? v.toLocaleString('en-US') : String(v)
  return String(v)
}

type RowProps = { rows: LabRecords['rows']; cols: LabRecords['columns']; onOpen: (r: LabRecords['rows'][number]) => void; template: string }
function RecordRow({ index, style, rows, cols, onOpen, template }: RowComponentProps<RowProps>): ReactElement | null {
  const r = rows[index]
  if (!r) return null
  return (
    <div style={{ ...style, gridTemplateColumns: template } as CSSProperties} className="lab-rec__row" role="row">
      {cols.map((c) => <span key={c.id} role="cell" className={cls(`c-${c.type}`)} title={cellText(r[c.id], c.type)}>{cellText(r[c.id], c.type)}</span>)}
      <button type="button" role="cell" className="lab-rec__open" onClick={() => onOpen(r)} aria-label="Open in its app" disabled={!r.thread && !r.oppId}><Icon name="arrow-up-right" /></button>
    </div>
  )
}

export function RecordsDrawer({ ctx, cohort, title, onClose }: Props) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  const [sort, setSort] = useState<{ id: string | null; dir: 'asc' | 'desc' }>({ id: null, dir: 'desc' })
  const [hidden, setHidden] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(COLS_KEY) || '[]')) } catch { return new Set() } })
  const [colsOpen, setColsOpen] = useState(false)
  const colsBtn = useRef<HTMLButtonElement | null>(null)
  const colsPanel = useRef<HTMLDivElement | null>(null)
  useDismiss(colsOpen, () => setColsOpen(false), [colsBtn, colsPanel])
  const key = `rec|${JSON.stringify([cohort, ctx.range, ctx.compare, ctx.filters, ctx.segment, ctx.tz, page, pageSize, sort])}`
  const q = useLabData(key, (signal) => fetchLabRecords(ctx, cohort, { page, pageSize, sort: sort.id, dir: sort.dir }, signal))
  const d = q.data
  useEffect(() => { setPage(1) }, [pageSize, sort.id, sort.dir])
  useEffect(() => { try { localStorage.setItem(COLS_KEY, JSON.stringify([...hidden])) } catch { /* ignore */ } }, [hidden])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !colsOpen) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, colsOpen])
  const cols = useMemo(() => (d?.columns || []).filter((c) => !hidden.has(`${d?.entity}:${c.id}`)), [d, hidden])
  const template = `${cols.map((c) => (c.type === 'time' ? 'minmax(118px,0.9fr)' : c.type === 'number' || c.type === 'bool' ? 'minmax(72px,0.55fr)' : c.id === 'address' || c.id === 'reason' ? 'minmax(180px,1.6fr)' : 'minmax(110px,1fr)')).join(' ')} 40px`
  const open = (r: LabRecords['rows'][number]) => {
    if (r.oppId && (d?.entity === 'transition' || d?.entity === 'opportunity')) pushRoutePath(`/pipeline?opp=${encodeURIComponent(String(r.oppId))}`)
    else if (r.thread) pushRoutePath(`/inbox?thread=${encodeURIComponent(String(r.thread))}`)
    else if (r.oppId) pushRoutePath(`/pipeline?opp=${encodeURIComponent(String(r.oppId))}`)
  }
  const toMap = () => {
    if (!d?.handoff.points.length) return
    if (writeMapFocusSet({ label: `Analytics · ${title}`, tone: 'property', points: d.handoff.points.map((p) => ({ lat: p.lat, lng: p.lng, id: p.id, label: p.label ?? null })) })) pushRoutePath('/map')
  }
  const toEntityGraph = () => {
    if (!d?.handoff.propertyIds.length) return
    const ids = d.handoff.propertyIds.slice(0, EG_MAX)
    const ff = JSON.stringify([{ field_key: 'properties.property_id', operator: 'in', value: ids }])
    pushRoutePath(`/entity-graph?eg_tab=properties&eg_ff=${encodeURIComponent(ff)}`)
  }
  const cohortWords = [
    cohort.part === 'denominator' ? 'denominator' : cohort.part === 'numerator' ? 'numerator' : 'records',
    cohort.window === 'comparison' ? 'comparison window' : 'current period',
    cohort.group ? `${cohort.group.label || cohort.group.key}` : null,
    cohort.bucket ? new Date(cohort.bucket.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null,
    cohort.cell ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][cohort.cell.weekday]} ${String(cohort.cell.hour).padStart(2, '0')}:00 seller-local` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="lab-rec" role="dialog" aria-modal="true" aria-label={`Records: ${title}`}>
      <button type="button" className="lab-rec__scrim" aria-label="Close records" onClick={onClose} />
      <div className="lab-rec__panel">
        <header className="lab-rec__head">
          <div>
            <span className="lab-eyebrow">View records · {cohortWords}</span>
            <h3>{title}</h3>
            <p className="lab-rec__sub">{d ? <><b>{fmtCount(d.total)}</b> {d.entity === 'seller' ? 'sellers' : d.entity === 'message' ? 'messages' : d.entity === 'reply' ? 'replies' : d.entity === 'transition' ? 'pipeline events' : d.entity === 'run' ? 'autopilot runs' : 'records'} — exactly the {cohort.part || 'records'} of the metric for this slice{d.dataAsOf ? ` · as of ${new Date(d.dataAsOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}</> : q.error ? q.error : 'Reading the cohort…'}</p>
          </div>
          <div className="lab-rec__tools">
            <button type="button" className="lab-ctl" onClick={toMap} disabled={!d?.handoff.points.length} title="Light this cohort on the Map (up to 5,000 places)"><Icon name="map" />Map</button>
            <button type="button" className="lab-ctl" onClick={toEntityGraph} disabled={!d?.handoff.propertyIds.length} title={`Open these properties in Entity Graph${(d?.handoff.propertyIds.length || 0) > EG_MAX ? ` (first ${EG_MAX} of ${d?.handoff.propertyIds.length})` : ''}; build a campaign there with its normal review`}><Icon name="grid" />Entity Graph{(d?.handoff.propertyIds.length || 0) > EG_MAX ? ` · first ${EG_MAX}` : ''}</button>
            <span className="lab-pop">
              <button ref={colsBtn} type="button" className={cls('lab-ctl', colsOpen && 'is-on')} onClick={() => setColsOpen((o) => !o)} aria-expanded={colsOpen}><Icon name="layers" />Columns</button>
              {colsOpen && d ? (
                <div ref={colsPanel} className="lab-pop__panel is-right" role="dialog">
                  <ul className="lab-menu">
                    {d.columns.map((c) => {
                      const k = `${d.entity}:${c.id}`
                      const on = !hidden.has(k)
                      return <li key={c.id}><button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => setHidden((h) => { const n = new Set(h); if (on) n.add(k); else n.delete(k); return n })}><span className="lab-menu__check">{on ? <Icon name="check" /> : null}</span><span className="lab-menu__label">{c.label}</span></button></li>
                    })}
                  </ul>
                </div>
              ) : null}
            </span>
            <button type="button" className="lab-ctl is-quiet" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
          </div>
        </header>
        {d?.status && d.status !== 'ok' && d.reason ? <p className="lab-note">{d.reason}</p> : null}
        <div className={cls('lab-rec__table', q.loading && 'is-refreshing')} role="table" aria-rowcount={d?.total}>
          <div className="lab-rec__row is-head" role="row" style={{ gridTemplateColumns: template } as CSSProperties}>
            {cols.map((c) => (
              <button key={c.id} type="button" role="columnheader" aria-sort={sort.id === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => setSort((s) => ({ id: c.id, dir: s.id === c.id && s.dir === 'desc' ? 'asc' : 'desc' }))} className={cls(sort.id === c.id && 'is-sorted', `c-${c.type}`)}>
                {c.label}{sort.id === c.id ? <i aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</i> : null}
              </button>
            ))}
            <span />
          </div>
          <div className="lab-rec__body">
            {d && d.rows.length ? (
              <WindowedList style={{ height: '100%', width: '100%' }} rowCount={d.rows.length} rowHeight={ROW_H} overscanCount={8} rowComponent={RecordRow} rowProps={{ rows: d.rows, cols, onOpen: open, template }} />
            ) : d && !q.loading ? <p className="lab-note lab-rec__none">No records in this cohort.</p> : null}
          </div>
        </div>
        <footer className="lab-rec__foot">
          <span>{d ? `${fmtCount((d.page - 1) * d.pageSize + (d.rows.length ? 1 : 0))}–${fmtCount((d.page - 1) * d.pageSize + d.rows.length)} of ${fmtCount(d.total)}` : ''}</span>
          <label>Rows <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>{[50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <button type="button" className="lab-ctl is-quiet" disabled={!d || d.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page"><Icon name="chevron-left" /></button>
          <span>Page {d?.page ?? page} of {d?.pages ?? '…'}</span>
          <button type="button" className="lab-ctl is-quiet" disabled={!d || d.page >= d.pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><Icon name="chevron-right" /></button>
          <span className="lab-rec__ro"><Icon name="eye" />Read-only · rows open in their own app</span>
        </footer>
      </div>
    </div>
  )
}
