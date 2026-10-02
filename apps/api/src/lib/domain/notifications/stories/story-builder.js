/**
 * NOTIFICATION STORIES — items → stories (pure; no I/O).
 *
 *   SAME SUBJECT + SAME CAUSAL BURST + SHORT WINDOW = ONE STORY
 *
 * Pass 1 (chronological) — triggers and resolvers form bursts:
 *   message     a seller message opens a burst; the same conversation's next
 *               message within BURST_WINDOW joins it ("3 messages")
 *   condition   blocked / degraded / held opens a condition that stays open until
 *               its resolver (resumed / restored / completed) — however long that
 *               takes — so "blocked" and "resumed" are ONE story that morphs
 *   milestone   informational; same subject within BURST_WINDOW joins
 * Pass 2 — derivatives join by CAUSAL ID first (workflow run → source message,
 *   alert → provider sid, signal → source_event_id), else the subject's latest
 *   burst that started before them within DERIVATIVE_WINDOW.
 * Pass 3 — standalone orphans (a call request hours later, a seller counter) open
 *   their own story; the remaining orphans are Machine Feed only.
 *
 * Story ids are stable: hash(subject key + first trigger id).
 */
import { createHash } from 'node:crypto'
import { itemFromEvent, itemFromNotification, subjectKey, PRIORITY_RANK, systemLabel, _internals } from './story-grammar.js'

const { ms, capFirst } = _internals
export const BURST_WINDOW_MS = 10 * 60e3
export const DERIVATIVE_WINDOW_MS = 30 * 60e3
export const SKEW_MS = 5e3
export const AGE_INTO_HISTORY_MS = 24 * 3600e3
const LATE_MORPHS = new Set(['you_replied', 'response_sent', 'opted_out'])

const clean = (v) => String(v ?? '').trim()
const PHONEISH = /^[\s()+\-.\d]{7,}$/
const storyId = (sk, firstId) => `ns_${createHash('sha1').update(`${sk}|${firstId}`).digest('base64url').slice(0, 20)}`
const maxPriority = (a, b) => ((PRIORITY_RANK[b] ?? -1) > (PRIORITY_RANK[a] ?? -1) ? b : a)
const fmtPhone = (tk) => { const d = clean(tk).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : clean(tk) }

const MORPH = {
  responding: { code: 'responding', label: 'Responding…', tone: 'cyan' },
  response_sent: { code: 'response_sent', label: 'Response sent ✓', tone: 'green', resolves: 'machine' },
  you_replied: { code: 'you_replied', label: 'You replied ✓', tone: 'green', resolves: 'operator', clearsNeeds: true },
  message_sent: { code: 'message_sent', label: 'Follow-up sent ✓', tone: 'green', resolves: 'machine' },
  handled: { code: 'handled', label: 'Handled by automation ✓', tone: 'green', resolves: 'machine' },
  held: { code: 'held', label: 'Held for your review', tone: 'gold', needs: true },
  automation_failed: { code: 'automation_failed', label: 'Automation failed', tone: 'red', needs: true },
  send_failed: { code: 'send_failed', label: 'Send failed', tone: 'red', needs: true },
  opted_out: { code: 'opted_out', label: 'Opted out · suppression applied', tone: 'neutral', resolves: 'machine', clearsNeeds: true },
  resumed: { code: 'resumed', label: 'Resumed ✓', tone: 'green', resolves: 'machine' },
  completed: { code: 'completed', label: 'Completed ✓', tone: 'green', resolves: 'machine' },
  restored: { code: 'restored', label: 'Restored ✓', tone: 'green', resolves: 'machine' },
  closed: { code: 'closed', label: 'Closed ✓', tone: 'green', resolves: 'machine' },
}

/** Rail transients already voice these moments live; the plane stays silent for them (one event = one sound). */
const RAIL_VOICED = new Set(['seller.replied', 'seller.emoji_reply', 'seller.reaction', 'seller.language_request', 'seller.wrong_person', 'seller.hostile', 'seller.call_request', 'campaign.stalled', 'campaign.completed', 'closing.attention', 'closing.milestone', 'closing.completed', 'email.failed', 'message.failed'])
const SOUND = {
  attention: { category: 'needsAttention', priority: 1, cue: 'attention' },
  critical: { category: 'systemDegradation', priority: 1, cue: 'error', emphasis: 'strong' },
  warning: { category: 'systemDegradation', priority: 2, cue: 'warning' },
  error: { category: 'sendFailures', priority: 1, cue: 'error' },
  success: { category: 'closingMilestones', priority: 3, cue: 'success' },
  seller_reply: { category: 'sellerReplies', priority: 2, cue: 'ready', emphasis: 'subtle' },
}

/* ── items ─────────────────────────────────────────────────────────────── */

export function toItems({ events = [], notifications = [] }) {
  const byId = new Map()
  let duplicates = 0
  const add = (it) => {
    if (!it || !it.id || !Number.isFinite(ms(it.at))) return
    if (byId.has(it.id)) { duplicates += 1; return }
    byId.set(it.id, it)
  }
  for (const e of events) add(itemFromEvent(e))
  for (const r of notifications) add(itemFromNotification(r))
  const items = [...byId.values()]
  // a seller fact without a property joins the thread's only conversation in the window
  const props = new Map()
  for (const it of items) if (it.subject?.type === 'seller' && it.subject.property_id) (props.get(it.subject.thread_key) || props.set(it.subject.thread_key, new Set()).get(it.subject.thread_key)).add(it.subject.property_id)
  for (const it of items) {
    if (it.subject?.type === 'seller' && !it.subject.property_id) {
      const p = props.get(it.subject.thread_key)
      if (p?.size === 1) it.subject = { ...it.subject, property_id: [...p][0] }
    }
    it.sk = subjectKey(it.subject)
    it.t = ms(it.at)
  }
  items.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { items, duplicates }
}

/* ── bursts ────────────────────────────────────────────────────────────── */

function newBurst(it, kind) {
  return { sk: it.sk, subject: it.subject, kind, condition: it.condition || null, first: it, items: [it], triggers: [it], startMs: it.t, lastTriggerMs: it.t, resolver: null }
}

export function groupBursts(items) {
  const bursts = []
  const lastBySubject = new Map()
  const openCondition = new Map()
  const byTrigger = new Map()
  const bySid = new Map()
  const byEventId = new Map()
  const index = (b, it) => {
    byEventId.set(it.id, b)
    if (it.role === 'trigger') {
      byTrigger.set(it.id, b)
      if (it.causal?.provider_sid) bySid.set(it.causal.provider_sid, b)
    }
  }
  // pass 1 — triggers + resolvers
  for (const it of items) {
    if (!it.sk) continue
    if (it.role === 'trigger') {
      const kind = it.kind || 'milestone'
      // a signal fired by a specific event belongs to that event's story
      if (it.signal && it.causal?.source_event_id && byEventId.get(it.causal.source_event_id)) { const host = byEventId.get(it.causal.source_event_id); host.items.push({ ...it, role: 'derivative' }); index(host, it); continue }
      if (kind === 'condition') {
        const ck = `${it.sk}#${it.condition}`
        const open = openCondition.get(ck)
        if (open) { open.items.push(it); open.triggers.push(it); open.lastTriggerMs = it.t; index(open, it); continue }
        const b = newBurst(it, 'condition'); bursts.push(b); openCondition.set(ck, b); index(b, it); continue
      }
      const cur = lastBySubject.get(it.sk)
      if (cur && cur.kind === kind && it.t - cur.lastTriggerMs <= BURST_WINDOW_MS) { cur.items.push(it); cur.triggers.push(it); cur.lastTriggerMs = it.t; index(cur, it); continue }
      const b = newBurst(it, kind); bursts.push(b); lastBySubject.set(it.sk, b); index(b, it)
    } else if (it.role === 'resolver') {
      const ck = `${it.sk}#${it.condition}`
      const open = openCondition.get(ck)
      if (open) { open.items.push(it); open.resolver = it; openCondition.delete(ck); index(open, it); continue }
      if (it.standalone) { const b = newBurst({ ...it, role: 'trigger' }, 'milestone'); b.resolver = it; bursts.push(b); lastBySubject.set(it.sk, b); index(b, it) }
    }
  }
  const bySubject = new Map()
  for (const b of bursts) (bySubject.get(b.sk) || bySubject.set(b.sk, []).get(b.sk)).push(b)
  const windowJoin = (it, list) => {
    let pick = null
    for (const b of list || []) if (b.startMs - SKEW_MS <= it.t && it.t - b.lastTriggerMs <= DERIVATIVE_WINDOW_MS) pick = b
    return pick
  }
  // pass 2 — derivatives and restatements
  const orphans = []
  const late = []
  for (const it of items) {
    if (!it.sk || (it.role !== 'derivative' && it.role !== 'restatement')) continue
    const c = it.causal || {}
    const b = (c.message_id && byTrigger.get(c.message_id)) || (c.provider_sid && bySid.get(c.provider_sid)) || (c.source_event_id && byEventId.get(c.source_event_id)) || windowJoin(it, bySubject.get(it.sk))
    if (b) { b.items.push(it); index(b, it); continue }
    // a reply that answers the conversation later (outside the burst window) still answers it:
    // it morphs the subject's latest earlier story instead of becoming noise
    if (LATE_MORPHS.has(it.morph)) { late.push(it); continue }
    orphans.push(it)
  }
  // pass 3 — standalone orphans open their own story; the rest may join them
  const orphanBursts = new Map()
  for (const it of orphans) {
    if (!it.standalone || it.role === 'restatement') continue
    const cur = orphanBursts.get(it.sk)
    if (cur && it.t - cur.lastTriggerMs <= DERIVATIVE_WINDOW_MS) { cur.items.push(it); cur.triggers.push(it); cur.lastTriggerMs = it.t; continue }
    const b = newBurst(it, 'fact'); bursts.push(b); orphanBursts.set(it.sk, b)
  }
  let machineFeedOnly = 0
  for (const it of orphans) {
    if (it.standalone && it.role !== 'restatement') continue
    const ob = orphanBursts.get(it.sk)
    const b = ob ? windowJoin(it, [ob]) : null
    if (b) b.items.push(it)
    else machineFeedOnly += 1
  }
  // late answers (after pass 3, so fact stories count): the subject's latest earlier story
  for (const it of late) {
    let prior = null
    for (const b of bursts) if (b.sk === it.sk && b.startMs <= it.t && (!prior || b.startMs > prior.startMs)) prior = b
    if (prior) prior.items.push(it)
    else machineFeedOnly += 1
  }
  for (const b of bursts) b.items.sort((x, y) => x.t - y.t || (x.id < y.id ? -1 : 1))
  return { bursts, machineFeedOnly }
}

/* ── one burst → one story ────────────────────────────────────────────── */

function displayName(b, names) {
  for (const it of b.items) if (it.name && !PHONEISH.test(it.name)) return it.name
  if (b.subject?.type === 'seller' && names?.get(b.subject.thread_key)) return names.get(b.subject.thread_key)
  for (const it of b.items) if (it.name) return it.name
  return b.subject?.type === 'seller' ? fmtPhone(b.subject.thread_key) : null
}

const DEEP = {
  seller: (s) => `/inbox?thread=${encodeURIComponent(s.thread_key)}`,
  campaign: (s) => `/campaign-command?campaign=${encodeURIComponent(s.id)}`,
  closing: (s) => `/closing-desk?case=${encodeURIComponent(s.id)}`,
  deal: (s) => `/pipeline?opp=${encodeURIComponent(s.id)}`,
  property: (s) => `/deal-intelligence?property_id=${encodeURIComponent(s.id)}`,
}
const SYSTEM_LINK = { senders: '/queue', platform: '/queue', email: '/email-command' }

/** Persisted / legacy operator state for one story (READ ≠ RESOLVED). */
function operatorState(b, persisted, lastTriggerMs) {
  const st = persisted || null
  const at = (v) => { const t = ms(v); return Number.isFinite(t) ? t : NaN }
  const fresh = (v) => Number.isFinite(at(v)) && at(v) >= lastTriggerMs - SKEW_MS
  const rows = b.items.filter((it) => it.notification).map((it) => it.notification)
  let resolvedAt = st && fresh(st.resolved_at) && !st.reopened ? st.resolved_at : null
  let readAt = st && fresh(st.read_at) ? st.read_at : null
  if (st && st.unread_at && fresh(st.unread_at) && (!readAt || at(st.unread_at) > at(readAt))) readAt = null
  let source = st ? 'table' : null
  if (rows.length) {
    // legacy: the old bell's own state on the member alerts (dismissed / cleared by the operator)
    const opDone = rows.every((r) => (r.status === 'dismissed' && fresh(r.dismissed_at || r.updated_at)) || (r.status === 'resolved' && !r.action_state?.resolve_reason && fresh(r.resolved_at)))
    if (!resolvedAt && !st && opDone) { resolvedAt = rows.map((r) => r.resolved_at || r.dismissed_at).filter(Boolean).sort().pop() || null; source = 'notification_rows' }
    const allRead = rows.every((r) => fresh(r.read_at) || r.status === 'dismissed')
    if (!readAt && !(st && st.unread_at && fresh(st.unread_at)) && allRead) { readAt = rows.map((r) => r.read_at).filter(Boolean).sort().pop() || null; source = source || 'notification_rows' }
    source = source || 'notification_rows'
  }
  return { resolvedAt, readAt: readAt || resolvedAt, persistence: source || 'none' }
}

export function assembleStory(b, { state = new Map(), now = Date.now(), names = null } = {}) {
  const sk = b.sk
  const id = storyId(sk, b.first.id)
  const s = b.subject
  const triggers = b.triggers
  const lastTrigger = triggers[triggers.length - 1]
  const lastTriggerMs = b.lastTriggerMs
  const chainItems = b.items.filter((it) => it.role !== 'restatement')
  const name = displayName(b, names)

  // priority / operator need
  let peak = 'info'
  let needs = false
  let needsLabel = null
  for (const it of chainItems) {
    if (it.priority) peak = maxPriority(peak, it.priority)
    if (it.needs_operator && !it.resolved_at && it.t >= lastTriggerMs - SKEW_MS) { needs = true; needsLabel = it.label || needsLabel }
  }
  if (b.kind === 'message') peak = maxPriority(peak, 'important')

  // live morph: the latest morph after the latest trigger
  let morph = null
  let machineResolvedAt = null
  if (b.kind === 'condition') {
    if (b.resolver && b.resolver.t >= lastTriggerMs) { morph = MORPH[b.resolver.morph] || MORPH.restored; machineResolvedAt = b.resolver.at }
    else {
      const rowsResolved = triggers.length && triggers.every((t) => t.resolved_at)
      if (rowsResolved) { morph = MORPH.restored; machineResolvedAt = triggers.map((t) => t.resolved_at).sort().pop() }
    }
    if (morph) needs = false
  } else {
    for (const it of chainItems) if (it.morph && MORPH[it.morph] && it.t >= lastTriggerMs - SKEW_MS) morph = MORPH[it.morph]
    if (morph?.needs) needsLabel = morph.label
    if (b.kind === 'milestone' && b.resolver) morph = MORPH[b.resolver.morph] || morph
    if (morph?.needs) needs = true
    if (morph?.clearsNeeds) needs = false
    if (morph?.resolves) machineResolvedAt = chainItems.filter((it) => it.morph === morph.code || MORPH[it.morph] === morph).map((it) => it.at).pop() || null
  }

  const op = operatorState(b, state.get(id), lastTriggerMs)
  const machineResolved = Boolean(morph?.resolves) && !needs
  const resolvedBy = op.resolvedAt ? 'operator' : machineResolved ? (morph.resolves === 'operator' ? 'operator' : 'machine') : null
  const resolved = Boolean(resolvedBy)
  const resolvedAt = op.resolvedAt || (resolved ? machineResolvedAt || lastTrigger.at : null)
  if (resolved) needs = false
  const priority = resolved ? 'info' : needs ? maxPriority(peak, 'action') : peak === 'action' ? 'important' : peak
  const peakPriority = s?.type === 'seller' && peak === 'critical' ? 'action' : peak

  const lens = s.type === 'system' ? 'system' : resolved ? 'resolved' : needs ? 'needs_you' : 'now'

  // copy: WHO/WHAT · WHAT CHANGED · WHY IT MATTERS · WHEN
  const messages = triggers.filter((t) => t.kind === 'message').length
  const facts = []
  const seen = new Set()
  for (const it of chainItems) {
    if (it === lastTrigger || it.role === 'trigger' && it.kind === 'message' || it.morph && MORPH[it.morph]) continue
    if (it.role === 'resolver') continue
    if (!it.label || seen.has(it.label)) continue
    seen.add(it.label); facts.push(it.label)
  }
  let title
  let summary
  const campaignName = b.items.map((it) => it.campaign_name).find(Boolean) || null
  if (s.type === 'seller') {
    const verb = lastTrigger.verb || null
    title = verb ? `${name} ${verb}` : `${name} · ${lastTrigger.label}`
    if (messages > 1) title = `${title} · ${messages} messages`
    const preview = [...triggers].reverse().map((t) => t.preview).find(Boolean)
    summary = facts.length ? facts.slice(0, 3).join(' · ') : preview ? `“${preview}”` : null
  } else if (s.type === 'campaign') {
    title = `${campaignName || 'Campaign'} · ${b.first.label}`
    summary = facts.length ? facts.slice(0, 2).join(' · ') : b.first.detail || null
  } else if (s.type === 'system') {
    const labels = [...new Set(triggers.map((t) => t.label).filter(Boolean))]
    title = b.kind === 'condition' ? `${systemLabel(s.id)} degraded` : `${systemLabel(s.id)} · ${b.first.label}`
    summary = labels.length ? labels.slice(0, 3).join(' · ') + (labels.length > 3 ? ` · +${labels.length - 3} more` : '') : null
  } else if (s.type === 'workflow') {
    title = `${b.items.map((it) => it.workflow_name).find(Boolean) || capFirst(s.id.replace(/_/g, ' '))} · ${lastTrigger.label}`
    summary = lastTrigger.detail || null
  } else {
    title = `${capFirst(s.type)} · ${lastTrigger.label}`
    summary = lastTrigger.detail || null
  }

  // object + links (canonical ids only)
  const opp = b.items.map((it) => it.opportunity_id).find(Boolean) || null
  const run = [...b.items].reverse().map((it) => it.run).find((r) => r?.key) || null
  let deepLink = null
  let object = null
  let replay = null
  const missions = []
  if (s.type === 'seller') {
    deepLink = DEEP.seller(s)
    object = { type: 'seller', id: s.thread_key, label: name, hint: { thread_key: s.thread_key, property_id: s.property_id } }
    replay = { type: 'seller', id: s.thread_key, label: name }
    missions.push({ kind: 'work_seller', label: 'Work this seller' })
    if (opp) missions.push({ kind: 'move_deal', label: 'Move this deal' })
  } else if (s.type === 'campaign') {
    deepLink = DEEP.campaign(s); object = { type: 'campaign', id: s.id, label: campaignName }; replay = { type: 'campaign', id: s.id, label: campaignName }
  } else if (s.type === 'closing') {
    deepLink = DEEP.closing(s); object = { type: 'closing', id: s.id, label: null }; replay = { type: 'closing', id: s.id, label: null }
  } else if (s.type === 'workflow') {
    deepLink = `/workflow-studio?wf=${encodeURIComponent(s.id)}${run?.id ? `&run=${encodeURIComponent(run.id)}` : ''}`
    object = { type: 'workflow', id: s.id, label: null }
    if (run?.id) replay = { type: 'workflow', id: `${s.id}:${run.id}`, label: null }
  } else if (s.type === 'deal' || s.type === 'property') {
    deepLink = DEEP[s.type](s); object = { type: s.type, id: s.id, label: null }
    if (s.type === 'property') replay = { type: 'property', id: s.id, label: null }
  } else if (s.type === 'system') {
    deepLink = SYSTEM_LINK[s.id] || null
  }
  // a seller run held for review opens the run in Studio; the conversation stays the primary
  const runLink = s.type === 'seller' && run?.id && (morph?.code === 'held' || morph?.code === 'automation_failed') ? `/workflow-studio?wf=${encodeURIComponent(run.key)}&run=${encodeURIComponent(run.id)}` : null

  // sound: one per trigger, the latest one; derivatives are silent; rail-voiced moments stay with the rail
  const soundItem = [...triggers].reverse().find((t) => t.sound) || null
  const cue = soundItem ? SOUND[soundItem.sound] : null
  const sound = cue && !resolved ? { id: `story:${soundItem.id}`, ...cue, at: soundItem.t, voiced_by: RAIL_VOICED.has(soundItem.event_type) ? 'rail' : 'plane' } : null

  const createdAt = b.items[0].at
  const updatedAt = [b.items[b.items.length - 1].at, machineResolvedAt].filter(Boolean).sort().pop()
  return {
    id,
    subject: s.type === 'seller' ? { type: 'seller', id: s.thread_key, thread_key: s.thread_key, property_id: s.property_id, label: name } : { type: s.type, id: s.id, label: s.type === 'campaign' ? campaignName : s.type === 'system' ? systemLabel(s.id) : null },
    subject_key: sk,
    kind: b.kind,
    primary_event: { id: b.first.id, type: b.first.event_type, at: b.first.at },
    title,
    summary,
    reason: needs ? needsLabel || 'Needs your decision' : morph?.label || null,
    priority,
    peak_priority: peakPriority,
    lens,
    state: { code: morph?.code || (resolved ? 'handled' : 'open'), label: morph?.label || null, tone: morph?.tone || null },
    requires_operator: needs,
    resolved,
    resolved_by: resolvedBy,
    resolved_at: resolvedAt,
    read: Boolean(op.readAt),
    read_at: op.readAt,
    persistence: op.persistence,
    aged: resolved && now - ms(resolvedAt || updatedAt) > AGE_INTO_HISTORY_MS,
    created_at: createdAt,
    updated_at: updatedAt,
    last_trigger_at: lastTrigger.at,
    counts: { messages, events: chainItems.length },
    chain: chainItems.map((it) => ({ id: it.id, at: it.at, label: it.label, detail: it.detail || null, tone: it.tone || 'neutral', role: it.role === 'restatement' ? 'derivative' : it.role, actor: it.actor || null, type: it.event_type || null })),
    source_event_ids: b.items.map((it) => it.id),
    notification_ids: b.items.filter((it) => it.notification).map((it) => String(it.notification.id)),
    deep_link: deepLink,
    run_link: runLink,
    object,
    replay,
    missions,
    sound,
  }
}

/**
 * One conversation, one live need: when the same seller conversation has a newer
 * story, an older story's open need is carried by the newer one — the older one
 * moves to history as superseded (it never re-asks).
 */
export function supersede(stories) {
  const latest = new Map()
  for (const s of stories) if (s.subject.type === 'seller') { const cur = latest.get(s.subject_key); if (!cur || s.last_trigger_at > cur.last_trigger_at) latest.set(s.subject_key, s) }
  for (const s of stories) {
    if (s.subject.type !== 'seller' || latest.get(s.subject_key) === s || s.resolved) continue
    s.requires_operator = false
    s.resolved = true
    s.resolved_by = 'superseded'
    s.resolved_at = latest.get(s.subject_key).last_trigger_at
    s.reason = 'Superseded by newer activity'
    s.priority = 'info'
    s.lens = 'resolved'
    s.sound = null
  }
  return stories
}

const rankLens = { needs_you: 0, system: 1, now: 2, resolved: 3 }

/** items → stories, newest activity first. */
export function buildStories({ events = [], notifications = [], state = new Map(), now = Date.now() } = {}) {
  const { items, duplicates } = toItems({ events, notifications })
  const { bursts, machineFeedOnly } = groupBursts(items)
  const names = new Map()
  for (const it of items) if (it.subject?.type === 'seller' && it.name && !PHONEISH.test(it.name)) names.set(it.subject.thread_key, it.name)
  const stories = bursts.map((b) => assembleStory(b, { state, now, names }))
  supersede(stories)
  stories.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? 1 : -1))
  return { stories, stats: { items: items.length, duplicates, machine_feed_only: machineFeedOnly, stories: stories.length } }
}

/**
 * The badge: how many things need my attention — meaningful unresolved stories,
 * never raw events. NEEDS YOU + unresolved critical/important system stories +
 * unread important NOW stories.
 */
export function countStories(stories) {
  const c = { badge: 0, needs_you: 0, now: 0, now_unread: 0, resolved: 0, system: 0, system_active: 0 }
  for (const s of stories) {
    c[s.lens] += 1
    if (s.lens === 'now' && !s.read) c.now_unread += 1
    if (s.lens === 'system' && !s.resolved) c.system_active += 1
    const meaningful = !s.resolved && (s.requires_operator || s.priority === 'critical' || (s.lens === 'now' && !s.read && PRIORITY_RANK[s.priority] >= 1))
    if (meaningful) c.badge += 1
  }
  return c
}

export { rankLens }
