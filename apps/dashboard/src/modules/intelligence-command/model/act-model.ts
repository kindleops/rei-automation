/**
 * ACT MODEL — capability proposals and the diff card (Cursor's apply/accept,
 * through the real approvals API only).
 *
 * The capability matrix (GET /actions) carries no input schema, so the forms
 * here mirror the server's input_schema for the approval-tier capabilities at
 * 6ecbae6b (apps/api/src/lib/agent/capabilities/defs/*.js). The server
 * re-validates everything; a refused input comes back as its code.
 *
 *   pipeline.propose_stage_change   { opportunity_id, to_stage, reason }      ← a Deal chip
 *   campaigns.prepare_launch_approval { campaign_id, start: now|at, start_at? } ← a Campaign chip
 *   inbox.prepare_reply             { thread_ref (sealed thr_…), template_id } — the sealed ref only
 *                                    comes from a capability read (inbox.find_conversations); a page's
 *                                    thread key is never sent, so this form needs that read first.
 */
import type { CapabilityApproval, CapabilityDescriptor } from '../api/ic-client'
import type { IcChip } from './context-model'

/** UNIVERSAL_STAGE_ORDER (apps/api …/opportunity/universal-pipeline-registry.js) minus `closed` — closed-won is closing-authority only (the server refuses it). */
export const STAGE_OPTIONS = ['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close'] as const

export interface ActProposal {
  capability_id: string
  title: string
  /** the chip that supplied the target */
  chipKey: string
  fields: ActField[]
  /** input built from field values (null when a required value is missing) */
  build: (values: Record<string, string>, reason: string) => Record<string, unknown> | null
  available: boolean
  why: string | null
}

export interface ActField { name: string; label: string; kind: 'select' | 'text' | 'datetime'; options?: readonly string[]; required: boolean }

export function proposalsFor(chips: IcChip[], catalog: CapabilityDescriptor[] | null): ActProposal[] {
  const has = (id: string) => Boolean(catalog?.some((c) => c.id === id))
  const out: ActProposal[] = []
  for (const c of chips) {
    if (c.kind === 'deal') {
      out.push({
        capability_id: 'pipeline.propose_stage_change', title: `Propose a stage change · ${c.label}`, chipKey: c.key,
        fields: [{ name: 'to_stage', label: 'Move to stage', kind: 'select', options: STAGE_OPTIONS, required: true }],
        build: (v, reason) => (v.to_stage && reason.trim().length >= 3 ? { opportunity_id: c.id, to_stage: v.to_stage, reason: reason.trim().slice(0, 240) } : null),
        available: has('pipeline.propose_stage_change'), why: has('pipeline.propose_stage_change') ? null : 'not in the server capability matrix',
      })
    }
    if (c.kind === 'campaign') {
      out.push({
        capability_id: 'campaigns.prepare_launch_approval', title: `Prepare launch · ${c.label}`, chipKey: c.key,
        fields: [{ name: 'start', label: 'Start', kind: 'select', options: ['now', 'at'], required: true }, { name: 'start_at', label: 'Start at (ISO, when "at")', kind: 'datetime', required: false }],
        build: (v) => (v.start === 'now' ? { campaign_id: c.id, start: 'now' } : v.start === 'at' && /^\d{4}-\d{2}-\d{2}T/.test(v.start_at ?? '') ? { campaign_id: c.id, start: 'at', start_at: v.start_at } : null),
        available: has('campaigns.prepare_launch_approval'), why: has('campaigns.prepare_launch_approval') ? null : 'not in the server capability matrix',
      })
    }
    if (c.kind === 'thread') {
      out.push({
        capability_id: 'inbox.prepare_reply', title: `Template reply · ${c.label}`, chipKey: c.key, fields: [],
        build: () => null, available: false,
        why: 'needs a sealed thread ref from inbox.find_conversations — the page thread key is never sent',
      })
    }
  }
  return out
}

/* ── the diff ─────────────────────────────────────────────────────────── */

export interface DiffRow { field: string; before: string | null; after: string | null; kind: 'change' | 'add' | 'context' }

const fmt = (v: unknown): string | null => {
  if (v == null || v === '') return null
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
const label = (k: string) => k.replace(/_/g, ' ')

/**
 * The exact before → after of an approval, from the server's intended_change
 * (from_X / to_X pairs) and its display preview (the rendered SMS text).
 * Nothing is inferred beyond what the approval says.
 */
export function approvalDiff(a: Pick<CapabilityApproval, 'capability_id' | 'intended_change' | 'target' | 'preview'>): DiffRow[] {
  const ch = a.intended_change ?? {}
  const rows: DiffRow[] = []
  const used = new Set<string>(['action'])
  for (const k of Object.keys(ch)) {
    const m = /^from_(.+)$/.exec(k)
    if (!m) continue
    const to = `to_${m[1]}`
    used.add(k)
    if (to in ch) {
      used.add(to)
      rows.push({ field: label(m[1]), before: fmt(ch[k]), after: fmt(ch[to]), kind: 'change' })
    }
  }
  if (ch.action === 'launch') {
    const start = (ch.start ?? {}) as { mode?: string; at?: string | null }
    used.add('start'); used.add('from_status')
    rows.push({ field: 'status', before: fmt(ch.from_status), after: start.mode === 'at' ? `scheduled · ${start.at ?? 'start time'}` : 'active · starting now', kind: 'change' })
  }
  if (ch.action === 'send_template_reply') {
    used.add('rendered_hash'); used.add('sender_hash')
    rows.push({ field: 'message', before: null, after: a.preview?.message_text ?? `${fmt(ch.rendered_chars) ?? '?'} characters (open the approval for the exact text)`, kind: 'add' })
    if (a.preview?.recipient_mask || a.preview?.sender_mask) rows.push({ field: 'route', before: null, after: `to ${a.preview?.recipient_mask ?? 'recipient'} from ${a.preview?.sender_mask ?? 'sender'}`, kind: 'context' })
  }
  for (const k of Object.keys(ch)) {
    if (used.has(k)) continue
    const v = fmt(ch[k])
    if (v != null) rows.push({ field: label(k), before: null, after: v, kind: 'context' })
  }
  return rows
}

export const CAPABILITY_LABEL: Record<string, string> = {
  'inbox.prepare_reply': 'Template reply',
  'campaigns.prepare_launch_approval': 'Campaign launch',
  'pipeline.propose_stage_change': 'Stage change',
  'missions.create': 'Runtime mission',
  'platform.health': 'Platform health',
}

/** The plain outcome line after a decide call (the server's recorded result, never assumed). */
export function decideMessage(decision: 'approve' | 'deny', r: { ok: boolean; state: string | null; code: string | null; execution_result: Record<string, unknown> | null }, labels: Record<string, string>): string {
  if (r.code) return labels[r.code] ?? r.code
  if (decision === 'deny') return 'Rejected. Nothing changed.'
  if (r.ok) return 'Approved and executed — the result below is the server readback.'
  return `Approved; the service refused: ${String(r.execution_result?.code ?? r.state ?? 'unknown')}`
}
