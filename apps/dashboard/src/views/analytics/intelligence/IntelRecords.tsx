/**
 * THE RECORDS — the exact rows behind a number (Level 4, a bottom drawer).
 *
 * The total IS the metric's numerator or denominator for the slice (the same
 * engine set), so a KPI and its records can never disagree. Server-sorted,
 * read in pages of 200 as the grid scrolls (up to 2,000 rows here; Entity
 * Graph and Map take the whole cohort). Rows open in their own app — a
 * conversation in Inbox, a deal in Pipeline, an autopilot run in Workflow
 * Studio. Analytics itself never changes anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LabRecords, RecordCohort } from '../../../domain/analytics/analytics-lab-api'
import { LCButton, LCDataGrid, LCIconButton, cx } from '../../../shared/lc'
import type { LCColumn, LCSort } from '../../../shared/lc'
import { pushRoutePath } from '../../../app/router'
import { sound } from '../../../shared/sound'
import { handleObjectClick, objectMenuEntries, showOnMap } from '../../../modules/desktop/objects'
import { handoffPointObject, recordRowObject } from './intel-objects'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { fmtInt } from './intel-format'
import { serverContext } from './intel-state'
import { sellerAutomationPath } from './intel-model'

const PAGE = 200
const EG_MAX = 400
const NOUN: Record<string, string> = { seller: 'sellers', message: 'messages', reply: 'replies', transition: 'pipeline events', run: 'autopilot runs', offer: 'offers', closing: 'closing cases' }
const COHORT_OF: Record<string, string> = { sellers_reached: 'reached', reached_replied: 'replied', interested_sellers: 'interested', opted_out_sellers: 'opted_out', opportunity_rate: 'opportunity' }
type Row = LabRecords['rows'][number]

function cell(v: unknown, type: string, tz: string) {
  if (v === null || v === undefined || v === '') return <span className="ix-muted">—</span>
  if (type === 'time') return new Date(String(v)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })
  if (type === 'bool') return v ? 'Yes' : 'No'
  if (type === 'number') return typeof v === 'number' ? v.toLocaleString('en-US') : String(v)
  return String(v)
}

export function IntelRecords({ cohort, title, onClose }: { cohort: RecordCohort; title: string; onClose: () => void }) {
  const { ctx, act, defs, registry } = useLab()
  const [state, setState] = useState<{ key: string; sort: LCSort; pages: number }>({ key: '', sort: null, pages: 1 })
  const base = serverContext(ctx, { groupBy: null })
  const key = JSON.stringify([cohort, base])
  if (state.key !== key) setState({ key, sort: null, pages: 1 })
  const sort = state.key === key ? state.sort : null
  const pages = state.key === key ? state.pages : 1
  const path = (n: number) => paths.records(base, cohort, n, PAGE, sort?.id || null, sort?.dir || 'desc')
  // pages are read in a fixed order of hooks; a page is asked for only when the grid reaches it
  const p1 = useIntel<LabRecords>(path(1))
  const p2 = useIntel<LabRecords>(pages >= 2 ? path(2) : null)
  const p3 = useIntel<LabRecords>(pages >= 3 ? path(3) : null)
  const p4 = useIntel<LabRecords>(pages >= 4 ? path(4) : null)
  const p5 = useIntel<LabRecords>(pages >= 5 ? path(5) : null)
  const p6 = useIntel<LabRecords>(pages >= 6 ? path(6) : null)
  const p7 = useIntel<LabRecords>(pages >= 7 ? path(7) : null)
  const p8 = useIntel<LabRecords>(pages >= 8 ? path(8) : null)
  const p9 = useIntel<LabRecords>(pages >= 9 ? path(9) : null)
  const p10 = useIntel<LabRecords>(pages >= 10 ? path(10) : null)
  const all = [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10].slice(0, pages)
  const d = p1.data
  const rows = useMemo(() => all.flatMap((p) => p.data?.rows || []), [p1.data, p2.data, p3.data, p4.data, p5.data, p6.data, p7.data, p8.data, p9.data, p10.data, pages]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadingMore = all.slice(1).some((p) => p.loading)
  const total = d?.total ?? null
  const more = total !== null && rows.length < total && pages < 10 && !loadingMore

  const columns: LCColumn<Row>[] = useMemo(() => (d?.columns || []).map((c) => ({
    id: c.id, header: c.label, sortable: true, hideable: true,
    width: c.type === 'time' ? 150 : c.type === 'number' || c.type === 'bool' ? 104 : c.id === 'address' || c.id === 'reason' ? undefined : 150,
    minWidth: c.id === 'address' || c.id === 'reason' ? 220 : undefined,
    align: c.type === 'number' ? 'right' as const : 'left' as const,
    render: (r: Row) => cell(r[c.id], c.type, ctx.tz),
  })), [d?.columns, ctx.tz])

  const open = (r: Row) => {
    if (d?.entity === 'run') { pushRoutePath(sellerAutomationPath(r)); return }
    if (r.oppId && (d?.entity === 'transition' || d?.entity === 'opportunity' || d?.entity === 'offer' || d?.entity === 'closing')) { pushRoutePath(`/pipeline?opp=${encodeURIComponent(String(r.oppId))}`); return }
    if (r.thread) { pushRoutePath(`/inbox?thread=${encodeURIComponent(String(r.thread))}`); return }
    if (r.oppId) pushRoutePath(`/pipeline?opp=${encodeURIComponent(String(r.oppId))}`)
  }
  // [8.2] Show on Map without leaving the Lab: the cohort's places are framed
  // as one set (an open Map focuses in place; a closed one opens beside)
  const toMap = () => {
    if (!d?.handoff.points.length) return
    const refs = d.handoff.points.map(handoffPointObject)
    showOnMap(refs.length === 1 && d.handoff.points[0].id ? refs[0] : refs, { source: 'analytics', setLabel: `Analytics · ${title}` })
  }
  const rowObject = recordRowObject
  const toEntityGraph = () => {
    if (!d?.handoff.propertyIds.length) return
    const ff = JSON.stringify([{ field_key: 'properties.property_id', operator: 'in', value: d.handoff.propertyIds.slice(0, EG_MAX) }])
    pushRoutePath(`/entity-graph?eg_tab=properties&eg_ff=${encodeURIComponent(ff)}`)
  }
  const def = defs[cohort.metric]
  const cohortKey = !cohort.group && !cohort.bucket && !cohort.cell && cohort.window !== 'comparison' && (cohort.part !== 'denominator' || cohort.metric === 'sellers_reached') ? COHORT_OF[cohort.metric] : null
  const words = [
    cohort.part === 'denominator' ? 'denominator' : def?.unit === 'rate' ? 'numerator' : 'records',
    cohort.window === 'comparison' ? 'comparison window' : 'current period',
    cohort.group ? cohort.group.label || cohort.group.key : null,
    cohort.bucket ? new Date(cohort.bucket.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ctx.tz }) : null,
    cohort.cell ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][cohort.cell.weekday]} ${String(cohort.cell.hour).padStart(2, '0')}:00 seller-local` : null,
  ].filter(Boolean).join(' · ')
  const single = d && d.handoff.threads.length === 1 ? d.handoff.threads[0] : null

  // the operator asked for these records: a failed read is audible, once
  const erred = useRef<string | null>(null)
  useEffect(() => {
    if (!p1.error || erred.current === p1.error) return
    erred.current = p1.error
    sound.outcome.error()
  }, [p1.error])

  // focus the drawer on open; Esc closes it (after any menu / popover above it)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ix-rec" role="dialog" aria-modal="true" aria-label={`Records: ${title}`}>
      <button type="button" className="ix-rec__scrim" aria-label="Close records" onClick={onClose} tabIndex={-1} />
      <div ref={panel} className="ix-rec__panel" tabIndex={-1}>
        <header className="ix-rec__head">
          <div className="ix-rec__titles">
            <span className="ix-eyebrow">Records · {words}</span>
            <h3>{title}</h3>
            <p>{d ? <><b>{fmtInt(d.total)}</b> {NOUN[d.entity] || 'records'} — exactly the {cohort.part || (def?.unit === 'rate' ? 'numerator' : 'set')} of {def?.label || cohort.metric} for this slice{d.status && d.status !== 'ok' && d.reason ? ` · ${d.reason}` : ''}</> : p1.error ? p1.error : 'Reading the cohort…'}</p>
          </div>
          <div className="ix-rec__tools">
            {cohortKey ? <LCButton size="sm" variant="primary" icon="filter" onClick={() => { act.setCohort(cohortKey, registry.cohorts?.[cohortKey]?.label); onClose() }}>Narrow the Lab to them</LCButton> : null}
            {single ? <LCButton size="sm" variant="secondary" icon="message" onClick={() => pushRoutePath(`/inbox?thread=${encodeURIComponent(single)}`)}>Open the conversation</LCButton> : null}
            <LCButton size="sm" variant="secondary" icon="map" onClick={toMap} disabled={!d?.handoff.points.length} title="Light this cohort on the Map (up to 5,000 places)">Map</LCButton>
            <LCButton size="sm" variant="secondary" icon="grid" onClick={toEntityGraph} disabled={!d?.handoff.propertyIds.length} title={`Open these properties in Entity Graph${(d?.handoff.propertyIds.length || 0) > EG_MAX ? ` (first ${EG_MAX} of ${d?.handoff.propertyIds.length})` : ''}`}>Entity Graph{(d?.handoff.propertyIds.length || 0) > EG_MAX ? ` · first ${EG_MAX}` : ''}</LCButton>
            <LCIconButton icon="x" label="Close records" shortcut={['Esc']} onClick={onClose} />
          </div>
        </header>
        <div className={cx('ix-rec__grid', p1.stale && 'is-stale')}>
          <LCDataGrid
            id={`intel-records-${d?.entity || 'x'}`}
            label={`Records: ${title}`}
            rows={rows}
            rowKey={(r) => String(r.key)}
            columns={columns}
            sort={sort}
            onSortChange={(s) => setState({ key, sort: s, pages: 1 })}
            // click opens it in its app · ⇧-click inspects · ⌘/Ctrl-click opens beside
            onActivate={(r, e) => handleObjectClick(e, rowObject(r), () => open(r))}
            rowMenu={(r) => [
              ...(r.thread ? [{ id: 'inbox', label: 'Open the conversation', icon: 'message' as const, onSelect: () => pushRoutePath(`/inbox?thread=${encodeURIComponent(String(r.thread))}`) }] : []),
              ...(r.oppId ? [{ id: 'pipe', label: 'Open the deal in Pipeline', icon: 'arrow-up-right' as const, onSelect: () => pushRoutePath(`/pipeline?opp=${encodeURIComponent(String(r.oppId))}`) }] : []),
              ...(d?.entity === 'run' ? [{ id: 'wf', label: 'Open the run in Workflow Studio', icon: 'zap' as const, onSelect: () => pushRoutePath(sellerAutomationPath(r)) }] : []),
              ...(r.campaignId ? [{ id: 'camp', label: 'Open the campaign', icon: 'send' as const, onSelect: () => pushRoutePath(`/campaign-command?campaign=${encodeURIComponent(String(r.campaignId))}`) }] : []),
              ...objectMenuEntries(rowObject(r), { omit: ['open'], showOnMap: { source: 'analytics' } }).map((e) => (e.kind === 'separator' ? e : { ...e, id: `obj-${e.id}` })),
            ]}
            loading={p1.loading && !d}
            error={p1.error && !d ? { what: 'The records didn’t load', onRetry: p1.reload } : null}
            empty={{ title: 'No records in this cohort' }}
            onEndReached={more ? () => setState({ key, sort, pages: pages + 1 }) : undefined}
            loadingMore={loadingMore}
            total={total}
            height="100%"
          />
        </div>
        <footer className="ix-rec__foot">
          <span>{total !== null ? `${fmtInt(rows.length)} of ${fmtInt(total)} shown${rows.length < total && pages >= 10 ? ' — the first 2,000; Map and Entity Graph take the whole cohort' : ''}` : ''}</span>
          <span className="ix-muted">Read-only · rows open in their own app · phones are masked</span>
        </footer>
      </div>
    </div>
  )
}
