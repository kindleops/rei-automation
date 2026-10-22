import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCSkeleton, cx } from '../../../../shared/lc'
import { LinkedNotice } from '../../../desktop/workspace/LinkedNotice'
import { getCommand, getKpis, getMission, listAssignments, listMissions, newClientRequestId, postCommand, type WfFailure } from '../../api/wf-client'
import type { WfExecMessage, WfMission, WfMissionDetail } from '../../api/wf-types'
import {
  capabilityLabel, eventMeta, intentLabel, isTerminalMission, kpiDisplay, kpiLabel, linkedDirective, missionMeta, planDag, progressOf, resourceRef,
  composerRefusal, type LinkedSubject,
} from '../../model/wf-model'
import { useWf, type WfView } from '../../store/wf-hooks'
import { useWfNav } from '../wf-context'
import { WfAssignmentState, WfAvatar, WfFailureState, WfMissionState, WfPanel, WfProgress, WfRefs, WfTime, WfUnknown } from '../wf-parts'

const SUGGESTIONS = [
  'Find the 10 most promising opportunities in Dallas and Minneapolis and get them moving.',
  "Why aren't the Dallas campaigns producing offers?",
  'What is blocked right now?',
]

interface Pending { id: string; content: string; crid: string; failure: WfFailure | null }

export function CommandSection({ tick, linked, clearLinked, draft, setDraft, onLive }: {
  tick: number
  linked: LinkedSubject | null
  clearLinked: () => void
  draft: string
  setDraft: (s: string) => void
  /** a mission is moving: the app polls faster */
  onLive: (live: boolean) => void
}) {
  const nav = useWfNav()
  const msgs = useWf('wf:command', (s) => getCommand({}, s), tick)
  const missions = useWf('wf:missions', (s) => listMissions({ limit: 40 }, s), tick)
  const needs = useWf('wf:needs', (s) => listAssignments({ status: 'waiting_approval' }, s), tick)
  const kpis = useWf('wf:kpis', (s) => getKpis(s), tick)
  const [local, setLocal] = useState<WfExecMessage[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const [focusMission, setFocusMission] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // server messages win; locally returned ones fill the gap until the next poll lands
  const thread = useMemo(() => {
    const server = msgs.data ?? []
    const ids = new Set(server.map((m) => m.message_id))
    return [...server, ...local.filter((m) => !ids.has(m.message_id))].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  }, [msgs.data, local])

  const byId = useMemo(() => new Map((missions.data ?? []).map((m) => [m.mission_id, m])), [missions.data])
  // the live card: the mission just opened here, else the newest directive's mission
  const latestMissionId = focusMission ?? [...thread].reverse().find((m) => m.author === 'ceo' && m.mission_id)?.mission_id ?? null
  const latest = latestMissionId ? byId.get(latestMissionId) ?? null : null
  const live = Boolean(latestMissionId && (!latest || !isTerminalMission(latest.status)))
  useEffect(() => { onLive(live) }, [live, onLive])

  const count = thread.length + (pending ? 1 : 0)
  const seenCount = useRef(0)
  useEffect(() => {
    const el = scroller.current
    if (!el || !count) return
    // the first frame lands at the newest message; later arrivals glide there
    el.scrollTo({ top: el.scrollHeight, behavior: seenCount.current ? 'smooth' : 'auto' })
    seenCount.current = count
  }, [count])
  // stick to the newest message while content grows (a mission card landing), unless the CEO scrolled up
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = scroller.current
    const list = listRef.current
    if (!el || !list) return
    let pinned = true
    const onScroll = () => { pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 140 }
    const ro = new ResizeObserver(() => { if (pinned) el.scrollTo({ top: el.scrollHeight }) })
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(list)
    return () => { ro.disconnect(); el.removeEventListener('scroll', onScroll) }
  }, [])
  useEffect(() => { if (draft) input.current?.focus() }, [draft])

  const send = useCallback(async (text: string, crid = newClientRequestId()) => {
    const content = text.trim()
    if (!content) return
    const why = composerRefusal(content)
    if (why) { setRefusal(why); return }
    setRefusal(null)
    const p: Pending = { id: `pending:${crid}`, content, crid, failure: null }
    setPending(p)
    setDraft('')
    const r = await postCommand(content, crid)
    if (!r.ok) { setPending({ ...p, failure: r }); return }
    setPending(null)
    setLocal((cur) => [...cur, ...r.data.messages])
    if (r.data.mission) setFocusMission(r.data.mission.mission_id)
    msgs.retry()
    missions.retry()
  }, [msgs, missions, setDraft])

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft) }
  }

  const suggestion = linked ? linkedDirective(linked) : null
  const orgKpis = (kpis.data ?? []).filter((k) => k.subject_type === 'org').slice(0, 6)
  const waitingOnYou = (needs.data ?? [])

  return (
    <div className="wf-cmd">
      <div className="wf-cmd__conv">
        {linked ? (
          <div className="wf-linked">
            <LinkedNotice text="Linked" subject={linked.address ?? linked.propertyId ?? linked.opportunityId} onDismiss={clearLinked} />
            {suggestion ? <button type="button" className="wf-linked__ask" onClick={() => setDraft(suggestion)}><Icon name="spark" size={12} /><span>Ask the COO about {linked.address ?? 'this property'}</span></button> : null}
          </div>
        ) : null}
        <div className="wf-cmd__scroll" ref={scroller}>
          {msgs.failure && !msgs.data ? <WfFailureState failure={msgs.failure} what="The executive conversation did not load" onRetry={msgs.retry} /> : null}
          {msgs.loading ? <LCSkeleton shape="rows" count={4} label="Conversation" /> : null}
          {msgs.data && !thread.length && !pending ? (
            <div className="wf-cmd__hello">
              <span className="wf-cmd__hello-k">Executive Command</span>
              <h3>Tell Atlas what you want done.</h3>
              <p>The COO turns a directive into a mission, staffs it from your organization and reports only what actually completed. Nothing here contacts a seller.</p>
            </div>
          ) : null}
          <ol className="wf-thread" aria-label="Executive conversation" ref={listRef}>
            {thread.map((m, i) => {
              const firstOfMission = m.author === 'ceo' && m.mission_id && thread.findIndex((x) => x.author === 'ceo' && x.mission_id === m.mission_id) === i
              return (
                <li key={m.message_id} className={cx('wf-msg', `is-${m.author}`)}>
                  <MessageBody m={m} />
                  {firstOfMission && m.mission_id ? (
                    m.mission_id === latestMissionId
                      ? <LiveMissionCard id={m.mission_id} seed={byId.get(m.mission_id) ?? null} tick={tick} fast={live} />
                      : <MissionChip m={byId.get(m.mission_id) ?? null} id={m.mission_id} onOpen={() => nav.openMission(m.mission_id!)} />
                  ) : null}
                </li>
              )
            })}
            {pending ? (
              <li className={cx('wf-msg', 'is-ceo', 'is-pending', pending.failure && 'is-failed')}>
                <div className="wf-msg__who"><span className="wf-msg__name">You</span><span className="wf-msg__time">{pending.failure ? 'Not sent' : 'Sending'}</span></div>
                <p className="wf-msg__text">{pending.content}</p>
                {pending.failure ? (
                  <div className="wf-msg__fail">
                    <span>{pending.failure.state === 'not_enabled' ? 'Workforce is not enabled on this server.' : pending.failure.message}</span>
                    {pending.failure.state !== 'not_enabled' ? <LCButton size="sm" variant="secondary" icon="refresh-cw" onClick={() => { void send(pending.content, pending.crid) }}>Send again</LCButton> : null}
                    <LCButton size="sm" variant="quiet" onClick={() => { setDraft(pending.content); setPending(null) }}>Edit</LCButton>
                  </div>
                ) : <div className="wf-typing" aria-label="Atlas is reading"><i /><i /><i /></div>}
              </li>
            ) : null}
          </ol>
        </div>
        <div className="wf-composer">
          {!draft && !thread.length ? (
            <div className="wf-composer__sugg">
              {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => setDraft(s)}>{s}</button>)}
            </div>
          ) : null}
          {refusal ? <p className="wf-composer__refuse" role="alert"><Icon name="shield" size={12} />{refusal}</p> : null}
          <div className="wf-composer__box">
            <textarea
              ref={input}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); if (refusal) setRefusal(null) }}
              onKeyDown={onKey}
              placeholder="Give the COO a directive, or ask where things stand"
              rows={2}
              maxLength={8000}
              aria-label="Directive for the COO"
            />
            <div className="wf-composer__bar">
              <span className="wf-composer__hint">Enter to send · Shift Enter for a new line · read-only and internal in Phase A</span>
              <button type="button" className="wf-send" disabled={!draft.trim() || Boolean(pending && !pending.failure)} onClick={() => { void send(draft) }}>
                <Icon name="send" size={13} />Send
              </button>
            </div>
          </div>
        </div>
      </div>

      <aside className="wf-cmd__rail" aria-label="What needs you">
        <WfPanel title="Needs you" icon="flag" aside={needs.data ? <span className="wf-count lc-num">{waitingOnYou.length}</span> : null}>
          {needs.failure && !needs.data ? <WfFailureState failure={needs.failure} what="Escalations did not load" onRetry={needs.retry} compact /> : null}
          {needs.loading ? <LCSkeleton shape="rows" count={2} /> : null}
          {needs.data && !waitingOnYou.length ? <p className="wf-quiet">Nothing is waiting on you.</p> : null}
          <ul className="wf-needs">
            {waitingOnYou.slice(0, 5).map((a) => (
              <li key={a.assignment_id}>
                <button type="button" className="wf-needs__row" onClick={() => nav.openAssignment(a.assignment_id, a.mission_id)}>
                  <span className="wf-needs__t">{a.blocked_reason ?? capabilityLabel(a.capability_key)}</span>
                  <span className="wf-needs__m"><WfAssignmentState status={a.status} quiet /> <WfTime iso={a.updated_at} now={nav.now} /></span>
                </button>
                {resourceRef(a) ? <WfRefs refs={[resourceRef(a)!]} quiet /> : null}
              </li>
            ))}
          </ul>
        </WfPanel>
        <WfPanel title="Missions in flight" icon="target">
          <MissionsInFlight view={missions} />
        </WfPanel>
        <WfPanel title="Company" icon="stats" aside={<span className="wf-quiet">7 days</span>}>
          {kpis.failure && !kpis.data ? <WfFailureState failure={kpis.failure} what="KPIs did not load" onRetry={kpis.retry} compact /> : null}
          {kpis.loading ? <LCSkeleton shape="metric" /> : null}
          {kpis.data && !orgKpis.length ? <p className="wf-quiet">No company KPIs have been computed.</p> : null}
          <dl className="wf-kpis">
            {orgKpis.map((k) => { const d = kpiDisplay(k); return (
              <div key={k.kpi_key}><dt>{kpiLabel(k.kpi_key)}</dt><dd className="lc-num">{d.unknown ? <WfUnknown reason={d.reason} /> : d.value}</dd></div>
            ) })}
          </dl>
        </WfPanel>
      </aside>
    </div>
  )
}

function MessageBody({ m }: { m: WfExecMessage }) {
  const nav = useWfNav()
  const coo = m.author === 'coo'
  const who = coo ? nav.employees.get(m.author_employee_id ?? '') : null
  return (
    <>
      <div className="wf-msg__who">
        {coo ? <WfAvatar e={who ?? { display_name: 'COO', employee_id: m.author_employee_id ?? 'coo', kind: 'ai' }} size={20} /> : null}
        <span className="wf-msg__name">{coo ? `${who?.display_name ?? 'COO'}` : 'You'}</span>
        {coo ? <span className="wf-msg__role">COO</span> : <span className="wf-msg__role">CEO</span>}
        <span className="wf-msg__time"><WfTime iso={m.created_at} now={nav.now} /></span>
      </div>
      <p className="wf-msg__text">{m.content}</p>
      {m.refs.length ? <div className="wf-msg__refs"><WfRefs refs={m.refs.filter((r) => !(r.type === 'mission' && r.id === m.mission_id))} max={8} /></div> : null}
    </>
  )
}

function MissionChip({ m, id, onOpen }: { m: WfMission | null; id: string; onOpen: () => void }) {
  const p = progressOf(m?.assignment_counts ?? null)
  return (
    <button type="button" className="wf-mchip" onClick={onOpen}>
      <Icon name="target" size={12} />
      <span className="wf-mchip__t">{m?.title ?? id}</span>
      {m ? <WfMissionState status={m.status} /> : null}
      {p.total ? <span className="wf-mchip__n lc-num">{p.done}/{p.total - p.cancelled}</span> : null}
      <Icon name="chevron-right" size={12} />
    </button>
  )
}

/** The mission a directive opened, polled while it moves: plan, live assignment progress, latest events. */
function LiveMissionCard({ id, seed, tick, fast }: { id: string; seed: WfMission | null; tick: number; fast: boolean }) {
  const nav = useWfNav()
  const view = useWf<WfMissionDetail | null>(`wf:mission:${id}`, (s) => getMission(id, s), tick)
  const d = view.data
  const m = d?.mission ?? seed
  const layers = useMemo(() => (d ? planDag(d.mission.plan, d.assignments) : []), [d])
  const p = progressOf(d?.assignments ?? m?.assignment_counts ?? null)
  const recent = (d?.events ?? []).slice(-3).reverse()
  if (!m) return view.failure ? <WfFailureState failure={view.failure} what="The mission did not load" onRetry={view.retry} compact /> : <LCSkeleton shape="block" height={140} />
  const meta = missionMeta(m.status)
  return (
    <article className={cx('wf-mcard', `is-${m.status}`, fast && !isTerminalMission(m.status) && 'is-live')} aria-label={`Mission ${m.title}`}>
      <header className="wf-mcard__h">
        <span className="wf-mcard__k">{intentLabel(m.objective?.intent ?? m.playbook_key)}</span>
        <WfMissionState status={m.status} />
      </header>
      <button type="button" className="wf-mcard__title" onClick={() => nav.openMission(m.mission_id)}>{m.title}<Icon name="chevron-right" size={13} /></button>
      {m.status === 'planning' ? (
        <p className="wf-mcard__plan">{nav.employees.get(m.owner_employee_id ?? '')?.display_name ?? 'The COO'} is planning: interpreting the directive and staffing the steps.</p>
      ) : null}
      <WfProgress p={p} label={`${m.title} progress`} />
      {layers.length ? (
        <ol className="wf-mcard__steps">
          {layers.flat().map((n) => (
            <li key={n.step.step_key} data-state={n.state}>
              <i aria-hidden="true" />
              <span className="wf-mcard__s">{n.step.label ?? capabilityLabel(n.step.capability_key)}</span>
              <span className="wf-mcard__c lc-num">{n.state === 'unavailable' ? 'Not in Phase A' : n.progress.total ? `${n.progress.done}/${n.progress.total - n.progress.cancelled}` : ''}</span>
            </li>
          ))}
        </ol>
      ) : m.status !== 'planning' ? <p className="wf-quiet">{meta.label}: no plan recorded.</p> : <LCSkeleton shape="lines" count={3} />}
      {recent.length ? (
        <ul className="wf-mcard__ev">
          {recent.map((e) => <li key={e.event_id}><span>{eventMeta(e.type).title}</span><WfTime iso={e.at} now={nav.now} /></li>)}
        </ul>
      ) : null}
      {m.report?.summary ? <p className="wf-mcard__sum">{m.report.summary}</p> : null}
    </article>
  )
}

function MissionsInFlight({ view }: { view: WfView<WfMission[]> }) {
  const nav = useWfNav()
  if (view.failure && !view.data) return <WfFailureState failure={view.failure} what="Missions did not load" onRetry={view.retry} compact />
  if (!view.data) return <LCSkeleton shape="rows" count={3} />
  const open = view.data.filter((m) => !isTerminalMission(m.status))
  if (!open.length) return <p className="wf-quiet">No mission is running.</p>
  return (
    <ul className="wf-flight">
      {open.slice(0, 6).map((m) => {
        const p = progressOf(m.assignment_counts)
        return (
          <li key={m.mission_id}>
            <button type="button" onClick={() => nav.openMission(m.mission_id)}>
              <span className="wf-flight__t">{m.title}</span>
              <span className="wf-flight__m"><WfMissionState status={m.status} />{p.pct !== null ? <span className="lc-num">{p.pct}%</span> : null}</span>
              <WfProgress p={p} label={`${m.title} progress`} compact />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
