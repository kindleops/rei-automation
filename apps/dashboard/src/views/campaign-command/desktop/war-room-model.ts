/**
 * CAMPAIGN COMMAND 3.0 — the war room's model.
 *
 * Pure functions over the reads (the campaign book, the cockpit read, the
 * intel read). They name what the machine is doing — they never decide
 * eligibility, routing, intent or send authority, and they never estimate a
 * number the reads do not carry. Where a value is a deterministic projection
 * (days to finish at today's pace) it is labelled as an estimate.
 *
 * Units are never mixed: the execution river counts SELLERS (campaign
 * targets) from audience to reply, then OPPORTUNITIES. Messages (retries,
 * conversation replies) are counted apart, in the delivery funnel.
 */
import type { CampaignSummary } from '../campaigns.types'
import type { CockpitRead, CockpitWindow } from './cockpit-api'
import type { BookCampaign, CampaignIntel, FeederDigest, FleetNumber, ReplyBucketKey, ReplyBuckets, WarSystem } from './war-room-api'
import { feederSkipWords, holdWords } from './cockpit-model'

/* ══ numbers + time ════════════════════════════════════════════════════════ */

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase()
export const nf = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US'))
export const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`

/** A share as "87.5%", or null without a denominator. */
export function pct(num: number | null | undefined, den: number | null | undefined, digits = 1): string | null {
  if (num === null || num === undefined || den === null || den === undefined || !(den > 0)) return null
  const v = (num / den) * 100
  return `${v >= 99.95 || v === 0 ? v.toFixed(0) : v.toFixed(digits)}%`
}

export function pctValue(num: number | null | undefined, den: number | null | undefined): number | null {
  if (num === null || num === undefined || den === null || den === undefined || !(den > 0)) return null
  return Math.max(0, Math.min(100, (num / den) * 100))
}

/** "$319K", "$1.2M" — currency figures are always labelled by basis where shown. */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${Math.round(n)}`
}

const t = (iso: string | null | undefined): number | null => {
  const v = Date.parse(String(iso ?? ''))
  return Number.isFinite(v) ? v : null
}

/** "CDT", "EST" for a zone at an instant. */
export function zoneAbbr(tz: string | null | undefined, at = Date.now()): string | null {
  if (!tz) return null
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')
    return part?.value ?? null
  } catch { return null }
}

/** "Central", "Eastern" — the zone's family name. */
export function zoneFamily(tz: string | null | undefined): string | null {
  if (!tz) return null
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? ''
    const m = name.match(/^(\w+)/)
    return m ? m[1] : tz
  } catch { return tz }
}

/** "8:00 AM CDT" in a zone. */
export function clock(iso: string | null | undefined, tz?: string | null, zone = true): string | null {
  const v = t(iso)
  if (v === null) return null
  const tzName = zone ? 'short' as const : undefined
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined, timeZoneName: tzName }).format(new Date(v))
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: tzName }).format(new Date(v))
  }
}

const dayKey = (ms: number, tz?: string | null) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)) } catch { return new Date(ms).toISOString().slice(0, 10) }
}

/** "Today 8:00 AM CDT", "Tomorrow 8:00 AM CDT", "Sep 30, 11:11 AM CDT". */
export function dayClock(iso: string | null | undefined, tz: string | null | undefined, now: number): string | null {
  const v = t(iso)
  if (v === null) return null
  const c = clock(iso, tz)
  const d = dayKey(v, tz)
  if (d === dayKey(now, tz)) return `Today ${c}`
  if (d === dayKey(now + 86_400_000, tz)) return `Tomorrow ${c}`
  if (d === dayKey(now - 86_400_000, tz)) return `Yesterday ${c}`
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz || undefined }).format(new Date(v))
  return `${date}, ${c}`
}

/** "in 2h 29m", "38s", "4 min ago". */
export function relative(iso: string | null | undefined, now: number): string | null {
  const v = t(iso)
  if (v === null) return null
  const d = v - now
  const s = Math.round(Math.abs(d) / 1000)
  const unit = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60) ? ` ${Math.round((s % 3600) / 60)}m` : ''}` : `${Math.round(s / 86400)} days`
  if (d >= 0) return s < 5 ? 'now' : `in ${unit}`
  return s < 45 ? 'just now' : `${unit} ago`
}

/** Hours since local midnight (0–24) in a zone. */
export function localHour(ms: number, tz?: string | null): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
    return Number(parts.hour) + Number(parts.minute) / 60
  } catch { return new Date(ms).getHours() + new Date(ms).getMinutes() / 60 }
}

/* ══ vocabulary ═══════════════════════════════════════════════════════════ */

export type Tone = 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral'
export type Owner = 'system' | 'operator' | 'provider' | 'campaign' | 'sender'
export const OWNER_LABEL: Record<Owner, string> = { system: 'System', operator: 'Operator', provider: 'Provider', campaign: 'Campaign', sender: 'Sender' }

export type GateKey = 'schedule' | 'window' | 'eligibility' | 'suppression' | 'identity' | 'template' | 'sender' | 'capacity' | 'queue' | 'provider' | 'delivery'
export const GATE_ORDER: GateKey[] = ['schedule', 'window', 'eligibility', 'suppression', 'identity', 'template', 'sender', 'capacity', 'queue', 'provider', 'delivery']
export const GATE_LABEL: Record<GateKey, string> = {
  schedule: 'Schedule', window: 'Contact window', eligibility: 'Eligibility', suppression: 'Suppression', identity: 'Identity',
  template: 'Template', sender: 'Sender', capacity: 'Capacity', queue: 'Queue', provider: 'Provider', delivery: 'Delivery',
}

/** Which gate a canonical skip / hold reason belongs to. */
export function gateOfReason(code: string): GateKey {
  const c = lower(code)
  if (/template|no_template|rotation_pool|unsupported_language|render|lint/.test(c)) return 'template'
  if (/cap_reached|window_full|capacity|daily_cap/.test(c)) return 'capacity'
  if (/routing|sender|local_sender|no_local/.test(c)) return 'sender'
  if (/suppress|dnc|opt_out|opted_out|prior_contacted|graph_suppression|21610|blacklist/.test(c)) return 'suppression'
  if (/identity|entity_contact|ambiguous_phone|owner_identity|linkage/.test(c)) return 'identity'
  return 'eligibility'
}

/* ══ inputs ═══════════════════════════════════════════════════════════════ */

export type WarInput = {
  summary?: CampaignSummary | null
  book?: BookCampaign | null
  core?: CockpitRead | null
  intel?: CampaignIntel | null
  system?: WarSystem | null
}

const LIVE = ['active', 'activating', 'live_limited']
const SCHEDULED = ['scheduled', 'queued']
const PRELAUNCH = ['draft', 'built', 'previewed', 'ready']
export const isLiveStatus = (s: string | null | undefined) => LIVE.includes(lower(s))

export const FEEDER_STALE_MS = 15 * 60 * 1000
export const PROCESSOR_STALE_MS = 5 * 60 * 1000

/** One source of truth per figure: the freshest read that carries it. */
export function facts(input: WarInput) {
  const { summary, book, core, intel } = input
  const status = lower(book?.status ?? summary?.status ?? core?.status)
  const total = core?.targets?.total ?? book?.targets?.total ?? summary?.total_targets ?? null
  const held = core?.targets?.held ?? book?.targets?.held ?? summary?.held_targets ?? null
  const ready = core?.targets?.ready ?? book?.targets?.ready ?? summary?.ready_targets ?? null
  const planned = core?.targets ? Number(core.targets.by_status.planned ?? 0) : book?.targets?.planned ?? summary?.planned_targets ?? null
  const heldByReason = core?.targets?.held_by_reason ?? book?.targets?.held_by_reason ?? null
  const eligible = total === null ? null : Math.max(0, total - (held ?? 0))
  const queueLive = core?.queue?.live ?? book?.queue?.live ?? summary?.live_queue?.live ?? null
  const overdue = core?.queue?.overdue ?? book?.queue?.overdue ?? summary?.live_queue?.overdue ?? 0
  const due = core?.queue?.due ?? book?.queue?.due ?? 0
  const sent = intel?.sellers?.left_us ?? book?.sends?.sellers_dispatched ?? null
  const delivered = intel?.sellers?.delivered ?? book?.sends?.sellers_delivered ?? null
  const replied = intel?.replies?.sellers_replied ?? book?.replies?.sellers_replied ?? core?.responses?.sellers_replied ?? null
  const buckets: ReplyBuckets | null = intel?.replies?.buckets ?? book?.replies?.buckets ?? null
  const opportunities = intel?.outcomes ? intel.outcomes.opportunities.length : null
  const feeder: FeederDigest | null = (book?.feeder ?? (core?.feeder.campaign_last as FeederDigest | null | undefined) ?? null) || null
  const window: (CockpitWindow & { reason?: string }) | null = core?.window ?? book?.window ?? null
  const tz = core?.lineage.timezone ?? book?.timezone ?? summary?.lineage?.timezone ?? null
  const missedFor = core?.lifecycle.schedule_missed_for ?? book?.schedule?.missed_for ?? summary?.schedule_missed_for ?? null
  const scheduledFor = core?.lifecycle.scheduled_for ?? book?.schedule?.scheduled_for ?? null
  const sourceKind = core?.lineage.kind ?? book?.source.kind ?? summary?.lineage?.kind ?? 'none'
  const explicit = core?.lineage.explicit_property_count ?? book?.source.explicit_count ?? summary?.lineage?.explicit_property_count ?? null
  const quarantined = Boolean(book?.quarantined ?? summary?.quarantined ?? core?.flags.quarantine)
  return { status, total, held, ready, planned, heldByReason, eligible, queueLive, overdue, due, sent, delivered, replied, buckets, opportunities, feeder, window, tz, missedFor, scheduledFor, sourceKind, explicit, quarantined }
}

/* ══ the system ═══════════════════════════════════════════════════════════ */

export type SystemPosture = { ok: boolean; key: 'ok' | 'emergency_stop' | 'sending_off' | 'processor_stale' | 'feeder_stale' | 'unknown'; label: string; detail: string | null }

export function systemPosture(system: WarSystem | null | undefined, readAt: number): SystemPosture {
  if (!system) return { ok: true, key: 'unknown', label: 'System state unavailable', detail: null }
  const p = system.processor
  if (p.emergency_stop_at) return { ok: false, key: 'emergency_stop', label: 'Emergency stop', detail: 'Sending is emergency-stopped system-wide. No message leaves until it is lifted.' }
  if (p.outbound_sms === false || (p.mode && p.mode !== 'live') || (p.execution_mode && lower(p.execution_mode) !== 'normal')) {
    return { ok: false, key: 'sending_off', label: 'Sending switched off', detail: p.outbound_sms === false ? 'Outbound SMS is disabled.' : p.mode && p.mode !== 'live' ? `The queue processor is in “${p.mode}” mode.` : `Queue execution is “${p.execution_mode}”.` }
  }
  const proc = t(p.heartbeat_at)
  if (proc === null || readAt - proc > PROCESSOR_STALE_MS) return { ok: false, key: 'processor_stale', label: 'Queue processor silent', detail: proc === null ? 'No processor heartbeat on record.' : 'The queue processor has not checked in for more than 5 minutes.' }
  const feed = t(system.feeder.heartbeat_at)
  if (feed === null || readAt - feed > FEEDER_STALE_MS) return { ok: false, key: 'feeder_stale', label: 'Campaign feeder silent', detail: feed === null ? 'No feeder heartbeat on record.' : 'The campaign feeder has not checked in for more than 15 minutes.' }
  return { ok: true, key: 'ok', label: 'Runtime healthy', detail: null }
}

/* ══ mission state (the rail's grouping + the hero's status) ══════════════ */

export type GroupKey = 'live' | 'attention' | 'scheduled' | 'waiting' | 'paused' | 'drafts' | 'completed' | 'archived'
export const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: 'live', label: 'Live now' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'waiting', label: 'Waiting for window' },
  { key: 'paused', label: 'Paused' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'completed', label: 'Completed' },
  { key: 'archived', label: 'Archived' },
]

export type MissionKey =
  | 'live' | 'waiting_window' | 'waiting_capacity' | 'scheduled' | 'missed_schedule' | 'needs_attention' | 'degraded'
  | 'no_audience' | 'paused' | 'audience_built' | 'draft' | 'targeting_required' | 'completed' | 'cancelled' | 'archived'

export type Mission = {
  key: MissionKey
  group: GroupKey
  /** the status word, uppercase in the UI */
  label: string
  tone: Tone
  /** why, in one line */
  why: string | null
  gate: GateKey | null
  owner: Owner | null
  live: boolean
}

const M = (key: MissionKey, group: GroupKey, label: string, tone: Tone, extra: Partial<Mission> = {}): Mission => ({ key, group, label, tone, why: null, gate: null, owner: null, live: false, ...extra })

/** The feeder's last pass, read as a gate: which reasons stopped it, and how many sellers. */
export function feederBlock(feeder: FeederDigest | null | undefined): { gate: GateKey; count: number; reasons: Array<{ code: string; n: number; words: string }> } | null {
  if (!feeder || feeder.inserted > 0) return null
  const entries = Object.entries(feeder.skipped_counts_by_reason || {}).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1])
  if (!entries.length) return null
  const capacityOnly = entries.every(([code]) => gateOfReason(code) === 'capacity')
  const byGate = new Map<GateKey, number>()
  for (const [code, n] of entries) byGate.set(gateOfReason(code), (byGate.get(gateOfReason(code)) ?? 0) + Number(n))
  const gate = capacityOnly ? 'capacity' : [...byGate.entries()].filter(([g]) => g !== 'capacity').sort((a, b) => b[1] - a[1])[0][0]
  return {
    gate,
    count: entries.reduce((s, [, n]) => s + Number(n), 0),
    reasons: entries.map(([code, n]) => ({ code, n: Number(n), words: feederSkipWords(code) })),
  }
}

export function missionOf(input: WarInput, now: number): Mission {
  const f = facts(input)
  const status = f.status
  if (status === 'archived') return M('archived', 'archived', 'Archived', 'neutral')
  if (status === 'completed') return M('completed', 'completed', 'Completed', 'ok')
  if (status === 'cancelled' || status === 'canceled') return M('cancelled', 'completed', 'Cancelled', 'neutral')
  if (status === 'paused') return M('paused', 'paused', 'Paused', 'neutral', { owner: 'operator', why: f.ready ? `${plural(f.ready, 'ready seller')} wait for Resume.` : 'Nothing left to place; held rows wait for Resume.' })
  if (status === 'failed') return M('needs_attention', 'attention', 'Needs attention', 'attn', { why: 'The last launch did not complete.', owner: 'operator', gate: 'schedule' })

  if (SCHEDULED.includes(status)) {
    if (f.missedFor) {
      return M('missed_schedule', 'attention', 'Missed schedule', 'attn', {
        why: `Did not start at ${dayClock(f.missedFor, f.tz, now) ?? 'its planned time'}. It will not send until it is rescheduled or launched.`,
        gate: 'schedule', owner: 'operator',
      })
    }
    return M('scheduled', 'scheduled', 'Scheduled', 'exec', { why: f.scheduledFor ? `Starts ${dayClock(f.scheduledFor, f.tz, now)}.` : null, gate: 'schedule', owner: 'system' })
  }

  if (PRELAUNCH.includes(status) || !status) {
    if ((f.total ?? 0) > 0) return M('audience_built', 'drafts', 'Audience built', 'neutral', { why: `${plural(f.eligible ?? 0, 'eligible seller')} — schedule or launch it.`, owner: 'operator' })
    if (f.sourceKind === 'none' && !input.summary?.has_target_definition) return M('targeting_required', 'drafts', 'Targeting required', 'neutral', { why: 'Select a market, cohort, or filter set.', owner: 'operator', gate: 'eligibility' })
    return M('draft', 'drafts', 'Draft', 'neutral', { why: 'Targeting is set — build the audience next.', owner: 'operator' })
  }

  if (!LIVE.includes(status)) return M('draft', 'drafts', status ? status.replace(/_/g, ' ') : 'Draft', 'neutral')

  // ── live ──
  const readAt = t(input.core?.at) ?? now
  const posture = systemPosture(input.system, Math.min(now, readAt))
  if (input.system && !posture.ok) {
    const gate: GateKey = posture.key === 'emergency_stop' || posture.key === 'sending_off' ? 'provider' : 'queue'
    return M('degraded', 'attention', 'Degraded', 'crit', { why: posture.detail, gate, owner: 'system' })
  }
  if (f.quarantined) return M('needs_attention', 'attention', 'Audience requires review', 'attn', { why: 'The audience reached beyond the selection; the planner refuses it until reviewed.', gate: 'eligibility', owner: 'operator' })
  if ((f.total ?? 0) === 0) return M('no_audience', 'attention', 'No executable audience', 'attn', { why: 'Live with 0 targets — the feeder finds nothing to send on every pass.', gate: 'eligibility', owner: 'operator' })
  if (f.overdue > 0) return M('needs_attention', 'attention', 'Queue degraded', 'crit', { why: `${plural(f.overdue, 'message')} overdue in the queue.`, gate: 'queue', owner: 'system' })

  const block = feederBlock(f.feeder)
  if (block && block.gate !== 'capacity' && (f.ready ?? 0) > 0) {
    const label = block.gate === 'template' ? 'Template unavailable' : block.gate === 'sender' ? 'No eligible sender' : block.gate === 'identity' ? 'Audience requires review' : 'Needs attention'
    return M('needs_attention', 'attention', label, 'attn', {
      why: `${plural(f.ready ?? block.count, 'ready seller')} can’t be placed: ${block.reasons.slice(0, 2).map((r) => `${r.words} (${nf(r.n)})`).join(', ')}.`,
      gate: block.gate, owner: 'operator',
    })
  }
  if (f.feeder?.bound === 'daily_cap_reached') return M('waiting_capacity', 'live', 'Daily cap reached', 'exec', { why: 'Today’s cap is spent; the remainder continues tomorrow.', gate: 'capacity', owner: 'campaign', live: true })
  if (block && block.gate === 'capacity') return M('waiting_capacity', 'live', 'Waiting for capacity', 'exec', { why: 'Sender capacity for today is spent; the remainder waits.', gate: 'capacity', owner: 'sender', live: true })
  if (f.window?.open === false) {
    return M('waiting_window', 'waiting', 'Waiting for window', 'neutral', {
      why: f.window.next_open_at ? `Contact window opens ${dayClock(f.window.next_open_at, f.window.timezone ?? f.tz, now)}.` : 'Contact window closed.',
      gate: 'window', owner: 'system', live: true,
    })
  }
  return M('live', 'live', 'Live', 'exec', { live: true, owner: 'system' })
}

/* ══ rail rows ════════════════════════════════════════════════════════════ */

export type RailRow = {
  id: string
  title: string
  eyebrow: string
  mission: Mission
  progress: { sent: number; of: number; pct: number } | null
  replies: number | null
  cue: string | null
  cueTone: Tone
}

const SOURCE_WORDS: Record<string, string> = { map_area: 'Map area', entity_graph: 'Entity Graph', filters: 'Filters', selection: 'Selected properties', none: 'Built audience' }

export function sourceWords(kind: string | null | undefined): string {
  return SOURCE_WORDS[lower(kind)] ?? 'Audience'
}

/** "Map area · Minneapolis, MN · 944 properties" → title "Minneapolis, MN", eyebrow "Map area · 944". */
export function nameParts(name: string, kind: string, explicit: number | null | undefined): { title: string; eyebrow: string } {
  const raw = String(name ?? '').trim() || 'Untitled campaign'
  const generated = raw.match(/^(Map area|Entity Graph)\s+·\s+(.+?)(?:\s+·\s+(\d[\d,]*)\s+propert(?:y|ies))?$/i)
  if (generated && generated[2] && !/^\d[\d,]*\s+propert/i.test(generated[2])) {
    const n = generated[3] ? Number(generated[3].replace(/,/g, '')) : explicit ?? null
    return { title: generated[2], eyebrow: `${generated[1]}${n ? ` · ${nf(n)}` : ''}` }
  }
  const countOnly = raw.match(/^(Map area|Entity Graph)\s+·\s+(\d[\d,]*)\s+propert(?:y|ies)$/i)
  if (countOnly) return { title: `${countOnly[1]} · ${countOnly[2]}`, eyebrow: `${countOnly[1]} · ${countOnly[2]} selected` }
  return { title: raw, eyebrow: `${sourceWords(kind)}${explicit ? ` · ${nf(explicit)}` : ''}` }
}

export function railRowOf(input: WarInput, now: number): RailRow {
  const b = input.book
  const f = facts(input)
  const mission = missionOf(input, now)
  const name = b?.name ?? input.summary?.campaign_name ?? 'Untitled campaign'
  const parts = nameParts(name, f.sourceKind, f.explicit)
  const of = f.eligible ?? 0
  const progress = of > 0 && (f.sent ?? 0) > 0 ? { sent: f.sent ?? 0, of, pct: Math.min(100, ((f.sent ?? 0) / of) * 100) } : null
  let cue: string | null = null
  let cueTone: Tone = 'neutral'
  switch (mission.key) {
    case 'missed_schedule': cue = `Missed start · ${plural(f.eligible ?? 0, 'eligible')}`; cueTone = 'attn'; break
    case 'scheduled': cue = f.scheduledFor ? `Starts ${dayClock(f.scheduledFor, f.tz, now)}` : 'Scheduled'; cueTone = 'exec'; break
    case 'waiting_window': cue = f.window?.next_open_at ? `Opens ${clock(f.window.next_open_at, f.window.timezone ?? f.tz)}` : 'Window closed'; break
    case 'needs_attention': {
      const block = feederBlock(f.feeder)
      cue = mission.gate === 'queue' ? `${nf(f.overdue)} overdue` : block ? `${GATE_LABEL[block.gate]} · ${nf(f.ready ?? block.count)} held` : mission.label
      cueTone = mission.tone
      break
    }
    case 'no_audience': cue = 'No audience'; cueTone = 'attn'; break
    case 'degraded': cue = 'Runtime degraded'; cueTone = 'crit'; break
    case 'waiting_capacity': cue = mission.label; cueTone = 'exec'; break
    case 'paused': cue = f.ready ? `${nf(f.ready)} ready` : 'Paused'; break
    case 'audience_built': cue = `${nf(f.eligible)} eligible`; break
    case 'targeting_required': cue = 'Targeting required'; break
    case 'draft': cue = 'Not built'; break
    case 'completed': cue = f.delivered !== null ? `${nf(f.delivered)} delivered` : 'Finished'; cueTone = 'ok'; break
    case 'live': {
      const q = f.queueLive ?? 0
      cue = q > 0 ? `${nf(q)} queued` : 'Refills every 5 min'
      cueTone = 'exec'
      break
    }
    default: break
  }
  return { id: b?.id ?? input.summary?.id ?? '', title: parts.title, eyebrow: parts.eyebrow, mission, progress, replies: f.replied, cue, cueTone }
}

export function groupRail(rows: RailRow[]): Array<{ key: GroupKey; label: string; rows: RailRow[] }> {
  return GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.mission.group === g.key) })).filter((g) => g.rows.length)
}

/** "3 live · 4 need attention · 1 scheduled · 6 drafts" */
export function bookLine(rows: RailRow[]): Array<{ key: string; text: string; tone: Tone }> {
  const n = (g: GroupKey) => rows.filter((r) => r.mission.group === g).length
  const live = rows.filter((r) => r.mission.live).length
  const out: Array<{ key: string; text: string; tone: Tone }> = []
  out.push({ key: 'live', text: `${nf(live)} live`, tone: live ? 'exec' : 'neutral' })
  const attn = n('attention')
  if (attn) out.push({ key: 'attention', text: `${nf(attn)} ${attn === 1 ? 'needs' : 'need'} attention`, tone: 'attn' })
  const sched = n('scheduled')
  if (sched) out.push({ key: 'scheduled', text: `${nf(sched)} scheduled`, tone: 'neutral' })
  const paused = n('paused')
  if (paused) out.push({ key: 'paused', text: `${nf(paused)} paused`, tone: 'neutral' })
  return out
}

/* ══ the execution river ══════════════════════════════════════════════════ */

export type RiverKey = 'audience' | 'eligible' | 'planned' | 'queued' | 'sent' | 'delivered' | 'replied' | 'opportunity'
export type RiverState = 'done' | 'active' | 'blocked' | 'waiting' | 'idle'
export type RiverNode = {
  key: RiverKey
  label: string
  value: number | null
  /** conversion from the previous stage (null on the first, and on the buffer) */
  rate: string | null
  sub: string | null
  subTone: Tone | null
  state: RiverState
  unit: string
  /** the queue node is instantaneous buffer telemetry, never a campaign total */
  buffer?: boolean
}
export type RiverPin = { after: RiverKey; gate: GateKey; label: string; detail: string; tone: Tone; state: 'blocked' | 'waiting' }

const RIVER: Array<{ key: RiverKey; label: string; unit: string }> = [
  { key: 'audience', label: 'Audience', unit: 'sellers' },
  { key: 'eligible', label: 'Eligible', unit: 'sellers' },
  { key: 'planned', label: 'Planned', unit: 'handed to queue' },
  { key: 'queued', label: 'In queue', unit: 'now' },
  { key: 'sent', label: 'Sent', unit: 'sellers' },
  { key: 'delivered', label: 'Delivered', unit: 'sellers' },
  { key: 'replied', label: 'Replied', unit: 'sellers' },
  { key: 'opportunity', label: 'Opportunity', unit: 'opened' },
]

export function riverOf(input: WarInput, now: number): { nodes: RiverNode[]; pin: RiverPin | null; current: RiverKey | null } {
  const f = facts(input)
  const mission = missionOf(input, now)
  const intel = input.intel
  const tz = f.tz
  const values: Record<RiverKey, number | null> = {
    audience: f.total,
    eligible: f.eligible,
    planned: f.planned,
    queued: f.queueLive,
    sent: f.sent,
    delivered: f.delivered,
    replied: f.replied,
    opportunity: f.opportunities,
  }
  const rate: Record<RiverKey, string | null> = {
    audience: null,
    eligible: pct(f.eligible, f.total),
    planned: pct(f.planned, f.eligible),
    queued: null,
    // no conversion into SENT: the queue buffer sits between, and sent ÷ planned
    // is progress through the queue (the buffer already shows it), not a rate
    sent: null,
    delivered: pct(f.delivered, f.sent),
    replied: pct(f.replied, f.delivered),
    opportunity: pct(f.opportunities, f.replied),
  }
  const filtered = intel?.delivery?.filtered ?? null
  const optOut = f.buckets?.opt_out ?? null
  const bufferTarget = intel?.feeder.buffer_target ?? input.core?.feed?.buffer_target ?? 150
  const subs: Record<RiverKey, [string | null, Tone | null]> = {
    audience: [f.explicit && f.total !== null && f.explicit !== f.total ? `${nf(f.explicit)} selected` : f.sourceKind === 'filters' ? 'from filters' : null, null],
    eligible: [f.held ? `${nf(f.held)} held` : null, f.held ? 'attn' : null],
    planned: [f.ready ? `${nf(f.ready)} ready` : f.planned ? 'all placed' : null, null],
    queued: [f.overdue ? `${nf(f.overdue)} overdue` : `now · of ${nf(bufferTarget)}`, f.overdue ? 'crit' : null],
    sent: [intel?.delivery ? `${nf(intel.delivery.left_us)} texts` : null, null],
    delivered: [filtered ? `${nf(filtered)} filtered` : null, filtered ? 'attn' : null],
    replied: [optOut ? `${nf(optOut)} opted out` : null, null],
    opportunity: [intel?.outcomes ? (intel.outcomes.opportunities_moved ? `${nf(intel.outcomes.opportunities_moved)} advanced` : 'attributed') : null, null],
  }

  // Where the flow is held, and at which connector.
  let pin: RiverPin | null = null
  let current: RiverKey | null = null
  const block = feederBlock(f.feeder)
  switch (mission.key) {
    case 'audience_built':
    case 'draft':
    case 'targeting_required':
      current = 'audience'
      break
    case 'scheduled':
      current = 'eligible'
      pin = { after: 'eligible', gate: 'schedule', label: 'Schedule', detail: f.scheduledFor ? `Starts ${dayClock(f.scheduledFor, tz, now)}` : 'Scheduled', tone: 'exec', state: 'waiting' }
      break
    case 'missed_schedule':
      current = 'eligible'
      pin = { after: 'eligible', gate: 'schedule', label: 'Schedule gate', detail: `Missed start · ${clock(f.missedFor, tz)}`, tone: 'attn', state: 'blocked' }
      break
    case 'no_audience':
      current = 'audience'
      pin = { after: 'audience', gate: 'eligibility', label: 'Audience', detail: 'No executable audience', tone: 'attn', state: 'blocked' }
      break
    case 'paused':
      current = 'queued'
      pin = { after: 'queued', gate: 'schedule', label: 'Paused', detail: 'New texts and held rows wait for Resume', tone: 'neutral', state: 'waiting' }
      break
    case 'degraded':
      current = 'queued'
      pin = { after: 'queued', gate: mission.gate ?? 'queue', label: GATE_LABEL[mission.gate ?? 'queue'], detail: mission.why ?? 'Runtime degraded', tone: 'crit', state: 'blocked' }
      break
    case 'needs_attention':
      if (mission.gate === 'queue') {
        current = 'queued'
        pin = { after: 'queued', gate: 'queue', label: 'Queue', detail: `${nf(f.overdue)} overdue`, tone: 'crit', state: 'blocked' }
      } else if (block) {
        current = (f.queueLive ?? 0) > 0 ? 'sent' : 'planned'
        pin = { after: 'eligible', gate: block.gate, label: GATE_LABEL[block.gate], detail: `${nf(f.ready ?? block.count)} can’t be placed`, tone: 'attn', state: 'blocked' }
      } else {
        current = 'eligible'
        pin = { after: 'audience', gate: mission.gate ?? 'eligibility', label: GATE_LABEL[mission.gate ?? 'eligibility'], detail: mission.label, tone: 'attn', state: 'blocked' }
      }
      break
    case 'waiting_window':
      current = 'queued'
      pin = { after: 'queued', gate: 'window', label: 'Contact window', detail: f.window?.next_open_at ? `Opens ${clock(f.window.next_open_at, f.window.timezone ?? tz)}` : 'Closed', tone: 'neutral', state: 'waiting' }
      break
    case 'waiting_capacity':
      current = 'planned'
      pin = { after: 'planned', gate: 'capacity', label: 'Capacity', detail: mission.label, tone: 'exec', state: 'waiting' }
      break
    case 'live':
      current = (f.queueLive ?? 0) > 0 ? 'sent' : 'planned'
      break
    default:
      current = null
  }

  const order = RIVER.map((r) => r.key)
  const at = current ? order.indexOf(current) : -1
  const pinAt = pin ? order.indexOf(pin.after) : -1
  const nodes: RiverNode[] = RIVER.map((r, i) => {
    const v = values[r.key]
    let state: RiverState = v !== null && v > 0 ? 'done' : 'idle'
    if (r.key === 'queued') state = v && v > 0 ? 'active' : 'idle'
    if (i === at) state = 'active'
    // the stage just past a held gate has had nothing flow into it yet
    if (pin && i === pinAt + 1 && !(v !== null && v > 0)) state = pin.state === 'blocked' ? 'blocked' : 'waiting'
    return {
      key: r.key,
      label: r.label,
      value: v,
      rate: rate[r.key],
      sub: subs[r.key][0],
      subTone: subs[r.key][1],
      state,
      unit: r.unit,
      buffer: r.key === 'queued',
    }
  })
  return { nodes, pin, current }
}

/* ══ gates ════════════════════════════════════════════════════════════════ */

export type GateState = 'pass' | 'hold' | 'wait' | 'warn' | 'block' | 'idle' | 'unknown'
export type Gate = { key: GateKey; label: string; state: GateState; value: string; detail: string; owner: Owner | null; count: number | null }

export function gatesOf(input: WarInput, now: number): Gate[] {
  const f = facts(input)
  const mission = missionOf(input, now)
  const intel = input.intel
  const core = input.core
  const tz = f.tz
  const live = isLiveStatus(f.status)
  const g = (key: GateKey, state: GateState, value: string, detail: string, owner: Owner | null = null, count: number | null = null): Gate => ({ key, label: GATE_LABEL[key], state, value, detail, owner, count })
  const block = feederBlock(f.feeder)
  const heldBy = Object.entries(f.heldByReason ?? {})
  const heldIn = (gate: GateKey) => heldBy.filter(([code]) => gateOfReason(code) === gate).reduce((s, [, n]) => s + Number(n), 0)
  const out: Gate[] = []

  // SCHEDULE
  if (mission.key === 'missed_schedule') out.push(g('schedule', 'block', `Missed · ${clock(f.missedFor, tz)}`, mission.why ?? 'Missed its start.', 'operator'))
  else if (mission.key === 'scheduled') out.push(g('schedule', 'wait', f.scheduledFor ? dayClock(f.scheduledFor, tz, now) ?? 'Scheduled' : 'Scheduled', 'Activates automatically at this time (checked every 5 min).', 'system'))
  else if (f.status === 'paused') out.push(g('schedule', 'block', 'Paused', 'An operator paused it. New texts and queued rows wait for Resume.', 'operator'))
  else if (live) out.push(g('schedule', 'pass', 'Live', core?.lifecycle.activated_at ? `Activated ${dayClock(core.lifecycle.activated_at, tz, now)}.` : 'Live.'))
  else if (f.status === 'completed') out.push(g('schedule', 'pass', 'Completed', 'The cohort is resolved.'))
  else out.push(g('schedule', 'idle', 'Not scheduled', 'Schedule or launch it to start.', 'operator'))

  // CONTACT WINDOW
  const w = f.window
  if (!w || w.open === null) out.push(g('window', 'unknown', w?.reason === 'campaign_timezone_unset' ? 'No time zone' : 'Unknown', 'The window could not be read in the campaign’s zone.'))
  else if (w.open) out.push(g('window', 'pass', w.closes_at ? `Open until ${clock(w.closes_at, w.timezone ?? tz, false)}` : 'Open', `${w.window ?? ''} ${zoneAbbr(w.timezone ?? tz, now) ?? ''}`.trim()))
  else out.push(g('window', live ? 'wait' : 'idle', `Closed · opens ${clock(w.next_open_at, w.timezone ?? tz)}`, `${w.window ?? ''} ${zoneAbbr(w.timezone ?? tz, now) ?? ''} — waiting is not failing.`.trim(), 'system'))

  // ELIGIBILITY
  if (f.total === null) out.push(g('eligibility', 'unknown', 'Unavailable', 'Targets could not be read.'))
  else if (f.total === 0) out.push(g('eligibility', PRELAUNCH.includes(f.status) ? 'idle' : 'block', 'No audience', 'No targets have been built.', 'operator', 0))
  else if ((f.eligible ?? 0) === 0) out.push(g('eligibility', 'block', 'None eligible', `All ${nf(f.total)} are held.`, 'operator', 0))
  else {
    const other = heldIn('eligibility')
    out.push(g('eligibility', 'pass', `${nf(f.eligible)} eligible`, other ? `${nf(other)} held for contactability (no phone, renter …).` : 'Held targets are counted by reason below.', null, f.eligible))
  }

  // SUPPRESSION
  const suppressedHeld = heldIn('suppression')
  const suppressedExec = (core?.exceptions?.execution.groups ?? []).filter((x) => x.failure_category.includes('compliance')).reduce((s, x) => s + x.count, 0)
  out.push(g('suppression', suppressedHeld || suppressedExec ? 'hold' : 'pass', suppressedHeld || suppressedExec ? `${nf(suppressedHeld + suppressedExec)} suppressed` : 'Clear', suppressedHeld || suppressedExec ? 'Opt-outs, DNC and prior contact are never messaged.' : 'No target is suppressed.', null, suppressedHeld + suppressedExec))

  // IDENTITY
  const identity = heldIn('identity')
  out.push(g('identity', identity ? 'hold' : 'pass', identity ? `${nf(identity)} need review` : 'Clear', identity ? 'Company-owned or unlinked owners wait for identity review; they are held, not failed.' : 'Every eligible target has a verified owner identity.', identity ? 'operator' : null, identity))

  // TEMPLATE
  const templateBlocked = block?.gate === 'template' ? block.count : 0
  const templateHeld = heldIn('template')
  if (templateBlocked) out.push(g('template', 'block', `${nf(templateBlocked)} can’t be placed`, block!.reasons.filter((r) => gateOfReason(r.code) === 'template').map((r) => `${r.words} (${nf(r.n)})`).join(' · '), 'operator', templateBlocked))
  else if (templateHeld) out.push(g('template', 'hold', `${nf(templateHeld)} held`, 'Too few approved messages for these sellers’ language or asset type.', 'operator', templateHeld))
  else out.push(g('template', live || f.planned ? 'pass' : 'idle', 'Messages available', 'Approved messages rendered for every placed seller.'))

  // SENDER
  const routing = intel?.routing ?? null
  const needy = routing ? routing.filter((r) => r.ready > 0) : []
  const noSender = needy.filter((r) => r.eligible === 0)
  const senderBlocked = block?.gate === 'sender' ? block.count : 0
  if (senderBlocked || noSender.length) {
    out.push(g('sender', 'block', noSender.length ? `No eligible sender · ${noSender.map((r) => r.market).slice(0, 2).join(', ')}` : `${nf(senderBlocked)} can’t be routed`, noSender.length ? noSender.map((r) => `${r.market}: ${Object.entries(r.by_state).map(([s, n]) => `${n} ${s.replace(/_/g, ' ')}`).join(', ') || 'no local number'}`).join(' · ') : block!.reasons.filter((r) => gateOfReason(r.code) === 'sender').map((r) => `${r.words} (${nf(r.n)})`).join(' · '), 'operator', senderBlocked || null))
  } else if (routing) {
    const eligible = routing.reduce((s, r) => s + r.eligible, 0)
    out.push(g('sender', eligible ? 'pass' : 'idle', `${nf(eligible)} eligible ${eligible === 1 ? 'sender' : 'senders'}`, 'A first text goes from a number in the seller’s own market, least-used first.', null, eligible))
  } else out.push(g('sender', 'unknown', 'Reading…', 'Sender fleet not loaded yet.'))

  // CAPACITY
  if (f.feeder?.bound === 'daily_cap_reached') out.push(g('capacity', 'wait', 'Daily cap reached', 'Resumes when the campaign’s day turns over.', 'campaign'))
  else if (block?.gate === 'capacity') out.push(g('capacity', 'wait', 'Sender capacity spent', block.reasons.map((r) => `${r.words} (${nf(r.n)})`).join(' · '), 'sender'))
  else {
    const daily = core?.feed?.daily_remaining
    out.push(g('capacity', live ? 'pass' : 'idle', daily === null || daily === undefined ? (core?.caps.daily_cap ? 'Reading…' : 'No daily cap') : `${nf(daily)} room today`, core?.caps.daily_cap ? `Daily cap ${nf(core.caps.daily_cap)} per campaign day.` : 'No daily cap is set.'))
  }

  // QUEUE
  const posture = systemPosture(input.system, Math.min(now, t(core?.at) ?? now))
  if (f.overdue > 0) out.push(g('queue', 'block', `${nf(f.overdue)} overdue`, 'Due work is not being picked up.', 'system', f.overdue))
  else if (input.system && (posture.key === 'processor_stale' || posture.key === 'feeder_stale')) out.push(g('queue', 'block', posture.label, posture.detail ?? '', 'system'))
  else if ((f.queueLive ?? 0) > 0) out.push(g('queue', 'pass', `${nf(f.queueLive)} queued`, f.due ? `${nf(f.due)} due now.` : 'Scheduled ahead of the processor.', null, f.queueLive))
  else out.push(g('queue', live ? 'pass' : 'idle', 'Empty', live ? 'The feeder refills it every 5 minutes when there is room.' : 'Nothing queued.'))

  // PROVIDER
  if (input.system && (posture.key === 'emergency_stop' || posture.key === 'sending_off')) out.push(g('provider', 'block', posture.label, posture.detail ?? '', 'system'))
  else {
    const refused = intel?.delivery?.provider_refused ?? 0
    out.push(g('provider', refused ? 'hold' : live ? 'pass' : 'idle', refused ? `${nf(refused)} refused` : 'Accepting', refused ? 'The provider refused these before they were accepted (no message id).' : 'TextGrid accepts and returns a message id per text.', refused ? 'provider' : null, refused || null))
  }

  // DELIVERY
  const d = intel?.delivery
  if (d && d.left_us > 0) {
    const filteredShare = d.filtered / d.left_us
    const warn = d.left_us >= 20 && filteredShare >= 0.15
    out.push(g('delivery', warn ? 'warn' : 'pass', `${pct(d.delivered, d.left_us) ?? '—'} delivered`, `${nf(d.filtered)} content-filtered · ${nf(d.invalid_destination)} invalid destination · ${nf(d.soft_bounce + d.carrier_undelivered + d.carrier_dnc)} other carrier failures.`, warn ? 'provider' : null, d.delivered))
  } else out.push(g('delivery', 'idle', 'No texts yet', 'Nothing has left the queue.'))

  return out
}

/** The gate that is stopping execution now: the first block, else the first wait. */
export function stoppingGate(gates: Gate[]): Gate | null {
  return gates.find((x) => x.state === 'block') ?? gates.find((x) => x.state === 'wait') ?? null
}

/* ══ NEXT ═════════════════════════════════════════════════════════════════ */

export type Next = { label: string; when: string | null; rel: string | null; tone: Tone; expected: boolean; at?: string | null }

export function nextOf(input: WarInput, now: number): Next {
  const f = facts(input)
  const mission = missionOf(input, now)
  const tz = f.tz
  switch (mission.key) {
    case 'scheduled': return { label: 'Campaign starts', when: dayClock(f.scheduledFor, tz, now), rel: relative(f.scheduledFor, now), tone: 'exec', expected: false, at: f.scheduledFor }
    case 'missed_schedule': return { label: 'Requires an operator', when: 'Reschedule or launch now', rel: null, tone: 'attn', expected: false }
    case 'paused': return { label: 'Paused', when: f.ready ? `Resume continues with ${plural(f.ready, 'ready seller')}` : 'Resume releases held rows', rel: null, tone: 'neutral', expected: false }
    case 'completed': return { label: 'Finished', when: dayClock(input.core?.lifecycle.completed_at ?? input.book?.schedule?.completed_at, tz, now), rel: null, tone: 'ok', expected: false }
    case 'audience_built': return { label: 'Ready to schedule', when: `${plural(f.eligible ?? 0, 'eligible seller')}`, rel: null, tone: 'neutral', expected: false }
    case 'draft': case 'targeting_required': return { label: 'Not launched', when: mission.why, rel: null, tone: 'neutral', expected: false }
    case 'no_audience': return { label: 'Nothing to send', when: 'Rebuild the audience or pause it', rel: null, tone: 'attn', expected: false }
    case 'degraded': return { label: 'Waiting on the runtime', when: mission.why, rel: null, tone: 'crit', expected: false }
    default: break
  }
  if (mission.key === 'needs_attention' && mission.gate !== 'queue') {
    const q = f.queueLive ?? 0
    if (q > 0 && input.core?.queue?.next_scheduled_at) return { label: 'Next text due', when: dayClock(input.core.queue.next_scheduled_at, tz, now), rel: relative(input.core.queue.next_scheduled_at, now), tone: 'exec', expected: false, at: input.core.queue.next_scheduled_at }
    return { label: `Waiting on ${GATE_LABEL[mission.gate ?? 'eligibility'].toLowerCase()}`, when: mission.why, rel: null, tone: 'attn', expected: false }
  }
  if (f.window?.open === false && f.window.next_open_at) return { label: 'Contact window opens', when: dayClock(f.window.next_open_at, f.window.timezone ?? tz, now), rel: relative(f.window.next_open_at, now), tone: 'neutral', expected: false, at: f.window.next_open_at }
  if (mission.key === 'waiting_capacity') {
    const opens = f.window?.next_open_at ?? null
    return { label: 'Resumes', when: opens ? dayClock(opens, f.window?.timezone ?? tz, now) : 'Tomorrow, when the campaign day turns over', rel: opens ? relative(opens, now) : null, tone: 'exec', expected: !opens, at: opens }
  }
  const next = input.core?.queue?.next_scheduled_at ?? input.book?.queue?.next_at ?? null
  if ((f.queueLive ?? 0) > 0 && next) return { label: 'Next text due', when: dayClock(next, tz, now), rel: relative(next, now), tone: 'exec', expected: false, at: next }
  const beat = t(input.system?.feeder.heartbeat_at ?? null)
  if (beat !== null) {
    const cadence = (input.system?.feeder.cadence_minutes ?? 5) * 60_000
    let at = beat + cadence
    while (at < now) at += cadence
    return { label: 'Queue refill', when: `next feeder pass ≈ ${clock(new Date(at).toISOString(), tz)}`, rel: relative(new Date(at).toISOString(), now), tone: 'exec', expected: true, at: new Date(at).toISOString() }
  }
  return { label: 'Next', when: null, rel: null, tone: 'neutral', expected: false }
}

/* ══ time: the contact window track ═══════════════════════════════════════ */

export type WindowTrack = { start: number; end: number; now: number; open: boolean | null; label: string; nowLabel: string; zone: string | null; operatorLabel: string | null }

export function windowTrack(w: (CockpitWindow & { reason?: string }) | null | undefined, now: number, operatorTz?: string | null): WindowTrack | null {
  if (!w || !w.window) return null
  const m = w.window.match(/(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/)
  if (!m) return null
  const start = Number(m[1]) + Number(m[2]) / 60
  const end = Number(m[3]) + Number(m[4]) / 60
  const tz = w.timezone ?? null
  const nowH = localHour(now, tz)
  const nowLabel = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }).format(new Date(now))
  const fmt = (h: number) => {
    const hh = Math.floor(h)
    const mm = Math.round((h - hh) * 60)
    const ap = hh >= 12 ? 'PM' : 'AM'
    const h12 = hh % 12 === 0 ? 12 : hh % 12
    return `${h12}:${String(mm).padStart(2, '0')} ${ap}`
  }
  const zone = zoneAbbr(tz, now)
  const operatorZone = operatorTz && tz && zoneAbbr(operatorTz, now) !== zone ? zoneAbbr(operatorTz, now) : null
  return {
    start, end, now: nowH, open: w.open,
    label: `${fmt(start)}–${fmt(end)}${zone ? ` ${zone}` : ''}`,
    nowLabel: `${nowLabel}${zone ? ` ${zone}` : ''}`,
    zone,
    operatorLabel: operatorZone ? `${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: operatorTz || undefined }).format(new Date(now))} ${operatorZone} your time` : null,
  }
}

/* ══ pace: days to finish (an estimate, labelled) ═════════════════════════ */

export type Pace = { daily: number | null; basis: string; remaining: number; days: number | null; dayIndex: number | null; limits: Array<{ label: string; value: number }> }

export function paceOf(input: WarInput, now: number): Pace {
  const f = facts(input)
  const intel = input.intel
  const caps = intel?.caps ?? (input.core ? { daily_cap: input.core.caps.daily_cap, send_interval_seconds: input.core.caps.send_interval_seconds } : null)
  const remaining = f.ready ?? 0
  const limits: Array<{ label: string; value: number }> = []
  if (caps?.daily_cap) limits.push({ label: 'daily cap', value: caps.daily_cap })
  const w = f.window
  const m = w?.window?.match(/(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/)
  if (m && caps?.send_interval_seconds) {
    const hours = (Number(m[3]) + Number(m[4]) / 60) - (Number(m[1]) + Number(m[2]) / 60)
    if (hours > 0) limits.push({ label: 'window spacing', value: Math.floor((hours * 3600) / caps.send_interval_seconds) })
  }
  const marketSenders = intel?.routing ? intel.routing.filter((r) => r.ready > 0 || r.targets > 0).reduce((s, r) => s + r.remaining_today, 0) : null
  if (marketSenders !== null && marketSenders > 0) limits.push({ label: 'sender capacity', value: marketSenders })
  const daily = limits.length ? Math.min(...limits.map((l) => l.value)) : null
  const basis = limits.length ? limits.reduce((a, b) => (b.value < a.value ? b : a)).label : 'no limit read'
  const days = daily && daily > 0 && remaining > 0 ? Math.ceil(remaining / daily) : remaining > 0 ? null : 0
  const activated = t(input.core?.lifecycle.activated_at ?? input.book?.schedule?.activated_at ?? null)
  const dayIndex = activated !== null ? Math.max(1, Math.floor((new Date(dayKey(now, f.tz)).getTime() - new Date(dayKey(activated, f.tz)).getTime()) / 86_400_000) + 1) : null
  return { daily, basis, remaining, days, dayIndex, limits }
}

/* ══ caps, named by what they really bound ════════════════════════════════ */

export type CapLine = { key: string; label: string; value: string; meaning: string; scope: 'campaign' | 'worker' | 'system' | 'planning'; limiting: boolean }

export function capsTruth(input: WarInput): CapLine[] {
  const f = facts(input)
  const caps = input.intel?.caps ?? (input.core ? {
    daily_cap: input.core.caps.daily_cap, total_cap: input.core.caps.total_cap, market_cap: input.core.caps.market_cap, batch_max: input.core.caps.batch_max,
    per_sender_cap: input.core.caps.per_sender_cap, system_per_number_cap: input.core.caps.configured_per_number_cap, send_interval_seconds: input.core.caps.send_interval_seconds,
  } : null)
  if (!caps) return []
  const executable = f.eligible ?? 0
  const out: CapLine[] = []
  out.push({
    key: 'total', label: 'Total cap', value: caps.total_cap ? nf(caps.total_cap) : 'None',
    meaning: caps.total_cap ? (caps.total_cap < executable ? `Limits this campaign to ${nf(caps.total_cap)} of ${nf(executable)} executable sellers.` : `Above the ${nf(executable)} executable sellers — not limiting.`) : 'The whole executable cohort is in scope.',
    scope: 'campaign', limiting: Boolean(caps.total_cap && caps.total_cap < executable),
  })
  out.push({ key: 'daily', label: 'Daily cap', value: caps.daily_cap ? `${nf(caps.daily_cap)} / day` : 'None', meaning: 'Per campaign-local day; queued rows count against today.', scope: 'campaign', limiting: false })
  out.push({
    key: 'sender', label: caps.per_sender_cap ? 'Sender cap (campaign override)' : 'System limit', value: `${nf(caps.per_sender_cap ?? caps.system_per_number_cap)} / sender / day`,
    meaning: caps.per_sender_cap ? `Overrides the system limit of ${nf(caps.system_per_number_cap)}.` : 'Every number’s daily limit (system_control).', scope: caps.per_sender_cap ? 'campaign' : 'system', limiting: false,
  })
  out.push({ key: 'spacing', label: 'Spacing', value: caps.send_interval_seconds ? `1 text / ${caps.send_interval_seconds}s` : 'Default', meaning: caps.send_interval_seconds ? `About ${nf(Math.floor(3600 / caps.send_interval_seconds))} an hour inside the window.` : '', scope: 'campaign', limiting: false })
  out.push({ key: 'refill', label: 'Queue refill size', value: `${nf(input.intel?.feeder.chunk ?? 100)} / pass`, meaning: `Worker chunk; the buffer keeps ${nf(input.intel?.feeder.buffer_target ?? 150)} ahead. Not a campaign total.`, scope: 'worker', limiting: false })
  if (caps.batch_max) out.push({ key: 'batch', label: 'Activation first chunk', value: nf(caps.batch_max), meaning: 'Rows placed when a scheduled start activates; the feeder continues after it. Not a campaign total.', scope: 'worker', limiting: false })
  if (caps.market_cap) out.push({ key: 'market', label: 'Market cap per planning pass', value: nf(caps.market_cap), meaning: 'Bounds one planning pass per market — not a campaign ceiling.', scope: 'planning', limiting: false })
  return out
}

/* ══ audience waterfall ═══════════════════════════════════════════════════ */

export type WaterStep = { key: string; label: string; value: number | null; of: number | null; detail: string | null; tone: Tone }

export function audienceSteps(input: WarInput): WaterStep[] {
  const f = facts(input)
  const out: WaterStep[] = []
  const selected = f.explicit ?? input.core?.lineage.area?.property_count ?? null
  if (selected) out.push({ key: 'selected', label: f.sourceKind === 'map_area' ? 'Selected in area' : 'Selected', value: selected, of: selected, detail: null, tone: 'neutral' })
  out.push({ key: 'resolved', label: 'Resolved targets', value: f.total, of: selected ?? f.total, detail: selected && f.total !== null && selected > f.total ? `${nf(selected - f.total)} did not resolve to a messageable owner` : null, tone: 'exec' })
  out.push({ key: 'eligible', label: 'Eligible', value: f.eligible, of: f.total, detail: null, tone: 'exec' })
  out.push({ key: 'held', label: 'Held', value: f.held, of: f.total, detail: f.held ? 'Held is not failed — review, identity, suppression' : null, tone: 'attn' })
  const block = feederBlock(f.feeder)
  if (block && (f.ready ?? 0) > 0) out.push({ key: 'unplaced', label: 'Can’t be placed', value: f.ready, of: f.eligible, detail: `${GATE_LABEL[block.gate]} gate`, tone: 'attn' })
  out.push({ key: 'planned', label: 'Handed to queue', value: f.planned, of: f.eligible, detail: f.ready ? `${nf(f.ready)} ready, not yet placed` : null, tone: 'exec' })
  return out
}

export type HeldReason = { code: string; label: string; n: number; gate: GateKey }

export function heldReasons(input: WarInput): HeldReason[] {
  const f = facts(input)
  return Object.entries(f.heldByReason ?? {}).filter(([, n]) => Number(n) > 0).map(([code, n]) => ({ code, label: holdWords(code), n: Number(n), gate: gateOfReason(code) })).sort((a, b) => b.n - a.n)
}

/* ══ replies, outcomes, money ═════════════════════════════════════════════ */

export const REPLY_META: Record<ReplyBucketKey, { label: string; tone: Tone }> = {
  interested: { label: 'Interested', tone: 'ok' },
  not_interested: { label: 'Not interested', tone: 'flow' },
  wrong_number: { label: 'Wrong number', tone: 'neutral' },
  opt_out: { label: 'Opt-out', tone: 'attn' },
  ambiguous: { label: 'Ambiguous', tone: 'neutral' },
  other: { label: 'Other', tone: 'flow' },
}
export const REPLY_ORDER: ReplyBucketKey[] = ['interested', 'not_interested', 'wrong_number', 'opt_out', 'ambiguous', 'other']

export function replySegments(buckets: ReplyBuckets | null | undefined): Array<{ key: ReplyBucketKey; label: string; value: number; tone: Tone }> {
  if (!buckets) return []
  return REPLY_ORDER.map((key) => ({ key, label: REPLY_META[key].label, value: Number(buckets[key] ?? 0), tone: REPLY_META[key].tone }))
}

export type FunnelStep = { key: string; label: string; value: number | null; basis: string | null }

/** Executable → … → offer. Only stages a read carries; attribution is the intel read's. */
export function businessFunnel(input: WarInput): FunnelStep[] {
  const f = facts(input)
  const o = input.intel?.outcomes ?? null
  const sentOffers = o ? o.offers.filter((x) => x.sent_at).length : null
  const contracts = o ? o.closings.filter((c) => c.contract_status && !/draft|pending|none/i.test(c.contract_status)).length : null
  const closed = o ? o.closings.filter((c) => c.closed_at).length : null
  return [
    { key: 'executable', label: 'Executable', value: f.eligible, basis: null },
    { key: 'sent', label: 'Sent', value: f.sent, basis: null },
    { key: 'delivered', label: 'Delivered', value: f.delivered, basis: null },
    { key: 'replied', label: 'Replied', value: f.replied, basis: null },
    { key: 'interested', label: 'Interested', value: f.buckets ? f.buckets.interested : null, basis: 'latest reply' },
    { key: 'advanced', label: 'Advanced', value: o ? o.opportunities_moved : null, basis: 'stage moved after first text' },
    { key: 'opportunities', label: 'Opportunities', value: f.opportunities, basis: 'opened after first text' },
    { key: 'offers', label: 'Offers sent', value: sentOffers, basis: null },
    { key: 'contracts', label: 'Contracts', value: contracts, basis: null },
    { key: 'closed', label: 'Closed', value: closed, basis: null },
  ]
}

export type MoneyLine = { key: string; label: string; value: string; n: number; basis: 'modeled' | 'actual' | 'estimated' }

export function moneyLines(intel: CampaignIntel | null | undefined): MoneyLine[] {
  const o = intel?.outcomes
  if (!o) return []
  const sum = (xs: Array<number | null>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0)
  const rec = o.opportunities.filter((x) => x.recommended_offer)
  const sent = o.offers.filter((x) => x.sent_at && x.price)
  const contracted = o.closings.filter((c) => c.contract_price)
  const expected = o.closings.filter((c) => c.expected_revenue)
  const confirmed = o.closings.filter((c) => c.confirmed_revenue)
  return [
    { key: 'recommended', label: 'Recommended offers', value: rec.length ? money(sum(rec.map((x) => x.recommended_offer))) : '—', n: rec.length, basis: 'modeled' },
    { key: 'offers', label: 'Offers sent', value: sent.length ? money(sum(sent.map((x) => x.price))) : '—', n: sent.length, basis: 'actual' },
    { key: 'contracts', label: 'Contract value', value: contracted.length ? money(sum(contracted.map((c) => c.contract_price))) : '—', n: contracted.length, basis: 'actual' },
    { key: 'expected', label: 'Expected revenue', value: expected.length ? money(sum(expected.map((c) => c.expected_revenue))) : '—', n: expected.length, basis: 'estimated' },
    { key: 'closed', label: 'Closed revenue', value: confirmed.length ? money(sum(confirmed.map((c) => c.confirmed_revenue))) : '—', n: confirmed.length, basis: 'actual' },
  ]
}

export type RateLine = { key: string; label: string; value: string | null; num: number; den: number; thin: boolean }
export const MIN_SAMPLE = 20

export function performanceRates(input: WarInput): RateLine[] {
  const intel = input.intel
  const f = facts(input)
  const d = intel?.delivery ?? null
  const o = intel?.outcomes ?? null
  const line = (key: string, label: string, num: number | null | undefined, den: number | null | undefined): RateLine | null => (num === null || num === undefined || den === null || den === undefined ? null : { key, label, value: pct(num, den), num, den, thin: den < MIN_SAMPLE })
  return [
    line('delivery', 'Delivery rate (sellers)', f.delivered, f.sent),
    d ? line('delivery_msgs', 'Delivery rate (texts)', d.delivered, d.left_us) : null,
    line('reply', 'Reply rate', f.replied, f.delivered),
    f.buckets ? line('positive', 'Positive rate', f.buckets.interested, f.delivered) : null,
    f.buckets ? line('opt_out', 'Opt-out rate', f.buckets.opt_out, f.delivered) : null,
    d ? line('failure', 'Failure rate', d.left_us - d.delivered - d.awaiting_receipt, d.left_us) : null,
    d ? line('filter', 'Content-filter rate', d.filtered, d.left_us) : null,
    o ? line('advance', 'Stage advancement', o.opportunities_moved, f.replied) : null,
    o ? line('opportunity', 'Opportunity conversion', o.opportunities.length, f.replied) : null,
    o ? line('offer', 'Offer conversion', o.offers.filter((x) => x.sent_at).length, o.opportunities.length) : null,
  ].filter((x): x is RateLine => x !== null)
}

/* ══ senders ══════════════════════════════════════════════════════════════ */

export const SENDER_STATE_LABEL: Record<FleetNumber['state'], string> = {
  active: 'Active', unverified: 'Active', paused: 'Paused', blocked: 'Blocked', cooling: 'Cooling', ineligible: 'Ineligible', cap_reached: 'Cap reached',
}
export const SENDER_STATE_TONE: Record<FleetNumber['state'], Tone> = {
  active: 'ok', unverified: 'ok', paused: 'neutral', blocked: 'crit', cooling: 'attn', ineligible: 'neutral', cap_reached: 'attn',
}

export function senderWhy(s: FleetNumber): string {
  if (s.state === 'blocked') return s.state_reason === 'blocked_by_operator' ? 'On the operator blocklist — not eligible for first texts.' : `Health ${String(s.state_reason ?? '').replace(/^health_/, '')} — not eligible.`
  if (s.state === 'cooling') return s.cooling_until ? `Cooling until ${new Date(s.cooling_until).toLocaleDateString()}.` : 'Cooling with no end date — an operator must reset it.'
  if (s.state === 'paused') return 'Paused in the fleet.'
  if (s.state === 'cap_reached') return `The router’s counter reads ${nf(s.router_counter)} of ${nf(s.daily_limit)} — it will not route here.`
  if (s.state === 'ineligible') return `Not eligible (${String(s.state_reason ?? '').replace(/_/g, ' ')}).`
  return s.state === 'unverified' ? 'Eligible. Health is unverified — no structured evidence yet.' : 'Eligible.'
}

/** True when the router's never-reset counter has drifted from real sends today. */
export const counterDrift = (s: FleetNumber) => s.router_counter !== null && s.router_counter - s.sent_today >= 25

export function formatPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (d.length !== 10) return String(raw ?? '—') || '—'
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
}
