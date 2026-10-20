// Child process for the T3 / T4 REAL-SIGKILL tests: one LeadCommand worker tick over the disposable DB; the process
// SIGKILLs ITSELF right before the send_queue insert (after R3's immutable record / after the offer + ledger writes).
// Nothing is sent (no provider here: the worker only inserts queue rows, which this process never reaches).
import pg from 'pg'
import { isoPool } from './pg-supabase.mjs'
import { worker } from './action-gateway-t34-world.mjs'

const [url, apiUrl, mode] = process.argv.slice(2)
const env = { owner: isoPool(url, 4), db: { api: new pg.Pool({ connectionString: apiUrl, max: 4 }) } }
const kill = async () => { process.stdout.write('KILL_AT_QUEUE_INSERT\n'); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}) }
const w = worker(env, mode === 'offer' ? { offerSendDeps: { beforeQueueInsert: kill } } : { beforeQueueInsert: kill })
await w.tick('crash-child')
process.stdout.write('NOT_KILLED\n')
process.exit(3)
