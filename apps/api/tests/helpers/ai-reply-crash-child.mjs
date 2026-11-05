// Child process for the rc-8.5.21 AI-reply crash-recovery tests (ai-reply-crash-recovery-8521-pg.test.mjs).
// The process SIGKILLs ITSELF at the requested point; the provider is never real (the only "send" it can
// reach kills it, or is a simulated acceptance that is never reached).
//   after_queue_insert  one runtime tick of the conversation.turn job: the AI row is COMMITTED to
//                       send_queue, then the worker dies before the turn records the dispatch outcome
//   before_seam         the REAL runner item path on the claimed AI row: killed inside the send-time
//                       contact guard (after the claim, before the §11 seam: no attempt, no provider call)
//   in_provider         the REAL runner item path: killed inside the provider call (the §11 attempt and
//                       its provider_request_started marker are committed: ambiguous)
import pg from 'pg'
import { isoPool, pgSupabase } from './pg-supabase.mjs'
import { harness } from './conversation-e2e-pg.mjs'
import { itemDeps } from './followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { lookupAiGeneratedMessageByQueueKey, recordAiRowProviderOutcome } from '../../src/lib/domain/messages/ai-generated-message.js'
import { loadNewerInboundsForRow } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { normalizeSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { registryHoldResolver } from './competing-sources-pg.mjs'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

const [point, url, apiUrl, rowId, token] = process.argv.slice(2)
globalThis.fetch = async (u) => { throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
__setSenderContinuityResolverForTests(null)
const die = async (label) => {
  process.stdout.write(`${label}\n`)
  process.kill(process.pid, 'SIGKILL')
  await new Promise(() => {})
}
const pool = isoPool(url, 4)
const sb = pgSupabase(pool)
// the REAL hold registry of the disposable DB answers every hold check (as in the parent test)
__setAutomationHoldResolverForTests(registryHoldResolver(sb))
if (point === 'after_queue_insert') {
  const api = new pg.Pool({ connectionString: apiUrl, max: 4 })
  const h = harness({ db: { api }, pool, sb }, { afterQueueInsert: async () => die('KILL_AFTER_QUEUE_INSERT') })
  await h.tick('child-worker')
} else {
  // the runner's claim stands in for a dead runner: the REAL item path, the real §11 store
  const row = (await pool.query('select * from public.send_queue where id = $1', [rowId])).rows[0]
  const readSwitch = async (k) => (await pool.query('select value from public.system_control where key = $1', [k])).rows[0]?.value ?? null
  const provider = { send: async () => { if (point === 'in_provider') await die('KILL_IN_PROVIDER'); return { ok: true, sid: 'SMchild', provider_message_id: 'SMchild', status: 'queued' } } }
  const now = new Date().toISOString()
  const deps = {
    ...itemDeps({ pool, sb }, { provider, now, store: createSellerCommunicationStore({ supabase: sb }) }),
    readAiConversationSwitch: readSwitch,
    loadAiGeneratedMessage: (k) => lookupAiGeneratedMessageByQueueKey(sb, k),
    loadNewerInbounds: (r) => loadNewerInboundsForRow(sb, r),
    recordAiRowProviderOutcome: (s, r, o) => recordAiRowProviderOutcome(sb, r, o),
    ...(point === 'before_seam' ? { runSendTimeContactGuard: async () => die('KILL_BEFORE_SEAM') } : {}),
  }
  await processSendQueueItem(normalizeSendQueueRow({ ...row }), { ...deps, claimedLockToken: token })
}
process.stdout.write('NOT_KILLED\n')
process.exit(3)
