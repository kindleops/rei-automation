import { ago, count } from '../lib/format'
import type { RegistryEntry, SystemNode as SystemNodeData } from '../lib/types'

/** Presentation of runtime state — every word derived from a field the server read from the runtime itself. */

/** The one status word a system carries, from its runtime's own evidence. */
export function systemStatus(n: SystemNodeData, w: RegistryEntry | null): { word: string; tone: 'exec' | 'ok' | 'attn' | 'crit' | 'neutral' | 'flow' | 'teal' } {
  if (n.kind === 'external') {
    if (n.key === 'brevo') return n.sending ? { word: 'Sending', tone: 'teal' } : { word: 'Off', tone: 'neutral' }
    return { word: 'External', tone: 'teal' }
  }
  if (n.kind === 'domain') return { word: 'Canonical state', tone: 'neutral' }
  if (n.kind === 'studio') {
    if (n.switched_off) return { word: 'Off', tone: 'neutral' }
    const armed = (n.members || []).filter((m) => m.status === 'armed')
    return armed.length ? { word: armed.length === 1 ? `Armed · v${armed[0].version ?? '—'}` : `${armed.length} armed`, tone: 'flow' } : { word: 'Nothing armed', tone: 'neutral' }
  }
  if (!w) return { word: 'Not read', tone: 'neutral' }
  if (w.heartbeat?.state === 'stale') return { word: 'Degraded', tone: 'crit' }
  switch (w.status) {
    case 'live': return { word: 'Live', tone: 'exec' }
    case 'armed': return { word: 'Armed', tone: 'flow' }
    case 'idle': return { word: 'Idle', tone: 'neutral' }
    case 'off': return { word: 'Off', tone: 'neutral' }
    case 'paused': return { word: 'Paused', tone: 'attn' }
    case 'not_running': return { word: 'Not running', tone: 'neutral' }
    default: return { word: w.status, tone: 'neutral' }
  }
}

/** The compact live state of a system: volume · what needs a person · last execution. */
export function systemFacts(n: SystemNodeData, w: RegistryEntry | null, window: '24h' | '7d'): Array<{ v: string; l: string; tone?: string }> {
  const out: Array<{ v: string; l: string; tone?: string }> = []
  if (n.kind === 'external') {
    if (n.key === 'textgrid') {
      out.push({ v: ago(n.last_inbound_at), l: 'last reply webhook' })
      out.push({ v: ago(n.last_callback_at), l: 'last delivery callback' })
    } else out.push({ v: n.sending ? 'on' : 'off', l: 'email_enabled' })
    return out
  }
  if (n.kind === 'studio') {
    const m = (n.members || [])[0]
    if (m) out.push({ v: m.name, l: '' })
    out.push({ v: ago(n.heartbeat_at), l: 'orchestrator beat' })
    return out
  }
  if (!w) return out
  const s = w.stats
  const runs = window === '24h' ? s.runs_24h : s.runs_7d
  if (w.workflow_key === 'campaign_execution') {
    if (runs !== null && runs !== undefined) out.push({ v: count(runs), l: `passes · ${window}` })
    if (window === '24h' && s.placed_24h !== undefined) out.push({ v: count(s.placed_24h), l: 'placed rows' })
  } else if (w.workflow_key === 'delivery_reconcile') {
    out.push({ v: ago(s.last_run_at), l: 'last reconcile' })
    if (s.last_tick) out.push({ v: count(s.last_tick.webhooks), l: 'outcomes last tick' })
    return out
  } else if (runs !== null && runs !== undefined) out.push({ v: count(runs), l: `run${runs === 1 ? '' : 's'} · ${window}` })
  if (s.needs_you) out.push({ v: count(s.needs_you), l: 'need you', tone: 'gold' })
  if (s.failed_24h && window === '24h') out.push({ v: count(s.failed_24h), l: 'failed', tone: 'crit' })
  if (s.executing) out.push({ v: count(s.executing), l: 'executing', tone: 'exec' })
  if (w.workflow_key === 'campaign_execution' && s.feeding) out.push({ v: count(s.feeding), l: 'live campaigns' })
  if (s.last_run_at && out.length < 4) out.push({ v: ago(s.last_run_at), l: 'last run' })
  return out.slice(0, 4)
}


const STATE_WORD: Record<string, string> = { live: 'Live', idle: 'Idle', armed: 'Armed', paused: 'Paused', off: 'Off', not_running: 'Not running', draft: 'Draft', archived: 'Archived' }

/** live system workflow · armed studio workflow · draft · paused · archived · not running — one visual each */
export function stateOf(w: RegistryEntry): { word: string; tone: string } {
  if (w.heartbeat?.state === 'stale' && w.group !== 'not_running') return { word: 'Degraded', tone: 'crit' }
  if (w.kind === 'studio' && w.status === 'armed') return { word: `Armed · ${w.runtime_version}`, tone: 'flow' }
  return { word: STATE_WORD[w.status] || w.status, tone: w.status === 'live' ? 'exec' : w.status === 'paused' ? 'attn' : 'neutral' }
}

