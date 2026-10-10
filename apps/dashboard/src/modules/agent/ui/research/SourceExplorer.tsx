import { useMemo } from 'react'
import { cx } from '../../../../shared/lc'
import type { SourceOperationStatus } from '../../contracts/contracts'
import { EVIDENCE_CLASSES, EVIDENCE_CLASS_META, evidenceClassOf, sourceClass, type EvidenceClass, type SourceRef } from '../../model/evidence-class'
import type { ResearchView } from '../../model/research-model'
import { setUi, useAgentUi, type RunMode } from '../../runtime/agent-store'
import { fmtClock, fmtDay, reasonLabel, authorityLabel } from '../format'
import { ClassTag, Favicon, SimTag } from '../primitives'

interface Row { key: string; task_id: string; source: SourceRef | null; source_id: string; purpose: string; status: SourceOperationStatus; retrieved_at: string | null; at: string | null; observations: number; reason: string | null; message: string | null; alternatives: string[]; arrival: number; cls: EvidenceClass | null; noValue: boolean }

const STATUS_LABEL: Record<SourceOperationStatus, string> = { planned: 'Planned', searched: 'Searched', opened: 'Opened', retrieved: 'Retrieved', blocked: 'Blocked', failed: 'Unavailable', skipped_fresh: 'Reused · fresh' }

/**
 * SOURCE EXPLORER (DR §1F, S3 P4) — one row per source the run touched or
 * planned: monogram (never a live favicon), name, authority + evidence class,
 * purpose, status, retrieval time, observation count. Rows group by evidence
 * class so official records, LeadCommand records, vendor data, derived
 * values and blocked sources never blend together. Click → the evidence
 * drawer in the inspector.
 */
export function SourceExplorer({ view, sources, propertyId, arrivalFloor, mode }: { view: ResearchView; sources: Record<string, SourceRef>; propertyId: string | null; arrivalFloor: number; mode: RunMode }) {
  const ui = useAgentUi()
  const rows = useMemo<Row[]>(() => {
    const seen = new Set<string>()
    const out: Row[] = []
    // a row is grouped by what the SOURCE is (its declared class); a read that returned no value is flagged on the row, not re-grouped
    const clsFor = (taskId: string, src: SourceRef | null, status: SourceOperationStatus): EvidenceClass | null => {
      if (status === 'blocked' || status === 'failed') return 'unavailable'
      const declared = sourceClass(src)
      if (declared) return declared
      const t = view.tasks[view.taskIndex[taskId]]
      const f = t?.finding_ids.map((id) => view.findings[id]).find((x) => x && x.evidence_status !== 'unavailable' && x.evidence_status !== 'blocked')
      return f ? evidenceClassOf(f, src) : null
    }
    const noValueOf = (taskId: string) => {
      const t = view.tasks[view.taskIndex[taskId]]
      const fs = t?.finding_ids.map((id) => view.findings[id]).filter(Boolean) ?? []
      return fs.length > 0 && fs.every((f) => f.evidence_status === 'unavailable' || f.evidence_status === 'blocked')
    }
    for (const s of view.sources) {
      if (propertyId && s.property_id !== propertyId) continue
      seen.add(s.key)
      const src = sources[s.source_id] ?? null
      const t = view.tasks[view.taskIndex[s.task_id]]
      out.push({ key: s.key, task_id: s.task_id, source: src, source_id: s.source_id, purpose: s.purpose, status: s.status, retrieved_at: s.retrieved_at, at: t?.ended_at ?? t?.started_at ?? null, observations: s.finding_count, reason: s.reason, message: s.message, alternatives: s.alternatives, arrival: s.last_event_id, cls: clsFor(s.task_id, src, s.status), noValue: noValueOf(s.task_id) })
    }
    for (const t of view.tasks) {
      if (propertyId && t.property_id !== propertyId) continue
      if (!t.source_id || t.operation === 'research.synthesize_section') continue
      const declared = sources[t.source_id]
      if (declared && declared.billable && !declared.finding_types.length) continue // a model pseudo-source, not a record source
      const key = `${t.task_id}:${t.source_id}`
      if (seen.has(key)) continue
      const src = sources[t.source_id] ?? null
      const status: SourceOperationStatus = t.state === 'unavailable' || t.state === 'failed' ? 'failed' : t.state === 'blocked' ? 'blocked' : t.state === 'succeeded' ? 'retrieved' : 'planned'
      out.push({ key, task_id: t.task_id, source: src, source_id: t.source_id, purpose: t.finding_type ? t.finding_type.replace(/_/g, ' ') : 'lookup', status, retrieved_at: null, at: t.ended_at ?? t.started_at, observations: t.observations.length, reason: t.reason, message: t.message, alternatives: t.alternatives, arrival: t.first_event_id, cls: status === 'planned' ? sourceClass(src) : clsFor(t.task_id, src, status), noValue: noValueOf(t.task_id) })
    }
    return out
  }, [view, sources, propertyId])

  const grouped = useMemo(() => {
    const g = new Map<string, Row[]>()
    for (const r of rows) { const k = r.status === 'planned' ? 'planned' : r.cls ?? 'derived'; if (!g.has(k)) g.set(k, []); g.get(k)!.push(r) }
    return [...EVIDENCE_CLASSES, 'planned'].filter((k) => g.get(k)?.length).map((k) => ({ k, rows: g.get(k)! }))
  }, [rows])

  if (!rows.length) return <p className="agx-empty">No sources yet. A source appears when the run plans or touches it.</p>

  return (
    <div className="agx-src" aria-label="Source explorer">
      {grouped.map(({ k, rows: list }) => (
        <section key={k} className={cx('agx-src__grp', `is-${k}`)} aria-label={k === 'planned' ? 'Planned' : EVIDENCE_CLASS_META[k as EvidenceClass].label}>
          <header className="agx-src__gh">
            {k === 'planned' ? <span className="agx-src__plan">Planned · not contacted</span> : <ClassTag cls={k as EvidenceClass} />}
            <small>{list.length}</small>
            {k !== 'planned' ? <span className="agx-src__proves">{EVIDENCE_CLASS_META[k as EvidenceClass].proves}</span> : null}
          </header>
          <div className="agx-src__list" role="list">
            {list.map((r) => (
              <div key={r.key} className={cx('agx-src__row', `is-${r.status}`, ui.selectedSourceKey === r.key && 'is-selected', r.arrival > arrivalFloor && 'is-arrival')} role="listitem">
                <button type="button" className="agx-src__btn" onClick={() => setUi({ selectedSourceKey: r.key, selectedFindingId: view.tasks[view.taskIndex[r.task_id]]?.finding_ids[0] ?? null, inspectorTab: 'evidence', rightCollapsed: false })}>
                  <Favicon source={r.source} size={22} />
                  <span className="agx-src__name">
                    <b>{r.source?.name ?? r.source_id}<SimTag mode={mode} /></b>
                    <small>{authorityLabel(r.source)} · {r.purpose}{r.source?.host ? ` · ${r.source.host}` : ''}</small>
                  </span>
                  <span className={cx('agx-src__status', `is-${r.status}`, r.noValue && 'is-noval')}>{STATUS_LABEL[r.status]}{r.noValue ? ' · no value' : ''}</span>
                  <span className="agx-src__when" title={r.retrieved_at ? `Retrieved ${r.retrieved_at}` : undefined}>{r.status === 'planned' ? '—' : r.retrieved_at ? fmtDay(r.retrieved_at) === fmtDay(r.at) ? fmtClock(r.at) : fmtDay(r.retrieved_at) : fmtClock(r.at)}</span>
                  <span className="agx-src__obs" title="Observations extracted">{r.observations || ''}</span>
                </button>
                {r.status === 'blocked' ? (
                  <div className="agx-blocked is-card">
                    <p><b>{r.message ?? `${reasonLabel(r.reason)}.`}</b></p>
                    <p className="agx-blocked__absence">Not evidence of absence — the record simply wasn’t read. LeadCommand doesn’t retry or work around a refusal.</p>
                    {r.alternatives.length ? <p className="agx-blocked__alt">Continuing via {r.alternatives.join(' · ')}</p> : null}
                  </div>
                ) : r.status === 'failed' && (r.reason || r.message) ? (
                  <div className="agx-blocked is-card is-failed"><p><b>{r.message ?? `${reasonLabel(r.reason)}.`}</b> Marked unavailable — not evidence of absence.</p></div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
