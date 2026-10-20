// rc-8.5.21 v3 crash-recovery child (v3fix-crash-recovery-8521-pg.test.mjs). The process SIGKILLs ITSELF at:
//   inbound_before_enqueue  the webhook's inbound message_events row is COMMITTED, then the deferred
//                           conversation.decide enqueue runs — and the process dies before it reaches the DB
//   delivery_before_followup the delivery webhook synced the delivered status and marked its log row
//                           processed; the process dies before the next silence follow-up is planned
// Network is trapped; nothing here can reach a provider.
import crypto from 'node:crypto'
import { isoPool, pgSupabase } from './pg-supabase.mjs'

const [point, url, a1, a2, a3] = process.argv.slice(2)
globalThis.fetch = async (u) => { throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
const pool = isoPool(url, 4)
const sb = pgSupabase(pool)
const die = async (label) => { process.stdout.write(`${label}\n`); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}) }

if (point === 'inbound_before_enqueue') {
  const [sid, phone, body] = [a1, a2, a3]
  // 1. the webhook's write (committed)
  await pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id)
                    values ($1, $2, 'inbound', $3, $3, '+13125550199', $4, now() - interval '10 minutes', now() - interval '10 minutes', 'p1')`, [crypto.randomUUID(), sid, phone, body])
  // 2. the REAL hook; its deferred enqueue dies at the runtime gate (before any enqueue reaches the DB)
  const { scheduleConversationAiShadow } = await import('../../src/lib/ai/conversation-ai-shadow-hook.js')
  scheduleConversationAiShadow({ providerMessageSid: sid, messageBody: body }, { env: { AI_CONVERSATION_SHADOW_ENABLED: 'true' }, gate: async () => die('KILL_BEFORE_DECIDE_ENQUEUE') })
  await new Promise(() => {})
}

if (point === 'delivery_before_followup') {
  const [sid, webhookId] = [a1, a2]
  const { processDeliveryWebhookLive } = await import('../../src/lib/domain/webhooks/webhook-event-processor.js')
  const log = (await pool.query('select * from public.webhook_log where id = $1', [webhookId])).rows[0]
  await processDeliveryWebhookLive(log, { supabase: sb }, {
    // the delivery sync: the row and the outbound event become delivered (committed)
    syncDeliveryEvent: async () => {
      await pool.query(`update public.send_queue set queue_status = 'delivered', delivered_at = now() - interval '30 minutes' where provider_message_id = $1`, [sid])
      await pool.query(`update public.message_events set delivery_status = 'delivered' where provider_message_sid = $1`, [sid])
      return { send_queue_count: 1, message_events_count: 1, final_delivery_status: 'delivered' }
    },
    maybeScheduleFollowUpAfterDelivery: async () => die('KILL_BEFORE_FOLLOWUP_SCHEDULE'),
  })
  process.stdout.write('NOT_KILLED\n')
  process.exit(3)
}
process.stdout.write(`UNKNOWN_POINT ${point}\n`)
process.exit(4)
