import type { InspectorModel, InspectorRenderer, InspectorTone } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { count, enc, isoOrNull, joinParts, present, readInspector, text, when, words } from '../inspector-read'

/**
 * CAMPAIGN — GET /api/cockpit/campaigns/:id (Campaign Command's own read).
 * One call carries the campaign row, the cockpit `summary` (audience,
 * eligible, held, remaining, health, next window — the numbers Campaign
 * Command shows), the operator `command_summary` (state, mode, blockers,
 * queue-truth sent/delivered) and the send windows (market + timezone).
 */

interface SendWindow { market?: string | null; timezone?: string | null; window_start_utc?: string | null; window_end_utc?: string | null; status?: string | null }
export interface CampaignDetail {
  campaign?: { id?: string; name?: string | null; market?: string | null; objective?: string | null; contact_window_start?: string | null; contact_window_end?: string | null; metadata?: { timezone?: string | null; launch_timezone?: string | null } | null; updated_at?: string | null } | null
  summary?: {
    total_targets?: number | null
    explicit_target_count?: number | null
    eligible_targets?: number | null
    held_targets?: number | null
    remaining_targets?: number | null
    held_by_reason?: Record<string, number> | null
    health_score?: number | null
    health_status?: string | null
    next_send_window?: SendWindow | null
    schedule_missed_for?: string | null
    feeder_last?: { stalled?: boolean | null; reason?: string | null; at?: string | null } | null
  } | null
  command_summary?: {
    state?: string | null
    state_label?: string | null
    mode_label?: string | null
    blockers?: string[] | null
    counts?: { sent_rows?: number | null; delivered_rows?: number | null; replied_rows?: number | null; opted_out_rows?: number | null } | null
    execution?: { transmission_label?: string | null } | null
  } | null
  send_windows?: SendWindow[] | null
  events?: Array<{ event_type?: string; title?: string | null; created_at?: string | null }> | null
}

const TONE: Record<string, InspectorTone> = {
  live: 'live', scheduled: 'live', test_mode: 'neutral', paused: 'attention', needs_configuration: 'attention',
  blocked: 'crit', failed: 'crit', completed: 'ok', targets_ready: 'neutral', draft: 'neutral', building_targets: 'neutral', archived: 'neutral',
}

/** held_by_reason keys → what an operator calls them. */
export function heldReason(key: string): string {
  const pool = /^insufficient_template_rotation_pool:([^:]+):/.exec(key)
  if (pool) return pool[1] === 'auto' ? 'No approved message for the detected language' : `No approved ${pool[1]} message`
  const known: Record<string, string> = {
    entity_contact_requires_review: 'Company owner — needs review',
    missing_identity_linkage: 'Owner not linked to a phone',
    suppressed: 'Suppressed contact',
    no_sender_capacity: 'No sender capacity',
  }
  return known[key] ?? words(key) ?? key
}

const FEEDER: Record<string, string> = { no_row_placed: 'nothing placed on the queue' }

export function shapeCampaign(d: CampaignDetail, ref: EntityRef, now = Date.now()): InspectorModel {
  const c = d.campaign ?? {}
  const s = d.summary ?? {}
  const cs = d.command_summary ?? {}
  const id = text(c.id) ?? ref.id
  const name = text(c.name) ?? text(ref.label) ?? 'Campaign'
  const win = s.next_send_window ?? d.send_windows?.[0] ?? null
  const market = text(c.market) ?? text(win?.market)
  const tz = text(win?.timezone) ?? text(c.metadata?.timezone) ?? text(c.metadata?.launch_timezone)
  const start = isoOrNull(win?.window_start_utc), end = isoOrNull(win?.window_end_utc)
  const passed = end && Date.parse(end) < now
  const held = Object.entries(s.held_by_reason ?? {}).sort((a, b) => b[1] - a[1])
  const heldText = held.length ? held.slice(0, 3).map(([k, n]) => `${heldReason(k)} (${n})`).join('; ') : null
  const feeder = s.feeder_last?.stalled ? `Stalled — ${FEEDER[s.feeder_last.reason ?? ''] ?? words(s.feeder_last.reason) ?? 'no progress'}` : null

  // consecutive repeats of the same event read once
  const activity: NonNullable<InspectorModel['activity']> = []
  for (const e of d.events ?? []) {
    const at = isoOrNull(e.created_at)
    const t = text(e.title) ?? words(e.event_type)
    if (!at || !t) continue
    if (activity.length && activity[activity.length - 1].text === t) continue
    activity.push({ at, text: t })
    if (activity.length >= 6) break
  }

  return {
    title: name,
    eyebrow: joinParts([market, words(c.objective)]),
    status: cs.state_label ? { label: cs.state_label, tone: TONE[cs.state ?? ''] ?? 'neutral' } : null,
    facts: present([
      { label: 'Mode', value: joinParts([text(cs.mode_label), text(cs.execution?.transmission_label)]) },
      { label: 'Blocked by', value: cs.blockers?.length ? cs.blockers.join('; ') : null },
      { label: 'Market', value: market, hint: !text(c.market) && market ? 'From its send window' : undefined },
      { label: 'Timezone', value: tz },
      { label: 'Send hours', value: c.contact_window_start && c.contact_window_end ? `${c.contact_window_start}–${c.contact_window_end}${tz ? ' local' : ''}` : null },
      { label: 'Next window', value: start ? joinParts([`${when(start)}${end ? ` – ${when(end)}` : ''}`, passed ? 'passed' : null]) : null },
      { label: 'Missed start', value: when(s.schedule_missed_for) },
      { label: 'Audience', value: s.total_targets != null ? joinParts([count(s.total_targets, 'seller'), s.explicit_target_count && s.explicit_target_count !== s.total_targets ? `of ${count(s.explicit_target_count)} selected` : null]) : null },
      { label: 'Eligible', value: count(s.eligible_targets) },
      { label: 'Sent', value: cs.counts?.sent_rows != null ? joinParts([count(cs.counts.sent_rows), cs.counts.delivered_rows != null ? `${count(cs.counts.delivered_rows)} delivered` : null]) : null },
      { label: 'Replies', value: cs.counts?.replied_rows ? count(cs.counts.replied_rows) : null },
      { label: 'Opt-outs', value: cs.counts?.opted_out_rows ? count(cs.counts.opted_out_rows) : null },
      { label: 'Remaining', value: count(s.remaining_targets) },
      { label: 'Held', value: s.held_targets ? joinParts([count(s.held_targets), heldText], ' — ') : null },
      { label: 'Feeder', value: feeder },
      { label: 'Health', value: joinParts([words(s.health_status), s.health_score != null ? `${s.health_score}/100` : null]) },
    ]),
    activity,
    open: [{ label: 'Campaign Command', path: `/campaign-command?campaign=${enc(id)}` }],
    mission: { label: name, campaignId: id },
    replay: { type: 'campaign', id, label: name },
    freshness: null,
  }
}

export const campaignInspector: InspectorRenderer = {
  type: 'campaign',
  noun: 'Campaign',
  glyph: 'send',
  load: async (ref, signal) => shapeCampaign(await readInspector<CampaignDetail>(`/api/cockpit/campaigns/${enc(ref.id)}`, signal), ref),
}
