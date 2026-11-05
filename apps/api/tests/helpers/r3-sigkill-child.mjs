// Child process for the D2 real-SIGKILL test (conversation-ai-8521-e2e-pg.test.mjs): one runtime
// tick of the conversation.turn job over the disposable DB; the process SIGKILLs ITSELF right after
// the immutable ai_generated_messages record is committed and before the send_queue insert. Nothing
// is sent (no provider: R3 only inserts a queue row, which this process never reaches).
import pg from 'pg'
import { isoPool, pgSupabase } from './pg-supabase.mjs'
import { harness } from './conversation-e2e-pg.mjs'

const [url, apiUrl] = process.argv.slice(2)
const api = new pg.Pool({ connectionString: apiUrl, max: 4 })
const pool = isoPool(url, 4)
const sb = pgSupabase(pool)
const h = harness({ db: { api }, pool, sb }, {
  beforeQueueInsert: async () => {
    process.stdout.write('KILL_AT_QUEUE_INSERT\n')
    process.kill(process.pid, 'SIGKILL')
    await new Promise(() => {})
  },
})
await h.tick('child-worker')
process.stdout.write('NOT_KILLED\n')
process.exit(3)
