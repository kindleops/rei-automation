// Child process for the cross-server research-slot test: one worker = one OS
// process with its own pg pool + store + live agent, scanning its own job with
// deliberately slow (fake, read-only) services. Prints the run id, then exits
// when the scan is terminal.
import pg from 'pg'
import { multiDb } from '../helpers/agent-s3-fake-db.mjs'
import { createPgAgentStore } from '../../src/lib/agent/runtime/pg-store.js'
import { createLiveAgent } from '../../src/lib/agent/live/live-agent.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'
import { getEntityGraphDossier } from '../../src/lib/domain/entity-graph/entity-graph-service.js'

const [url, propertyId, delayMs] = process.argv.slice(2)
const pool = new pg.Pool({ connectionString: url, max: 3 })
const store = createPgAgentStore({ pool })
await store.open()
const db = multiDb([propertyId])
const impl = { getEntityGraphDossier: async (...a) => { await new Promise((r) => setTimeout(r, Number(delayMs))); return getEntityGraphDossier(...a) } }
const agent = createLiveAgent({ env: { AGENT_MAX_MODE: 'read' }, store, leaseTtlMs: 4000, slotPollMs: 100, createServices: () => createQuickScanServices({ db, impl }) })
const pf = await agent.quickScan.preflight({ operator_id: `op-${process.pid}`, property_ids: [propertyId] })
const c = await agent.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: `op-${process.pid}` })
process.stdout.write(`RUN ${pf.run_id}\n`)
const res = await c.done
process.stdout.write(`DONE ${pf.run_id} ${res.state}\n`)
await pool.end()
process.exit(0)
