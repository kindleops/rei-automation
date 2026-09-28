/**
 * CONVERSATION SIGNAL SERVICE — loads one thread's messages and hands them to
 * the pure analyzer (conversation-signal.js). Read-only: two SELECTs, no writes.
 *
 * Thread membership mirrors pipeline-command-service (thread_key OR either
 * phone leg). The last 400 messages are analysed. Test / proof / canary rows
 * are flagged isTest and excluded by the analyzer:
 *   metadata.proof = true · metadata.source ~ canary|proof|test|probe|certification
 *   event_type ~ proof · fictitious +1555… numbers
 * The seller's timezone comes from phones.timezone (canonical_e164 = thread);
 * without one, timing is reported in UTC and labelled so.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { analyzeConversation } from './conversation-signal.js'

export const CONVERSATION_SIGNAL_MESSAGE_LIMIT = 400

const TEST_SOURCE = /canary|proof|test|probe|certification/i
const FICTITIOUS = /^\+?1?555\d{7}$/
const PHONE = /^\+?\d{10,15}$/

const clean = (v) => String(v ?? '').trim()

export function isTestMessageRow(row) {
  if (clean(row.meta_proof).toLowerCase() === 'true') return true
  if (TEST_SOURCE.test(clean(row.meta_source))) return true
  if (/proof/i.test(clean(row.event_type))) return true
  return FICTITIOUS.test(clean(row.from_phone_number)) || FICTITIOUS.test(clean(row.to_phone_number))
}

/**
 * @param {{ threadKey: string, now?: number }} args
 * @param {{ supabase?: object }} [deps]
 * @returns {Promise<null | (ReturnType<typeof analyzeConversation> & { threadKey: string, messageLimit: number, truncated: boolean, excludedTestRows: number })>}
 */
export async function getConversationSignal({ threadKey, now } = {}, deps = {}) {
  const thread = clean(threadKey)
  if (!thread || /[,()]/.test(thread)) return null
  const client = deps.supabase || defaultSupabase

  const [msgRes, tzRes] = await Promise.all([
    client
      .from('message_events')
      .select('id, direction, message_body, detected_intent, created_at, delivery_status, event_type, is_opt_out, from_phone_number, to_phone_number, meta_source:metadata->>source, meta_proof:metadata->>proof')
      .or(`thread_key.eq.${thread},from_phone_number.eq.${thread},to_phone_number.eq.${thread}`)
      .order('created_at', { ascending: false })
      .limit(CONVERSATION_SIGNAL_MESSAGE_LIMIT),
    PHONE.test(thread)
      ? client.from('phones').select('timezone').eq('canonical_e164', thread).not('timezone', 'is', null).limit(1)
      : Promise.resolve({ data: [] }),
  ])
  if (msgRes.error) throw msgRes.error
  const raw = msgRes.data || []
  if (!raw.length) return null

  let excludedTestRows = 0
  const messages = raw.reverse().map((r) => {
    const isTest = isTestMessageRow(r)
    if (isTest) excludedTestRows++
    return { ...r, isTest }
  })
  const timezone = tzRes?.error ? null : (tzRes?.data?.[0]?.timezone ?? null)
  const signal = analyzeConversation(messages, { now: now ?? Date.now(), timezone })
  return { threadKey: thread, messageLimit: CONVERSATION_SIGNAL_MESSAGE_LIMIT, truncated: raw.length >= CONVERSATION_SIGNAL_MESSAGE_LIMIT, excludedTestRows, ...signal }
}
