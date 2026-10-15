#!/usr/bin/env node
// LOCAL DISPOSABLE POSTGRES proof for the 8.5.16 PROPOSED migrations.
// Owner testing boundary (2026-10-15): migration / rollback / pretest SQL is NEVER run
// against production. This script refuses any DATABASE_URL-style target: it initdb's a
// FRESH data dir under the OS temp dir, starts a private server on a random local port,
// runs the files, stops the server and deletes the data dir.
//
//   PG_BIN=/path/to/pg17/bin node apps/api/scripts/proof/local-pg-migration-proof.mjs
//   (psql from PSQL or PATH)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PG_BIN = process.env.PG_BIN
if (!PG_BIN || !fs.existsSync(path.join(PG_BIN, 'initdb'))) { console.error('set PG_BIN to a local postgres bin dir'); process.exit(2) }
const PSQL = process.env.PSQL || 'psql'
const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const MIG = path.join(REPO, 'supabase/migrations')
const FIX = path.join(REPO, 'supabase/tests/local-proof')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-local-pg-'))
const port = String(54000 + Math.floor(Math.random() * 900))
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const db = (file, { single = true } = {}) => {
  const r = run(PSQL, ['-X', '-q', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', ...(single ? ['--single-transaction'] : []), '-f', file])
  const notices = r.out.split('\n').filter((l) => /NOTICE|ERROR/.test(l)).map((l) => l.replace(/^.*?(NOTICE|ERROR):\s*/, '$1: '))
  return { ok: r.ok, notices }
}
const steps = []
let started = false
try {
  const init = run(path.join(PG_BIN, 'initdb'), ['-D', dir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale'])
  if (!init.ok) throw new Error(`initdb failed: ${init.out.slice(-400)}`)
  const start = run(path.join(PG_BIN, 'pg_ctl'), ['-D', dir, '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-w', '-l', path.join(dir, 'server.log'), 'start'])
  if (!start.ok) throw new Error(`pg_ctl start failed: ${start.out.slice(-400)}`)
  started = true
  const plan = [
    ['ai_message_templates: apply', path.join(MIG, 'PROPOSED_20261015120000_ai_message_templates.sql')],
    ['ai_message_templates: re-apply (idempotent create-if-not-exists)', path.join(MIG, 'PROPOSED_20261015120000_ai_message_templates.sql')],
    ['ai_message_templates: assertions', path.join(FIX, 'ai_message_templates_assertions.sql')],
    ['ai_message_templates: rollback', path.join(MIG, 'PROPOSED_20261015120000_ai_message_templates_rollback.sql')],
    ['ai_message_templates: after rollback', path.join(FIX, 'ai_message_templates_after_rollback.sql')],
    ['ai_message_templates: re-apply after rollback', path.join(MIG, 'PROPOSED_20261015120000_ai_message_templates.sql')],
    ['send_queue stub', path.join(FIX, 'send_queue_stub.sql')],
    ['block_repeat_asking_price mirror: apply', path.join(MIG, 'PROPOSED_20261014120000_block_repeat_asking_price_mirror.sql')],
    ['block_repeat_asking_price mirror: pretest (definition equals live)', path.join(MIG, 'PROPOSED_20261014120000_block_repeat_asking_price_mirror_pretest.sql')],
    ['block_repeat_asking_price mirror: behaviour', path.join(FIX, 'block_repeat_asking_price_assertions.sql')],
  ]
  for (const [name, file] of plan) {
    const r = db(file)
    steps.push({ name, ok: r.ok, notices: r.notices })
    if (!r.ok) break
  }
} catch (e) {
  steps.push({ name: 'setup', ok: false, notices: [String(e.message)] })
} finally {
  if (started) run(path.join(PG_BIN, 'pg_ctl'), ['-D', dir, '-m', 'fast', '-w', 'stop'])
  fs.rmSync(dir, { recursive: true, force: true })
}
const version = run(path.join(PG_BIN, 'postgres'), ['--version']).out.trim()
console.log(JSON.stringify({ server: version, data_dir_removed: !fs.existsSync(dir), steps }, null, 2))
process.exit(steps.length && steps.every((s) => s.ok) ? 0 : 1)
