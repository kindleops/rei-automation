import type { LCActivityEvent, LCEffect } from '../../../shared/lc'
import type { CampaignSummary } from '../campaigns.types'
import type { Batch, ReplySeller } from './war-room-api'
import { GATE_LABEL, REPLY_META, facts, feederBlock, gateOfReason, nf, plural, type GateKey, type WarInput } from './war-room-model'
import { feederSkipWords } from './cockpit-model'

/**
 * ACTIVITY — the campaign's execution as a timeline of real events, grouped
 * where the machine works in bursts: a feeder pass is one "batch", an hour of
 * sends is one line, a run of replies collapses into "6 sellers replied".
 * Every event comes from a read; nothing is synthesised to look alive.
 */

export type ActivityCategory = 'execution' | 'audience' | 'senders' | 'queue' | 'delivery' | 'replies' | 'outcomes' | 'system'
export const ACTIVITY_FILTERS: Array<{ key: 'all' | ActivityCategory; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'execution', label: 'Execution' },
  { key: 'audience', label: 'Audience' },
  { key: 'senders', label: 'Senders' },
  { key: 'queue', label: 'Queue' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'replies', label: 'Replies' },
  { key: 'outcomes', label: 'Outcomes' },
  { key: 'system', label: 'System' },
]

export type WarEvent = LCActivityEvent & { category: ActivityCategory }

const EVENT_WORDS: Record<string, { title: string; category: ActivityCategory }> = {
  'campaign.created': { title: 'Campaign created', category: 'execution' },
  'campaign.updated': { title: 'Settings changed', category: 'execution' },
  'campaign.targets_built': { title: 'Audience resolved', category: 'audience' },
  'campaign.targets_build_refused': { title: 'Audience build refused', category: 'audience' },
  'campaign.targets_build_skipped': { title: 'Audience build skipped', category: 'audience' },
  'campaign.activated': { title: 'Campaign activated', category: 'execution' },
  'campaign.converted_to_live': { title: 'Switched to live', category: 'execution' },
  'campaign.launch_blocked': { title: 'Launch blocked', category: 'execution' },
  'campaign.quarantined_target_integrity': { title: 'Held — audience outside the selection', category: 'audience' },
  'campaign.queue_plan_refused_target_integrity': { title: 'Queue plan refused — audience integrity', category: 'audience' },
  'campaign.cloned': { title: 'Duplicated', category: 'execution' },
  'campaign.paused': { title: 'Campaign paused', category: 'execution' },
  'campaign.resumed': { title: 'Campaign resumed', category: 'execution' },
  'campaign.completed': { title: 'Campaign completed', category: 'execution' },
}

const ms = (iso: string | null | undefined) => {
  const v = Date.parse(String(iso ?? ''))
  return Number.isFinite(v) ? v : null
}

export type ActivityHandlers = {
  openBatch: (b: Batch) => void
  openReply: (r: ReplySeller) => void
  openGate: (g: GateKey) => void
  openOutcomes: () => void
}

export function warActivity(input: WarInput, h: ActivityHandlers): WarEvent[] {
  const out: WarEvent[] = []
  const core = input.core
  const intel = input.intel
  const f = facts(input)

  // lifecycle (operational events; the feeder's refills come from the batches)
  const seen = new Set<string>()
  for (const e of core?.timeline.events ?? []) {
    if (e.type === 'campaign.launch_scheduled') continue
    const words = EVENT_WORDS[e.type]
    const at = ms(e.at)
    if (at === null) continue
    seen.add(e.type)
    out.push({
      id: `ev:${e.id}`, at, category: words?.category ?? 'execution',
      title: words?.title ?? e.title ?? e.type.replace(/^campaign\./, '').replace(/_/g, ' '),
      result: e.blockers.length ? e.blockers.map((b) => feederSkipWords(b)).join(', ') : e.description ?? undefined,
      icon: e.severity === 'error' ? 'alert-circle' : e.type.includes('targets') ? 'users' : 'bolt',
      tone: e.severity === 'error' ? 'crit' : e.severity === 'warning' ? 'attn' : 'exec',
    })
  }
  const stamp = (key: string, iso: string | null | undefined, title: string, icon: LCActivityEvent['icon']) => {
    const at = ms(iso)
    if (at === null || seen.has(key)) return
    out.push({ id: `stamp:${key}`, at, category: 'execution', title, icon, tone: 'exec' })
  }
  stamp('campaign.activated', core?.lifecycle.activated_at, 'Campaign activated', 'bolt')
  stamp('campaign.paused', core?.lifecycle.paused_at, 'Campaign paused', 'pause')
  stamp('campaign.resumed', core?.lifecycle.resumed_at, 'Campaign resumed', 'play')
  stamp('campaign.completed', core?.lifecycle.completed_at, 'Campaign completed', 'check')

  // feeder passes that placed rows: batches
  for (const b of intel?.batches?.list ?? []) {
    const at = ms(b.started_at)
    if (at === null) continue
    const o = b.outcome
    const bits = [o.delivered ? `${nf(o.delivered)} delivered` : null, o.filtered ? `${nf(o.filtered)} filtered` : null, o.failed ? `${nf(o.failed)} not delivered` : null, o.replied ? `${plural(o.replied, 'reply', 'replies')}` : null, o.queued_now ? `${nf(o.queued_now)} still queued` : null].filter(Boolean)
    out.push({
      id: `batch:${b.run_id}`, at, category: 'queue', icon: 'layers', tone: 'exec',
      title: `Batch ${b.n} · ${plural(b.created, 'seller')} queued`,
      source: `${nf(b.ready)} ready${b.duration_ms !== null ? ` · ${(b.duration_ms / 1000).toFixed(1)}s` : ''}`,
      result: bits.join(' · ') || undefined,
      onOpen: () => h.openBatch(b),
    })
  }

  // the latest pass, when it placed nothing — one line, with why
  const block = feederBlock(f.feeder)
  const passAt = ms(f.feeder?.at)
  if (block && passAt !== null) {
    out.push({
      id: `pass:${f.feeder?.at}`, at: passAt, category: block.gate === 'sender' ? 'senders' : 'execution', icon: 'alert', tone: 'attn',
      title: `Feeder pass placed nothing · ${GATE_LABEL[block.gate]} gate`,
      result: block.reasons.slice(0, 3).map((r) => `${r.words} (${nf(r.n)})`).join(' · '),
      onOpen: () => h.openGate(block.gate),
    })
  }
  const idle = intel?.batches?.empty_passes ?? core?.timeline.idle_feeder_checks?.count ?? null
  if (idle && core?.timeline.idle_feeder_checks?.last_at) {
    const at = ms(core.timeline.idle_feeder_checks.last_at)
    if (at !== null) out.push({ id: 'idle-passes', at: at - 1, category: 'system', icon: 'refresh-cw', tone: 'neutral', title: `Feeder checked ${plural(idle, 'time')} without placing anything`, result: 'Every 5 minutes while live' })
  }

  // delivery, one line per hour (or day) of sends
  const series = intel?.series
  if (series) {
    for (const b of series.buckets) {
      if (!b.sent && !b.failed) continue
      const at = Date.parse(b.t) + series.step_ms - 1
      out.push({
        id: `send:${b.t}`, at, category: 'delivery', icon: 'send', tone: b.failed > b.delivered ? 'attn' : 'ok',
        title: `${plural(b.sent, 'text')} left the queue`,
        result: [b.delivered ? `${nf(b.delivered)} delivered` : null, b.failed ? `${nf(b.failed)} not delivered` : null].filter(Boolean).join(' · ') || undefined,
        source: series.grain === 'hour' ? 'this hour' : 'this day',
      })
    }
  }

  // replies (bursts collapse)
  for (const r of intel?.replies?.list ?? []) {
    const at = ms(r.first_reply_at)
    if (at === null) continue
    out.push({
      id: `reply:${r.seller_phone}`, at, category: 'replies', icon: 'message', tone: r.bucket === 'interested' ? 'ok' : r.bucket === 'opt_out' ? 'attn' : 'flow',
      title: 'Seller replied', subject: r.seller_name ?? undefined, result: REPLY_META[r.bucket].label,
      groupKey: 'reply', groupNoun: 'sellers replied',
      onOpen: () => h.openReply(r),
    })
  }

  // outcomes, attributable only
  for (const o of intel?.outcomes?.opportunities ?? []) {
    const at = ms(o.created_at)
    if (at !== null) out.push({ id: `opp:${o.id}`, at, category: 'outcomes', icon: 'target', tone: 'ok', title: 'Opportunity opened', subject: o.seller ?? o.address ?? undefined, result: o.stage ? o.stage.replace(/_/g, ' ') : undefined, onOpen: h.openOutcomes })
    for (const m of o.moves) {
      const mat = ms(m.at)
      if (mat !== null) out.push({ id: `move:${o.id}:${m.at}`, at: mat, category: 'outcomes', icon: 'trending-up', tone: 'ok', title: 'Stage advanced', subject: o.seller ?? undefined, result: `${(m.from ?? '—').replace(/_/g, ' ')} → ${(m.to ?? '—').replace(/_/g, ' ')}`, onOpen: h.openOutcomes })
    }
  }
  for (const offer of intel?.outcomes?.offers ?? []) {
    const at = ms(offer.sent_at)
    if (at !== null) out.push({ id: `offer:${offer.id}`, at, category: 'outcomes', icon: 'dollar-sign', tone: 'ok', title: 'Offer sent', result: offer.price ? `$${Math.round(offer.price).toLocaleString('en-US')}` : undefined, onOpen: h.openOutcomes })
  }

  return out.sort((a, b) => b.at - a.at)
}

/* ══ actions: effects stated before they happen ═══════════════════════════ */

export type ActionSpec = { title: string; confirmLabel: string; tone: 'primary' | 'danger'; effects: LCEffect[] }

/**
 * What each send-affecting action will do, in effects (never "Are you
 * sure?"). Every fact is a real count; the pause effects state the measured
 * behaviour, including that automatic replies carrying the campaign id wait
 * too (process-send-queue defers every row of a paused campaign).
 */
export function actionSpec(action: string, c: CampaignSummary, input: WarInput): ActionSpec | null {
  const f = facts(input)
  const name = c.campaign_name || 'this campaign'
  switch (action) {
    case 'pause':
      return {
        title: `Pause ${name}?`, confirmLabel: 'Pause campaign', tone: 'primary',
        effects: [
          { kind: 'stops', text: 'New campaign texts stop — the feeder places nothing while it is paused.' },
          { kind: 'keeps', text: (f.queueLive ?? 0) > 0 ? `${plural(f.queueLive ?? 0, 'queued text')} are held, not cancelled; Resume sends the same rows.` : 'Rows already queued are held, not cancelled; Resume sends the same rows.' },
          { kind: 'note', text: 'Automatic replies that carry this campaign’s id also wait until you resume — conversations started by it pause with it.' },
          { kind: 'keeps', text: 'Inbound replies still arrive in Inbox, and execution history is kept.' },
        ],
      }
    case 'resume':
      return {
        title: `Resume ${name}?`, confirmLabel: 'Resume sending', tone: 'primary',
        effects: [
          { kind: 'note', text: f.ready ? `Continues with the remaining ${plural(f.ready, 'ready seller')}.` : 'Releases the held rows; no ready sellers remain to place.' },
          { kind: 'keeps', text: 'Sellers already messaged are not texted again — one text per seller per touch.' },
          { kind: 'keeps', text: 'Every text still passes the contact window, suppression, DNC and sender checks.' },
        ],
      }
    case 'archive':
      return {
        title: `Archive ${name}?`, confirmLabel: 'Archive campaign', tone: 'danger',
        effects: [
          { kind: 'stops', text: 'The campaign stops and moves to the archive.' },
          { kind: 'keeps', text: 'Its execution history is kept; you can restore it later.' },
        ],
      }
    case 'queue_batch':
      return {
        title: 'Queue the next batch as test rows?', confirmLabel: 'Queue test batch', tone: 'primary',
        effects: [
          { kind: 'note', text: `Ready sellers (${nf(f.ready)}) are written to the queue as no-send test rows.` },
          { kind: 'keeps', text: 'Nothing is sent to anyone; live refills stay with the feeder.' },
        ],
      }
    case 'restore':
      return {
        title: `Restore ${name}?`, confirmLabel: 'Restore to draft', tone: 'primary',
        effects: [
          { kind: 'note', text: 'It returns to drafts with its audience and history.' },
          { kind: 'keeps', text: 'Nothing is sent until it is scheduled or launched again.' },
        ],
      }
    case 'convert_to_live':
      return {
        title: 'Switch to live?', confirmLabel: 'Go live', tone: 'primary',
        effects: [
          { kind: 'note', text: 'Texts will go to real sellers. Test mode ends for this campaign.' },
          { kind: 'note', text: `${plural(f.ready ?? 0, 'ready seller')} in scope.` },
        ],
      }
    default:
      return null
  }
}

/** Which gate a held reason code blocks — for routing a reason click to the right inspector. */
export const gateForHeld = (code: string): GateKey => gateOfReason(code)
