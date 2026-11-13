// A stand-in for production's web workers while a hot-table migration runs on STAGING: two connections loop over the
// write shapes production's code issues on send_queue, inbox_thread_state, seller_offers, acquisition_opportunities and
// campaigns (apps/api/src at release/cloudflare-production c5a7104f: automation-actions.js, campaign-convert-to-live.js,
// thread-sender.js, reconcile-inbox-thread-state.js, lead-visibility-service.js, campaign-progress.js). Every statement
// is timed; errors are counted by SQLSTATE and never stop the loop. Stops on SIGTERM and writes JSON stats.
//   node workload.mjs --url <staging url> --stats <file>
import fs from 'node:fs'
import pg from 'pg'

const argv = process.argv.slice(2); const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const url = opt('url'); const statsFile = opt('stats')
if (!url || !statsFile) { console.error('--url and --stats are required'); process.exit(2) }
if (!/127\.0\.0\.1|localhost|::1|host=\//.test(url)) { console.error('loopback only'); process.exit(2) }

const stats = { ops: 0, errors: 0, max_stmt_ms: 0, by_error: {}, by_statement: {}, gated: {}, started_at: new Date().toISOString() }
let stop = false
process.on('SIGTERM', () => { stop = true }); process.on('SIGINT', () => { stop = true })
const tag = `wl-${process.pid}-${Date.now()}`
const STATEMENTS = [
  { name: 'send_queue.insert', sql: `insert into public.send_queue (queue_key, thread_key, to_phone_number, from_phone_number, message_body, queue_status, scheduled_for, created_at, updated_at) values ('wl-' || gen_random_uuid()::text, $1, $2, '+18175550100', 'staging workload row', 'queued', now() + interval '1 day', now(), now()) returning id`, params: () => [`+1817555${String(Math.floor(Math.random() * 9000) + 1000)}`, `+1817555${String(Math.floor(Math.random() * 9000) + 1000)}`] },
  { name: 'send_queue.cancel (automation-actions)', sql: `update public.send_queue set queue_status = 'cancelled', safety_status = 'blocked', guard_status = 'blocked', guard_reason = $1, failed_reason = $1, updated_at = now() where id in (select id from public.send_queue where message_body = 'staging workload row' and queue_status = 'queued' order by created_at desc limit 5)`, params: () => [tag] },
  { name: 'inbox_thread_state.upsert (automation-actions)', sql: `insert into public.inbox_thread_state (thread_key, updated_at) values ($1, now()) on conflict (thread_key) do update set updated_at = now()`, params: () => [`+1817555${String(Math.floor(Math.random() * 9000) + 1000)}`] },
  { name: 'inbox_thread_state.update (thread-sender)', sql: `update public.inbox_thread_state set our_number = '+18175550100', updated_at = now() where thread_key = (select thread_key from public.inbox_thread_state order by updated_at desc limit 1)`, params: () => [] },
  // lead-visibility-gate.js names archived_* only when the columns exist (PROPOSED_20261005120000_lead_visibility, not applied in production): gated off on a schema without them
  { name: 'acquisition_opportunities.archive (lead-visibility)', requires: ['public.acquisition_opportunities.archived_by'], sql: `update public.acquisition_opportunities set archived_at = now(), archived_by = 'staging-workload', archive_reason = 'workload', archive_action_id = null where id = (select id from public.acquisition_opportunities where archived_at is null limit 1)`, params: () => [] },
  { name: 'acquisition_opportunities.unarchive (lead-visibility)', requires: ['public.acquisition_opportunities.archived_by'], sql: `update public.acquisition_opportunities set archived_at = null, archived_by = null, archive_reason = null, archive_action_id = null where id = (select id from public.acquisition_opportunities where archived_by = 'staging-workload' limit 1)`, params: () => [] },
  { name: 'campaigns.progress (campaign-progress)', sql: `update public.campaigns set sent_count = coalesce(sent_count, 0) + 1, delivered_count = coalesce(delivered_count, 0), failed_count = coalesce(failed_count, 0), progress_synced_at = now(), updated_at = now() where id = (select id from public.campaigns limit 1)`, params: () => [] },
  { name: 'seller_offers.touch', sql: `update public.seller_offers set updated_at = now() where id = (select id from public.seller_offers limit 1)`, params: () => [] },
]
async function worker(n) {
  const c = new pg.Client({ connectionString: url, application_name: 'staging-workload', statement_timeout: 30_000 }); await c.connect()
  const live = []
  for (const s of STATEMENTS) {
    const missing = []
    for (const col of s.requires ?? []) { const [sch, tbl, name] = col.split('.'); if (!(await c.query('select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3', [sch, tbl, name])).rowCount) missing.push(col) }
    if (missing.length) { stats.gated[s.name] = missing } else live.push(s)
  }
  try {
    while (!stop) {
      for (const s of live) {
        if (stop) break
        const t0 = Date.now()
        try { await c.query(s.sql, s.params()); stats.ops++ } catch (e) { stats.errors++; const k = `${s.name} ${e.code ?? '?'}`; stats.by_error[k] = (stats.by_error[k] ?? 0) + 1 }
        const took = Date.now() - t0; stats.max_stmt_ms = Math.max(stats.max_stmt_ms, took)
        const b = (stats.by_statement[s.name] ??= { n: 0, max_ms: 0, total_ms: 0 }); b.n++; b.max_ms = Math.max(b.max_ms, took); b.total_ms += took
      }
      await new Promise((r) => setTimeout(r, 20 + n * 10))
    }
  } finally { await c.end().catch(() => {}) }
}
await Promise.all([worker(0), worker(1)])
stats.finished_at = new Date().toISOString()
fs.writeFileSync(statsFile, `${JSON.stringify(stats, null, 2)}\n`, { mode: 0o600 })
