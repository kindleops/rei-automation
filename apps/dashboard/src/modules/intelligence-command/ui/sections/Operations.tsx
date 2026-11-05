import { useEffect, type ReactNode } from 'react'
import { cx } from '../../../../shared/lc'
import { ACTION_STATE_LABEL, ACTION_STATE_ORDER, type ActionStateRow, type BriefSection, type WorkItem } from '../../api/ic-client'
import { decideWork, refreshActionCenter, refreshBrief, refreshSupervisor, refreshWorkItems, setActionFilter, useIc } from '../../store/ic-store'
import { EmptyLine, IcGlyph, PlaneNotice, Spec, ago, clock } from '../primitives'

/**
 * rc-8.5.20 C — the Inbound Action Center and the daily operating brief.
 *
 * Every number is a read of the operations read model (agent.conversation_action_state,
 * agent.ops_work_item, the digest.morning finding). A read model that is not applied or
 * not run yet shows that state and what turns it on — never a 0. Conversations are shown
 * by id only; nothing here can send.
 */

function SectionHead({ title, summary, children }: { title: string; summary?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ic-sec__h">
      <div><h2>{title}</h2>{summary ? <div className="ic-sec__sum">{summary}</div> : null}</div>
      {children ? <div className="ic-sec__tools">{children}</div> : null}
    </header>
  )
}
const short = (id: string | null | undefined) => (id ? `${id.slice(0, 8)}…` : '—')
const NOT_RUN: Record<string, string> = {
  ACTION_CENTER_NOT_RUN: 'The action center has not run yet: the owner enables the inbox-action-center schedule (born disabled) and arms inbox.action_center.',
  OPERATIONS_NOT_APPLIED: 'Schema PROPOSED_20261016140000_operations_action_center is not applied.',
  BRIEF_NOT_GENERATED: 'No daily brief yet: the conversation-review-digest schedule (born disabled) has not produced one.',
  BRIEF_PREDATES_OPERATIONS: 'The latest digest predates the operating brief (rc-8.5.20 C).',
  SUPERVISOR_NOT_RUN: 'The supervisor has not run yet: the owner enables the ops-supervisor schedule (born disabled) and arms ops.supervisor.',
}

/* ── Action Center ───────────────────────────────────────────────────── */

export function ActionCenterSection() {
  const ic = useIc()
  useEffect(() => { void refreshActionCenter(); void refreshWorkItems(); void refreshSupervisor() }, [])
  const page = ic.actionCenter.data
  const failure = ic.actionCenter.phase === 'failed' ? ic.actionCenter.failure : null
  const sum = page?.available ? page.summary : null
  return (
    <section className="ic-sec">
      <SectionHead title="Action Center" summary={<Spec items={['One operational state per seller conversation, derived on the server from real events', 'archive and unread are not states', sum?.computed_at ? `derived ${ago(sum.computed_at)}` : null]} />}>
        <button type="button" className="ic-btn is-quiet" onClick={() => { void refreshActionCenter(); void refreshWorkItems(); void refreshSupervisor() }}><IcGlyph name="retry" size={12} />Refresh</button>
      </SectionHead>
      {failure ? <PlaneNotice failure={failure} title={failure.state === 'not_enabled' ? 'Operations API not enabled' : undefined} onRetry={() => void refreshActionCenter()} /> : null}
      {page && !page.available ? <EmptyLine>{NOT_RUN[page.code ?? ''] ?? `Unavailable (${page.code}).`}</EmptyLine> : null}
      {sum ? (
        <>
          <div className="ic-ops__kpis" role="list" aria-label="Action center states">
            <button type="button" role="listitem" className={cx('ic-ops__kpi', ic.actionFilter === null && 'is-on')} onClick={() => setActionFilter(null)}><b>{sum.total}</b><span>All conversations</span></button>
            {ACTION_STATE_ORDER.map((s) => (
              <button type="button" role="listitem" key={s} className={cx('ic-ops__kpi', ic.actionFilter === s && 'is-on', s === 'needs_attention' && 'is-active-queue')} onClick={() => setActionFilter(s)}>
                <b>{sum.counts[s] ?? 0}</b><span>{ACTION_STATE_LABEL[s]}</span>{s === 'needs_attention' ? <em>{sum.lost} lost</em> : null}
              </button>
            ))}
          </div>
          <p className="ic-note">Active queue: <b>{sum.active_queue}</b> conversation(s) whose next action is neither assigned, scheduled nor completed. Lost = a meaningful seller message past the grace period with no next action of any kind.</p>
          <div className="ic-table" role="table" aria-label="Conversations">
            <div className="ic-table__h is-ops" role="row"><span>Conversation</span><span>State</span><span>Owner · next action</span><span>Due</span><span>Verified stage</span><span>Priority reason</span></div>
            {page!.items.length ? page!.items.map((r) => <ActionRow key={r.conversation_id} r={r} />) : <div className="ic-table__r is-ops" role="row"><span className="ic-table__d">No conversation in this state.</span></div>}
          </div>
        </>
      ) : ic.actionCenter.phase === 'loading' ? <EmptyLine>Reading…</EmptyLine> : null}
      <WorkItemsBlock />
      <SupervisorBlock />
    </section>
  )
}

function ActionRow({ r }: { r: ActionStateRow }) {
  return (
    <div className="ic-table__r is-ops" role="row">
      <span title={r.conversation_id}><code>{short(r.conversation_id)}</code>{r.lost ? <span className="ic-state is-critical">lost</span> : null}</span>
      <span><span className={cx('ic-state', `is-${r.state}`)}>{ACTION_STATE_LABEL[r.state as keyof typeof ACTION_STATE_LABEL] ?? r.state}</span></span>
      <span className="ic-table__d">{r.owner} · {r.next_action}{r.pending_approvals.length ? ` · ${r.pending_approvals.length} approval(s)` : ''}</span>
      <span className="ic-table__d">{r.due_at ? `${new Date(r.due_at).toLocaleDateString()} ${clock(r.due_at)}` : '—'}</span>
      <span className="ic-table__d">{r.verified_stage ?? '—'}{r.stage_verified ? '' : ' (unverified)'}{r.stage_note ? ` · ${r.stage_note.replace(/_/g, ' ')}` : ''}</span>
      <span className="ic-table__d" title={[...r.reasons, ...r.evidence_refs.map((e) => `${e.source}:${e.id}`)].join('\n')}>{r.priority_reason} · {r.reasons.join(', ')}</span>
    </div>
  )
}

function WorkItemsBlock() {
  const ic = useIc()
  const d = ic.workItems.data
  const items = d?.available ? d.items : []
  return (
    <>
      <h3 className="ic-sub">Work items · review, remediation, escalation</h3>
      {ic.workItems.phase === 'failed' && ic.workItems.failure ? <PlaneNotice failure={ic.workItems.failure} compact /> : null}
      {d && !d.available ? <EmptyLine>{NOT_RUN[d.code ?? ''] ?? `Unavailable (${d.code}).`}</EmptyLine> : null}
      {ic.workNote ? <p className="ic-note">{ic.workNote}</p> : null}
      {d?.available ? (items.length ? <ul className="ic-rows">{items.map((w) => <WorkRow key={w.work_item_id} w={w} />)}</ul> : <EmptyLine>No open work items.</EmptyLine>) : null}
    </>
  )
}

function WorkRow({ w }: { w: WorkItem }) {
  return (
    <li>
      <div className="ic-row is-static is-work">
        <span className={cx('ic-state', `is-${w.severity}`)}>{w.escalated ? 'escalated' : w.severity}</span>
        <b title={w.title}>{w.title}</b>
        <span className="ic-ops__acts">
          <Spec items={[w.kind.replace(/_/g, ' '), w.state, w.subject_id ? `${w.subject_type} ${short(w.subject_id)}` : w.subject_type, w.seen_count > 1 ? `seen ${w.seen_count}×` : null, ago(w.last_seen_at)]} />
          {w.state === 'open' ? <button type="button" className="ic-link" onClick={() => void decideWork(w.work_item_id, 'acknowledge')}>Take</button> : null}
          <button type="button" className="ic-link" onClick={() => void decideWork(w.work_item_id, 'resolve')}>Resolve</button>
          <button type="button" className="ic-link" onClick={() => void decideWork(w.work_item_id, 'dismiss')}>Dismiss</button>
        </span>
      </div>
    </li>
  )
}

function SupervisorBlock() {
  const ic = useIc()
  const d = ic.supervisor.data
  return (
    <>
      <h3 className="ic-sub">Operations supervisor · deterministic checks</h3>
      {ic.supervisor.phase === 'failed' && ic.supervisor.failure ? <PlaneNotice failure={ic.supervisor.failure} compact /> : null}
      {d && !d.available ? <EmptyLine>{NOT_RUN[d.code ?? ''] ?? `Unavailable (${d.code}).`}</EmptyLine> : null}
      {d?.available ? (
        <>
          <p className="ic-note">{d.all_clear ? 'All checks read and clear.' : `${d.counts?.critical ?? 0} critical · ${d.counts?.warn ?? 0} warn · ${d.counts?.unavailable ?? 0} unavailable (never counted as ok) · ${d.counts?.ok ?? 0} ok`} · run {ago(d.at)}</p>
          <ul className="ic-rows">{Object.entries(d.statuses).map(([k, v]) => <li key={k}><div className="ic-row is-static"><span className={cx('ic-state', `is-${v === 'warn' ? 'warning' : v}`)}>{v}</span><b>{k.replace(/_/g, ' ')}</b><span /></div></li>)}</ul>
        </>
      ) : null}
    </>
  )
}

/* ── Daily operating brief ───────────────────────────────────────────── */

export function BriefSection() {
  const ic = useIc()
  useEffect(() => { void refreshBrief() }, [])
  const b = ic.brief.data
  return (
    <section className="ic-sec">
      <SectionHead title="Daily operating brief" summary={<Spec items={['Built by conversation.review_digest from real records', 'every line links to its sources', 'missing data reads "unavailable", never 0', b?.window?.until ? `window ends ${new Date(b.window.until).toLocaleString()}` : null]} />}>
        <button type="button" className="ic-btn is-quiet" onClick={() => void refreshBrief()}><IcGlyph name="retry" size={12} />Refresh</button>
      </SectionHead>
      {ic.brief.phase === 'failed' && ic.brief.failure ? <PlaneNotice failure={ic.brief.failure} title={ic.brief.failure.state === 'not_enabled' ? 'Operations API not enabled' : undefined} onRetry={() => void refreshBrief()} /> : null}
      {b && !b.available ? <EmptyLine>{NOT_RUN[b.code ?? ''] ?? `Unavailable (${b.code}).`}</EmptyLine> : null}
      {b?.available ? b.sections.map((s) => <BriefBlock key={s.id} s={s} />) : ic.brief.phase === 'loading' ? <EmptyLine>Reading…</EmptyLine> : null}
    </section>
  )
}

function BriefBlock({ s }: { s: BriefSection }) {
  return (
    <div className="ic-ops__brief">
      <h3 className="ic-sub">{s.title}</h3>
      {!s.available ? <EmptyLine>Unavailable ({s.code})</EmptyLine> : (
        <ul className="ic-rows">
          {s.lines.map((l, i) => (
            <li key={i}>
              <div className="ic-row is-static">
                <span className="ic-ops__val">{l.unavailable ? 'unavailable' : l.value == null ? 'unavailable' : String(l.value)}</span>
                <b>{l.label}</b>
                <span className="ic-table__d" title={l.links.map((k) => `${k.source}:${k.id}`).join('\n')}>{l.links.length ? `${l.links.length} source record(s) · ${l.links[0].source}` : '—'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
