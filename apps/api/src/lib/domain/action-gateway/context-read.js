// The separately scoped CONVERSATION CONTEXT read (scope conversation_context.read + grant
// conversation.read_context). A projection of the canonical conversation inputs — the SAME loader the
// turn engine, R3 and the review drafts use (ai/conversation-canonical-inputs#loadCanonicalInputs) —
// with every phone number and email masked and no routing value at all: the thread is its id, the sender
// is "established or not", never a number. Audited by the gateway.
import { maskString } from '../../agent/research/pii.js'
import { ledgerFromContextInput, ledgerSummary } from '../conversation-ai/fact-ledger.js'
import { gwErr } from './errors.js'
import { MODEL_RESULT_BUDGET, decodeCursor, encodeCursor } from './actions/workforce/page.js'

export const CONTEXT_READ_VERSION = 'action-gateway.context-read.v1'
const E164 = /\+?1?[\s().-]*[2-9][0-9]{2}[\s().-]*[0-9]{3}[\s().-]*[0-9]{4}/g
const mask = (s) => maskString(String(s ?? ''), {})[0].replace(E164, '[phone withheld]')
const iso = (v) => (v ? new Date(v).toISOString() : null)

/** Every string anywhere in a value, masked (a second net under the projection). */
function maskDeep(v, depth = 0) {
  if (depth > 8 || v == null) return v
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1))
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, depth + 1)]))
  if (typeof v === 'string') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : mask(v)
  return v
}

/**
 * The result is bounded for a model (actions/workforce/page.js): the permission state, facts, persona and property evidence
 * are ALWAYS whole (authorization-relevant, never paged); the messages are the newest that fit, and `messages_page` says how
 * many there are and gives `older_cursor` for the next older page. Nothing is cut silently.
 * @param {{ input: { thread_id: string, message_limit?: number, cursor?: string }, reads, services, now: () => number }} o
 */
export async function readConversationContext({ input, reads, services, now = () => Date.now() }) {
  const thread = await reads.thread(input.thread_id)
  if (!thread?.thread_key) throw gwErr('not_found', 'THREAD_NOT_FOUND', 'no inbox thread with this id')
  const latest = await reads.latestInbound(thread.thread_key)
  const at = new Date(now()).toISOString()
  const ci = latest?.provider_message_sid ? await services.canonicalInputs({ providerMessageSid: latest.provider_message_sid, now: at }) : null
  const limit = Math.min(Math.max(Number(input.message_limit) || 20, 1), 40)
  const kind = `messages:${String(input.thread_id).toLowerCase()}`
  const skip = decodeCursor(input.cursor, kind)?.o ?? 0 // messages already read, counted from the newest
  const sorted = (ci?.input?.thread || []).slice().sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0))
  const window = sorted.slice(Math.max(0, sorted.length - skip - limit), Math.max(0, sorted.length - skip))
  const msgs = window
  let facts = null
  try { facts = ci ? ledgerSummary(ledgerFromContextInput(ci.input, { queueRows: ci.queueRows || [], now: at })) : null } catch { facts = null }
  let eligibility = null
  try { eligibility = ci ? await ci.eligibilityFor({ now: at }) : null } catch { eligibility = { blocked: true, reasons: ['send_time_guard_read_failed'] } }
  let hold
  try { hold = await services.holdCheck({ threadKey: thread.thread_key, threadId: thread.id, propertyId: thread.property_id || null, capability: 'ai_reply_decision' }) } catch { hold = { held: true, fail_closed: true } }
  const perm = await reads.permission({ id: thread.id, thread_key: thread.thread_key }).catch(() => ({ blocked: true, reasons: ['permission_state_unreadable'] }))
  const out = maskDeep({
    version: CONTEXT_READ_VERSION,
    thread_id: thread.id,
    generated_at: at,
    messages: msgs.map((m) => ({ message_id: m.id || null, direction: m.direction, at: iso(m.at), body: mask(m.body), intent: m.intent || null, use_case: m.use_case || null })),
    latest_inbound_at: iso(latest?.created_at),
    facts: facts ? { stage: facts.stage || null, next_missing: facts.next_missing || null, facts: facts.facts || {}, questions: facts.questions || {}, offer_requests: facts.offer_requests ?? 0, objections: facts.objections || [], follow_up: facts.follow_up || null } : null,
    persona: ci ? { name: ci.continuity?.persona_name || null, established: ci.continuity?.ok === true, source: ci.continuity?.persona_source || null } : null,
    sender: { established: Boolean(ci?.continuity?.sender_number), routing: 'resolved_inside_leadcommand' },
    permission: {
      contact_blocked: perm.blocked === true || eligibility?.blocked === true,
      reasons: [...new Set([...(perm.reasons || []), ...((eligibility?.reasons || []).map(String))])],
      stop_on_latest_inbound: (perm.reasons || []).includes('stop_requested'),
      hold: { held: hold?.held !== false, category: hold?.fail_closed ? 'lookup_failed' : hold?.hold_type || null },
      reply_window: eligibility?.timing ? { lawful_now: eligibility.timing.lawful === true, next_permitted_at: iso(eligibility.timing.next_permitted_at) } : null,
    },
    property_evidence: {
      properties: (ci?.input?.properties || []).map((p) => ({ property_id: String(p.property_id), property_type: p.property_type || null, city: p.city || null, state: p.state || null })),
      offers: (ci?.input?.offers || []).map((o) => ({ property_id: o.property_id ? String(o.property_id) : null, status: o.status || null, amount: o.amount ?? null, created_at: iso(o.created_at) })),
      scheduled_follow_ups: (ci?.input?.followups || []).length,
    },
    withheld: ['phone_numbers', 'emails', 'owner_and_prospect_names', 'street_addresses', 'sender_number'],
  })
  // the newest messages that fit; the rest are one older_cursor away
  const all = out.messages
  let keep = all.length
  const sizeWith = (n) => JSON.stringify({ ...out, messages: all.slice(all.length - n) }).length + 220
  while (keep > 1 && sizeWith(keep) > MODEL_RESULT_BUDGET) keep -= 1
  const messages = all.slice(all.length - keep)
  const read = skip + messages.length
  const older = sorted.length - read
  return { ...out, messages, messages_page: { returned: messages.length, newest_skipped: skip, total: sorted.length, older_remaining: older, older_cursor: older > 0 ? encodeCursor({ k: kind, o: read }) : null, complete: older <= 0, budget_chars: MODEL_RESULT_BUDGET } }
}
