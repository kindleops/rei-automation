import type { InspectorModel, InspectorRenderer, InspectorTone } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { count, enc, isoOrNull, joinParts, present, readInspector, text, when, words } from '../inspector-read'

/**
 * WORKFLOW — the Observatory reads Workflow Studio itself uses.
 *   ref.id `<workflow_key>:<run_id>` → GET …/observatory/workflows/:key/runs/:run_id (one run)
 *   ref.id `<workflow_key>`          → GET …/observatory/workflows/:key (the workflow)
 * The Observatory already speaks operator language (status_label, result,
 * reason, decisions); the inspector passes it through.
 */

export function parseWorkflowRef(id: string): { key: string; runId: string | null } {
  const i = id.indexOf(':')
  return i > 0 ? { key: id.slice(0, i), runId: id.slice(i + 1) || null } : { key: id, runId: null }
}

export function toneOfRun(status: string | null | undefined): InspectorTone {
  const s = String(status ?? '').toLowerCase()
  if (/fail|error/.test(s)) return 'crit'
  if (/need|held|review|blocked|wait/.test(s)) return 'attention'
  if (/run|progress|executing|active|live/.test(s)) return 'live'
  if (/complete|succeed|done|sent/.test(s)) return 'ok'
  return 'neutral'
}

export interface RunDetail {
  run?: {
    run_id?: string
    workflow_key?: string
    started_at?: string | null
    finished_at?: string | null
    duration_ms?: number | null
    subject?: { kind?: string | null; id?: string | null; name?: string | null; address?: string | null } | null
    trigger?: string | null
    status?: string | null
    status_label?: string | null
    current_node?: string | null
    result?: string | null
    reason?: string | null
  } | null
  decisions?: Array<{ k?: string; v?: string | null }> | null
  links?: Array<{ href?: string | null }> | null
  timeline?: Array<{ occurred_at?: string | null; node_key?: string | null; label?: string | null; status?: string | null }> | null
}

export interface WorkflowDetail {
  workflow?: {
    workflow_key?: string
    name?: string | null
    short_name?: string | null
    description?: string | null
    family?: string | null
    kind?: string | null
    owner_app?: string | null
    status?: string | null
    status_note?: string | null
    trigger?: { label?: string | null } | null
    stats?: { runs_24h?: number | null; needs_you?: number | null; in_flight?: number | null; failed_24h?: number | null; last_run_at?: string | null } | null
    policy?: { auto_reply_mode?: string | null; followup_automation_mode?: string | null } | null
  } | null
  generated_at?: string | null
}

/** Observatory text is usually a sentence already; a bare code ("escalated") becomes words. */
const plain = (v: unknown): string | null => {
  const s = text(v)
  return s && /^[a-z0-9_.]+$/.test(s) ? words(s) : s
}

const propertyFromLinks = (links: RunDetail['links']): string | null => {
  for (const l of links ?? []) {
    const m = /[?&]property(?:_id)?=([^&]+)/.exec(String(l.href ?? ''))
    if (m) return decodeURIComponent(m[1])
  }
  return null
}

export function shapeRun(d: RunDetail, ref: EntityRef): InspectorModel {
  const r = d.run ?? {}
  const { key, runId } = parseWorkflowRef(ref.id)
  const wfKey = text(r.workflow_key) ?? key
  const run = text(r.run_id) ?? runId ?? ''
  const subj = r.subject ?? null
  const seller = (subj?.kind === 'seller' || subj?.kind === 'thread_key') && subj.id ? subj.id : null
  const propertyId = propertyFromLinks(d.links)
  const finished = isoOrNull(r.finished_at)

  const relations: InspectorModel['relations'] = []
  if (seller) relations.push({ label: 'Seller', ref: { type: 'seller', id: seller, label: text(subj?.name), hint: { thread_key: seller, property_id: propertyId } } })
  if (propertyId) relations.push({ label: 'Property', ref: { type: 'property', id: propertyId, label: text(subj?.address), hint: { property_id: propertyId, thread_key: seller } } })

  return {
    title: text(ref.label) ?? words(wfKey) ?? 'Workflow run',
    subtitle: joinParts([text(subj?.name), text(subj?.address)]),
    eyebrow: plain(r.trigger),
    status: r.status_label ? { label: r.status_label, tone: toneOfRun(r.status) } : null,
    facts: present([
      { label: 'Result', value: plain(r.result) },
      { label: 'Why', value: plain(r.reason) },
      { label: 'Waiting at', value: !finished && r.current_node ? words(r.current_node) : null },
      { label: 'Started', value: when(r.started_at) },
      { label: 'Took', value: r.duration_ms != null ? `${Math.max(1, Math.round(r.duration_ms / 1000))}s` : null },
      ...(d.decisions ?? []).slice(0, 6).map((x) => ({ label: String(x.k ?? ''), value: text(x.v) })).filter((x) => x.label),
    ]),
    relations,
    activity: [...(d.timeline ?? [])].filter((e) => isoOrNull(e.occurred_at)).reverse().slice(0, 6).map((e) => ({
      at: e.occurred_at as string,
      text: joinParts([text(e.label) ?? words(e.node_key), e.status && e.status !== 'succeeded' ? words(e.status) : null]) ?? 'Step',
    })),
    open: [{ label: 'Workflow Studio', path: `/workflow-studio?wf=${enc(wfKey)}${run ? `&run=${enc(run)}` : ''}` }],
    mission: seller ? { label: text(subj?.name) ?? 'Seller', threadKey: seller, propertyId } : null,
    replay: run ? { type: 'workflow', id: `${wfKey}:${run}`, label: text(ref.label) } : null,
    freshness: null,
  }
}

export function shapeWorkflow(d: WorkflowDetail, ref: EntityRef): InspectorModel {
  const w = d.workflow ?? {}
  const key = text(w.workflow_key) ?? ref.id
  const st = w.stats ?? {}
  return {
    title: text(w.name) ?? text(ref.label) ?? words(key) ?? 'Workflow',
    subtitle: text(w.description),
    eyebrow: joinParts([words(w.family), words(w.kind)]),
    status: w.status ? { label: words(w.status) ?? w.status, tone: w.status === 'live' ? 'live' : 'neutral' } : null,
    facts: present([
      { label: 'Starts when', value: text(w.trigger?.label) },
      { label: 'Works in', value: text(w.owner_app) },
      { label: 'Runs, last 24h', value: count(st.runs_24h) },
      { label: 'Needs you', value: st.needs_you ? count(st.needs_you) : null },
      { label: 'Failed, last 24h', value: st.failed_24h ? count(st.failed_24h) : null },
      { label: 'In flight', value: st.in_flight ? count(st.in_flight) : null },
      { label: 'Last run', value: when(st.last_run_at) },
      { label: 'Auto-reply', value: words(w.policy?.auto_reply_mode) },
      { label: 'Follow-ups', value: words(w.policy?.followup_automation_mode) },
      { label: 'Note', value: text(w.status_note) },
    ]),
    open: [{ label: 'Workflow Studio', path: `/workflow-studio?wf=${enc(key)}` }],
    mission: null,
    replay: null,
    freshness: d.generated_at ? `As of ${when(d.generated_at)}` : null,
  }
}

const BASE = '/api/cockpit/workflow-studio/observatory/workflows'

export const workflowInspector: InspectorRenderer = {
  type: 'workflow',
  noun: 'Workflow',
  glyph: 'cpu',
  load: async (ref, signal) => {
    const { key, runId } = parseWorkflowRef(ref.id)
    if (runId) return shapeRun(await readInspector<RunDetail>(`${BASE}/${enc(key)}/runs/${enc(runId)}`, signal), ref)
    return shapeWorkflow(await readInspector<WorkflowDetail>(`${BASE}/${enc(key)}`, signal), ref)
  },
}
