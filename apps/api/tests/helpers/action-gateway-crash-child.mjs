// Child process for the Action Gateway REAL-SIGKILL proofs (action-gateway-crash-pg.test.mjs). It runs the REAL
// gateway over the disposable DB (AS lc_action_gateway, tenant claim) and dies at the requested point:
//   before_domain_write  the execution lease is claimed, the domain write has not started: the process
//                        SIGKILLs ITSELF (nothing written; the lease must expire and recovery re-execute)
//   in_domain_write      the domain write is in flight inside PostgreSQL (blocked on a row lock the parent
//                        holds); it prints IN_DOMAIN_WRITE and the PARENT SIGKILLs it
// No network: fetch is trapped. No provider exists in this path at all.
import { pgSupabase } from './pg-supabase.mjs'
import { gatewayPool, PEPPER } from './action-gateway-pg.mjs'
import { createActionGateway, createPostgrestActionStore, createGatewayReads, createGatewayServices } from '../../src/lib/domain/action-gateway/index.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

__setAutomationHoldResolverForTests(null)
globalThis.fetch = async (u) => { throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
const [url, org, credential, thread_id, point, client_key] = process.argv.slice(2)
const pool = gatewayPool(url, org, 3)
const db = pgSupabase(pool)
const real = createPostgrestActionStore({ db })
const store = {
  ...real,
  async domainWrite(fn, id, token) {
    if (point === 'before_domain_write') { process.stdout.write('CLAIMED_BEFORE_DOMAIN_WRITE\n'); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}) }
    process.stdout.write('IN_DOMAIN_WRITE\n')
    return real.domainWrite(fn, id, token)
  },
}
const gateway = createActionGateway({ store, reads: createGatewayReads({ db }), services: createGatewayServices({ db, store: real }), pepper: PEPPER, dataOrgId: org, worker: 'crash-child', leaseSeconds: 2 })
await gateway.call({ credential, tool: 'set_thread_hold', args: { client_request_id: client_key, thread_id, reason_code: 'operator_review' } })
process.stdout.write('NOT_KILLED\n')
process.exit(3)
