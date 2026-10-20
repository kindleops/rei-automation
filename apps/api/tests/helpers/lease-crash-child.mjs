// Child process for the RUN-09 real-SIGKILL tests (processing-lease-recovery-8521-pg.test.mjs): the REAL
// queue runner item path (processSendQueueItem, via the lifecycle harness's dispatchRow) over the
// disposable DB with the REAL §11 store (seller_communication_attempts in PG). The process SIGKILLs
// ITSELF at the requested point:
//   before_seam  inside the send-time contact guard: after the claim, before the §11 seam (no attempt
//                allocated, no provider call)
//   in_provider  inside the provider call: the §11 attempt and its provider_request_started marker are
//                committed, the request has begun (ambiguous)
//   after_allocate (rc-8.5.21 v3, RT-14) right after the §11 attempt allocation committed, before the
//                provider-start marker (no provider call can have happened)
//   after_accept (rc-8.5.21 v3, RT-15) the provider ACCEPTED and the attempt's outcome (with the provider
//                message id) is committed; the worker dies before the queue row is finalized
// The provider is never real: the only "send" this process can reach kills it.
import { isoPool, pgSupabase } from './pg-supabase.mjs'
import { dispatchRow } from './followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

__setAutomationHoldResolverForTests(null)
const [url, rowId, token, point, now] = process.argv.slice(2)
globalThis.fetch = async (u) => { throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
const pool = isoPool(url, 4)
const sb = pgSupabase(pool)
const row = (await pool.query('select * from public.send_queue where id = $1', [rowId])).rows[0]
const die = async (label) => {
  process.stdout.write(`${label}\n`)
  process.kill(process.pid, 'SIGKILL')
  await new Promise(() => {})
}
// a provider id per row (provider ids are unique in the attempt ledger)
const SID = point === 'after_accept' ? `SMchild${String(rowId).replace(/-/g, '').slice(0, 10)}` : 'SMchild'
const provider = { send: async () => { if (point === 'in_provider') await die('KILL_IN_PROVIDER'); return { ok: true, sid: SID, provider_message_id: SID, status: 'queued' } } }
const extraDeps = point === 'before_seam'
  ? { runSendTimeContactGuard: async () => die('KILL_BEFORE_SEAM') }
  : {}
const realStore = createSellerCommunicationStore({ supabase: sb })
const store = {
  ...realStore,
  allocateAttempt: async (a) => { const r = await realStore.allocateAttempt(a); if (point === 'after_allocate') await die('KILL_AFTER_ALLOCATE'); return r },
  recordAttemptOutcome: async (a) => { const r = await realStore.recordAttemptOutcome(a); if (point === 'after_accept') await die(r?.ok ? 'KILL_AFTER_ACCEPT' : `OUTCOME_WRITE_FAILED ${r?.reason}`); return r },
}
await dispatchRow({ pool, sb }, { row, token }, { provider, now, store, extraDeps })
process.stdout.write('NOT_KILLED\n')
process.exit(3)
