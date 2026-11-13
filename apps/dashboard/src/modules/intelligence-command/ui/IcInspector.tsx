import { useMemo, useState, type ReactNode } from 'react'
import { cx } from '../../../shared/lc'
import { citationsOf, normalizeResult, shortModelName, sourcesOf } from '../../agent/ask/ask-model'
import { useAsk } from '../../agent/ask/ask-store'
import { openApp } from '../../desktop/workspace/workspace-store'
import { isTerminalMission } from '../api/ic-client'
import { ResultBlocks } from '../../agent/ask/ui/ResultBlocks'
import { CAPABILITY_LABEL } from '../model/act-model'
import { visibleChips, type PageContext } from '../model/context-model'
import { cancelMission, inspect, openMission, setSection, useIc } from '../store/ic-store'
import { runStateOf } from './RunTurn'
import { EmptyLine, IcGlyph, PlaneNotice, Spec, clock, ms, usd } from './primitives'

function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return <section className="ic-ib"><header><h4>{title}</h4>{aside}</header>{children}</section>
}
function KV({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="ic-kv">{rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
}
const open = (href: string) => openApp(href, 'beside')

/** The right inspector: the selected run / act / approval / mission — sources, provenance, trace, cost, model, permissions. */
export function IcInspector({ page }: { page: PageContext }) {
  const ic = useIc()
  const a = useAsk()
  const t = ic.inspector
  const head = (title: string) => <header className="ic-insp__h"><h3>{title}</h3>{t ? <button type="button" className="ic-icon" aria-label="Close inspector" onClick={() => inspect(null)}><IcGlyph name="close" size={11} /></button> : null}</header>

  if (t?.kind === 'turn') {
    const thread = a.threads.find((x) => x.id === t.threadId)
    const turn = thread?.turns.find((u) => u.id === t.turnId)
    if (!thread || !turn) return <aside className="ic-insp">{head('Run')}<EmptyLine>This run is no longer in the conversation index.</EmptyLine></aside>
    return <aside className="ic-insp">{head('Run')}<TurnInspector threadId={thread.id} turnId={turn.id} /></aside>
  }
  if (t?.kind === 'act' || t?.kind === 'approval') {
    const entry = t.kind === 'act' ? ic.acts.find((x) => x.id === t.id) : null
    const ap = entry?.approval ?? (t.kind === 'approval' ? ic.approvals.data?.find((x) => x.approval_id === t.id) : null) ?? null
    return (
      <aside className="ic-insp">
        {head(ap ? CAPABILITY_LABEL[ap.capability_id] ?? 'Approval' : 'Act')}
        {entry ? <Block title="Invocation"><KV rows={[['Capability', <code key="c">{entry.capability_id}</code>], ['Server status', entry.outcome?.status ?? entry.phase], ['Refusal', entry.outcome?.code ?? entry.failure?.code ?? null], ['Prepared', clock(entry.createdAt)]]} /></Block> : null}
        {ap ? (
          <>
            <Block title="Permissions"><KV rows={[['Tier', ap.tier.replace(/_/g, ' ')], ['Provenance', ap.provenance.replace(/_/g, ' ')], ['Decided by', 'a verified named operator in this org (server-checked)'], ['Expires', clock(ap.expires_at)]]} /></Block>
            <Block title="Provenance"><KV rows={[['Approval', <code key="a">{ap.approval_id}</code>], ['Payload hash', <code key="p">{ap.payload_hash.slice(0, 24)}…</code>], ['State check', <code key="s">{ap.snapshot_hash_prefix}</code>], ['Version', `v${ap.capability_version}`]]} /></Block>
            <Block title="Target"><pre className="ic-json">{JSON.stringify(ap.target, null, 2)}</pre></Block>
            <Block title="Intended change"><pre className="ic-json">{JSON.stringify(ap.intended_change, null, 2)}</pre></Block>
            {ap.execution_result ? <Block title="Execution result (server)"><pre className="ic-json">{JSON.stringify(ap.execution_result, null, 2)}</pre></Block> : null}
          </>
        ) : null}
      </aside>
    )
  }
  if (t?.kind === 'mission') return <aside className="ic-insp">{head('Mission')}<MissionInspector id={t.id} /></aside>
  if (t?.kind === 'shadow') {
    const r = ic.shadow.data?.records.find((x) => x.inbound_message_id === t.id)
    return (
      <aside className="ic-insp">
        {head('Shadow decision')}
        {r ? (
          <>
            <Block title="Understood"><KV rows={[['Intent', r.intent], ['Seller interest', r.seller_interest], ['Confidence', r.confidence != null ? `${Math.round(r.confidence * 100)}%` : null], ['Stage', r.stage], ['Next objective', r.next_objective]]} /></Block>
            <Block title="Decision"><KV rows={[['Outcome', r.outcome], ['Validation', r.validation], ['Send', 'never — shadow records cannot send']]} /></Block>
            {r.draft ? <Block title="Draft (not sent)"><blockquote className="ic-quote">{r.draft}</blockquote></Block> : null}
            <Block title="Model + cost"><KV rows={[['Path', r.path], ['Models', r.models.map((m) => shortModelName(m) ?? m).join(' · ')], ['Cost', usd(r.cost_usd)], ['Latency', ms(r.latency_ms)]]} /></Block>
            {r.property_ids.length ? <Block title="Properties">{r.property_ids.map((id) => <button key={id} type="button" className="ic-link" onClick={() => open(`/entity-graph/property/${encodeURIComponent(id)}`)}>Open {id} in Entity Graph</button>)}</Block> : null}
          </>
        ) : <EmptyLine>Record not loaded.</EmptyLine>}
      </aside>
    )
  }
  // no selection: what the composer would send from this page, and the run permissions
  const chips = visibleChips(ic.chips, page)
  const st = a.status.data
  return (
    <aside className="ic-insp">
      {head('Context')}
      <Block title="This page">
        {chips.length ? <ul className="ic-ctx">{chips.map((c) => <li key={c.key}><b>{c.label}</b><small>{c.sends ? `sends ${c.sends}` : 'shown only — nothing sent'}{c.detail ? ` · ${c.detail}` : ''}</small></li>)}</ul> : <EmptyLine>No page context. Select a property, open a deal or campaign, or @-mention one.</EmptyLine>}
        {page.property?.id ? <button type="button" className="ic-link" onClick={() => open(`/entity-graph/property/${encodeURIComponent(page.property!.id!)}`)}>Open property in Entity Graph</button> : null}
        {page.deal ? <button type="button" className="ic-link" onClick={() => open(`/pipeline?opp=${encodeURIComponent(page.deal!.opportunityId)}`)}>Open deal in Pipeline</button> : null}
        {page.campaign ? <button type="button" className="ic-link" onClick={() => open(`/campaign-command?campaign=${encodeURIComponent(page.campaign!.id)}`)}>Open campaign</button> : null}
      </Block>
      <Block title="Permissions">
        {a.status.phase === 'failed' && a.status.failure ? <p className="ic-note">{a.status.failure.message} <code>{a.status.failure.code}</code></p> : null}
        <KV rows={[
          ['Research agent', st ? (st.mode_ok ? 'read-only (mode ceiling holds)' : 'refused: mode is not read-only') : a.status.phase === 'failed' ? 'off' : 'reading…'],
          ['Read tools', st ? `${st.tools.length}` : null],
          ['Writes', 'only as approvals a human decides'],
          ['Per-run cap', st ? usd(st.caps.run_usd) : null],
          ['Today', st ? `${usd(st.spend.day_usd)} of ${usd(st.caps.day_usd)}` : null],
        ]} />
        {st?.tools.length ? <ul className="ic-tools">{st.tools.map((x) => <li key={x.name}><code>{x.name}</code><small>{x.side_effect ?? x.tier ?? ''}</small></li>)}</ul> : null}
      </Block>
    </aside>
  )
}

function TurnInspector({ threadId, turnId }: { threadId: string; turnId: string }) {
  const a = useAsk()
  const thread = a.threads.find((x) => x.id === threadId)!
  const turn = thread.turns.find((u) => u.id === turnId)!
  const tools = a.status.data?.tools ?? []
  const st = useMemo(() => runStateOf(turn, tools), [turn, tools])
  const run = turn.run
  const cites = citationsOf(run, turn.chips, a.labels)
  const sources = sourcesOf(run)
  const web = run?.result?.evidence.public_web ?? []
  const webOffered = (turn.events ?? []).some((e) => e.type === 'model_call_start' && e.web_offered === true)
  const props = (run?.result?.blocks ?? []).filter((b) => b.kind === 'property_research') as Array<{ property_id: string | null; address_label: string | null; title: string }>
  return (
    <>
      <Block title="Run"><KV rows={[['Run id', turn.runId ? <code key="r">{turn.runId}</code> : 'not accepted yet'], ['State', run?.state ?? turn.phase], ['Outcome', run?.outcome ?? st.outcome], ['Started', clock(turn.sentAt)], ['Latency', ms(run?.latency_ms ?? st.latencyMs)], ['Persistence', run?.answer?.persisted === false ? 'answer NOT persisted' : turn.runId ? 'durable on the server (by id)' : null]]} /></Block>
      {props.length ? <Block title="Selected property">{props.map((p, i) => <div key={i} className="ic-ent"><b>{p.address_label || p.title}</b>{p.property_id ? <button type="button" className="ic-link" onClick={() => open(`/entity-graph/property/${encodeURIComponent(p.property_id!)}`)}>Open in Entity Graph</button> : null}</div>)}</Block> : null}
      <Block title="Model + cost" aside={<span className="ic-mono">{usd(run?.cost_usd ?? st.costUsd)}</span>}>
        {run?.calls.length ? (
          <ul className="ic-calls">{run.calls.map((c, i) => <li key={i}><b>{shortModelName(c.model) ?? c.model}</b><Spec items={[c.route, c.input_tokens != null ? `${c.input_tokens.toLocaleString('en-US')} in` : null, c.output_tokens != null ? `${c.output_tokens.toLocaleString('en-US')} out` : null, ms(c.latency_ms), usd(c.cost_usd)]} /></li>)}</ul>
        ) : <Spec items={[st.models.map((m) => shortModelName(m) ?? m).join(' → ') || 'no model call yet', `${st.modelCalls} calls`]} />}
        {run?.counters.escalated_calls ? <p className="ic-note">{run.counters.escalated_calls} escalated call{run.counters.escalated_calls === 1 ? '' : 's'} · {usd(run.counters.escalated_usd)}</p> : null}
      </Block>
      <Block title="Permissions"><KV rows={[['Agent', 'read-only research registry'], ['Public web', webOffered ? 'offered on this run (provider-executed)' : st.webSearches ? 'used' : 'not offered'], ['Writes', 'none — this run cannot send, launch or change records'], ['Context sent', `${turn.chips.reduce((n, c) => n + c.property_ids.length, 0)} property ids${turn.chips.some((c) => c.kind === 'campaign') ? ' · 1 campaign' : ''}`]]} /></Block>
      <Block title="Sources + provenance">
        {sources.length ? <ul className="ic-tools">{sources.map((s) => <li key={s}><code>{s}</code><small>LeadCommand record</small></li>)}</ul> : <EmptyLine>{run ? 'No LeadCommand reads.' : 'Sources appear when the run ends.'}</EmptyLine>}
        {web.length ? <ul className="ic-tools">{web.map((w) => <li key={w.url}><a href={/^https?:\/\//.test(w.url) ? w.url : undefined} target="_blank" rel="noopener noreferrer nofollow">{w.title || w.url}</a><small>public web · not LeadCommand data</small></li>)}</ul> : null}
        {cites.length ? <div className="ic-cites">{cites.map((c) => <button key={c.key} type="button" className={cx('ic-cite', c.cited && 'is-cited')} onClick={() => open(c.href)}><b>{c.title}</b><small>{c.detail}</small></button>)}</div> : null}
      </Block>
      <Block title="Tool trace" aside={<span className="ic-mono">{st.steps.length} steps</span>}>
        {run?.audit.length ? (
          <ol className="ic-trace">{run.audit.map((r, i) => <li key={i}><time>{clock(r.at)}</time><code>{r.kind}</code><span>{r.name ?? ''}</span><Spec items={[r.rows_returned != null ? `${r.rows_returned} rows` : null, r.latency_ms != null ? ms(r.latency_ms) : null, r.cost_usd ? usd(r.cost_usd) : null, r.outcome, r.params_sha256 ? <code key="h">#{r.params_sha256.slice(0, 8)}</code> : null]} /></li>)}</ol>
        ) : st.steps.length ? <ol className="ic-trace">{st.steps.map((s) => <li key={s.key}><time>{clock(s.at)}</time><code>{s.kind}</code><span>{s.name ?? s.title}</span><Spec items={[s.state, s.rows != null ? `${s.rows} rows` : null, s.latency_ms != null ? ms(s.latency_ms) : null]} /></li>)}</ol> : <EmptyLine>No steps yet.</EmptyLine>}
      </Block>
    </>
  )
}

function MissionInspector({ id }: { id: string }) {
  const ic = useIc()
  const [note, setNote] = useState<string | null>(null)
  const d = ic.mission.data && ic.mission.data.mission_id === id ? ic.mission.data : null
  const summary = d ?? ic.missions.data?.missions.find((x) => x.mission_id === id) ?? null
  if (!summary) return ic.mission.phase === 'failed' && ic.mission.failure ? <PlaneNotice failure={ic.mission.failure} compact /> : <EmptyLine>Reading the mission…</EmptyLine>
  const r = d?.result ?? null
  const envelope = r && typeof r.envelope === 'object' && r.envelope ? normalizeResult(r.envelope) : null
  const answer = r && typeof r.answer === 'string' ? r.answer : ''
  const approvals = Array.isArray(r?.approvals) ? (r!.approvals as Array<Record<string, unknown>>) : []
  const live = !isTerminalMission(summary)
  return (
    <>
      <Block title="Mission" aside={<span className={cx('ic-state', `is-${summary.display_state}`)}>{summary.display_state.replace(/_/g, ' ')}</span>}>
        <p className="ic-mq">{d?.input?.question ?? summary.title}</p>
        <KV rows={[['Mission', <code key="j">{summary.mission_id}</code>], ['Kind', summary.kind], ['Trigger', summary.trigger.kind], ['Attempt', `${summary.attempt}/${summary.max_attempts}`], ['Progress', summary.progress.pct != null ? `${summary.progress.pct}%${summary.progress.step ? ` · ${summary.progress.step}` : ''}` : summary.progress.step], ['Sub-missions', summary.progress.children_total ? `${summary.progress.children_done ?? 0}/${summary.progress.children_total}` : null], ['Next claim', live ? clock(summary.next_attempt_at) : null], ['Ended', clock(summary.ended_at)], ['Error', summary.last_error?.code ?? null]]} />
        {live ? <button type="button" className="ic-btn" disabled={summary.cancel_requested} onClick={() => void cancelMission(id).then(setNote)}><IcGlyph name="stop" size={11} />{summary.cancel_requested ? 'Cancelling' : 'Cancel mission'}</button> : null}
        {note ? <p className="ic-note" role="status">{note}</p> : null}
        <p className="ic-note">Runs on the server runtime; closing this browser does not stop it.</p>
      </Block>
      {d?.cost ? <Block title="Cost (ledger)" aside={<span className="ic-mono">{usd(d.cost.total_committed_usd)}</span>}><KV rows={[['Committed', usd(d.cost.committed_usd)], ['Open reserve', d.cost.open_reserved_usd ? usd(d.cost.open_reserved_usd) : null], ['Unknown', d.cost.unknown_usd ? usd(d.cost.unknown_usd) : null], ['Children', d.cost.children_committed_usd ? usd(d.cost.children_committed_usd) : null], ['Model calls', String(d.cost.model_calls)], ['Budget cap', usd(d.cost.budget_cap_usd)]]} /></Block> : null}
      {answer || envelope ? <Block title="Result"><div className="ic-insp__answer"><ResultBlocks result={envelope} answerMd={answer} citeIds={Array.isArray(r?.property_refs) ? (r!.property_refs as unknown[]).map(String) : []} onCite={(pid) => open(`/entity-graph/property/${encodeURIComponent(pid)}`)} labelOf={() => null} onOpen={open} /></div></Block> : r ? <Block title="Result"><pre className="ic-json">{JSON.stringify(r, null, 2)}</pre></Block> : null}
      {approvals.length ? <Block title="Approvals it prepared">{approvals.map((a) => <button key={String(a.approval_id)} type="button" className="ic-cite" onClick={() => { setSection('approvals') }}><b>{CAPABILITY_LABEL[String(a.capability_id)] ?? String(a.capability_id)}</b><small>{String(a.approval_id)} · decide in Approvals</small></button>)}</Block> : null}
      {d?.children.length ? <Block title="Sub-missions">{d.children.map((c) => <button key={c.mission_id} type="button" className="ic-cite" onClick={() => openMission(c.mission_id)}><b>{c.title || c.mission_id}</b><small>{c.display_state} · {c.cost_usd != null ? usd(c.cost_usd) : 'cost pending'}</small></button>)}</Block> : null}
      {d?.findings.length ? <Block title="Findings" aside={<span className="ic-mono">{d.findings.length}</span>}><ul className="ic-tools">{d.findings.map((f) => <li key={f.finding_id}><code>{f.finding_type}</code><small>{f.key}{f.evidence_status ? ` · ${f.evidence_status.replace(/_/g, ' ')}` : ''}</small></li>)}</ul></Block> : null}
      <Block title="Events" aside={<span className="ic-mono">{d?.events.length ?? 0}{live ? ' · live' : ''}</span>}>
        {d?.events.length ? <ol className="ic-trace">{d.events.map((e) => <li key={e.id}><time>{clock(e.at)}</time><code>{e.type}</code><span>{e.type.replace(/^job\./, '')}{typeof e.payload.step === 'string' ? ` · ${e.payload.step}` : ''}</span><Spec items={[e.state, e.actor, typeof e.payload.cost_usd === 'number' ? usd(e.payload.cost_usd) : null, typeof e.payload.code === 'string' ? e.payload.code : null]} /></li>)}</ol> : ic.mission.phase === 'failed' && ic.mission.failure ? <PlaneNotice failure={ic.mission.failure} compact /> : <EmptyLine>Reading agent.job_event…</EmptyLine>}
      </Block>
    </>
  )
}
