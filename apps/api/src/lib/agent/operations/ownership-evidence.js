// Ownership / interest EVIDENCE for recovery (8.5.21-b, owner fix 2026-10-16).
//
// The recovery permission check reads ownership from real evidence only. The strongest evidence is the
// CANONICAL thread ledger (conversation-ai/ledger.js): it reads both directions, so a bare "No" counts as
// an ownership DENIAL only when it answers OUR ownership question, and as disinterest only when it
// answers the interest question. This module turns a thread's rows into that verdict (pure; message
// bodies are read in-process and never returned) and the nurture intent recovery hands to the 8.5.21-a
// follow-up pipeline.
import crypto from 'node:crypto'
import { threadLedgerFromRows, factLedgerOf } from '../../domain/conversation-ai/ledger.js'

export const OWNERSHIP_EVIDENCE_VERSION = 'ownership-evidence.v1'
export const NURTURE_INTENT_CONTRACT = 'lc.recovery-nurture-intent.v1'
export const NURTURE_INTENT_RULES = Object.freeze({ follow_up_days: 30, recent_window_days: 7 })

/**
 * @param {Array<{ id, direction, message_body?|body?, created_at?|at?, detected_intent? }>} rows  the thread, both directions
 * @returns {{ ownership: 'confirmed'|'denied'|'former_owner'|null, interest: string|null, source: 'canonical_ledger' }}
 */
export function ownershipEvidenceFromThread(rows = [], { now = new Date().toISOString() } = {}) {
  const led = threadLedgerFromRows(rows || [], { now })
  const fl = factLedgerOf(led) || {}
  const own = fl.ownership?.current?.value ?? null
  return { version: OWNERSHIP_EVIDENCE_VERSION, ownership: ['confirmed', 'denied', 'former_owner'].includes(own) ? own : null, interest: fl.seller_interest?.current?.value ?? null, source: 'canonical_ledger' }
}

/**
 * The 30-day nurture INTENT for a genuine "not interested" (owner policy). Recovery only builds and
 * enqueues it; the 8.5.21-a follow-up pipeline owns scheduling, permission re-checks, templates and
 * sending. Built ONLY for a RECENT reply (≤ recent_window_days): older replies are historical recovery,
 * which needs its own owner-approved scope — never a bulk backfill from here.
 * @param {object} f   normalizeConversationFacts() row
 * @param {object} c   classifyRecoveryCandidate() result for f
 */
export function nurtureIntentFor(f, c, { now = Date.now(), rules = NURTURE_INTENT_RULES } = {}) {
  const lm = f.inbound?.last_meaningful
  if (lm?.intent !== 'not_interested' && f.thread?.disposition !== 'not_interested') return { intent: null, reason: 'not_disinterest' }
  if (c.permission?.suppression) return { intent: null, reason: 'suppressed' }
  if (c.permission?.wrong_owner_or_number) return { intent: null, reason: 'ownership_denied_or_wrong_number_property_scoped' }
  if (f.queue?.pending > 0 || f.followup_state?.active > 0) return { intent: null, reason: 'already_scheduled' }
  const at = Date.parse(lm?.at || f.inbound?.last?.at || '')
  if (!Number.isFinite(at)) return { intent: null, reason: 'reply_time_unknown' }
  if (now - at > rules.recent_window_days * 864e5) return { intent: null, reason: 'historical_requires_owner_scope' }
  const msg = lm?.message_event_id || f.inbound?.last?.message_event_id || null
  return {
    intent: {
      contract: NURTURE_INTENT_CONTRACT,
      kind: 'not_interested_30d_nurture',
      conversation_id: f.conversation_id,
      property_ref: f.property_ref,
      opportunity_id: f.opportunity?.opportunity_id || null,
      not_interested_at: new Date(at).toISOString(),
      due_at: new Date(at + rules.follow_up_days * 864e5).toISOString(),
      ownership: c.permission?.ownership || 'unverified',
      evidence_refs: (c.evidence_refs || []).slice(0, 6),
      idempotency_key: crypto.createHash('sha256').update(`nurture30|${f.conversation_id}|${msg || at}`).digest('hex'),
      sends: 0,
    },
    reason: 'recent_genuine_disinterest',
  }
}
