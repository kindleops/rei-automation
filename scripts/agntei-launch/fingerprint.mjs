// The schema fingerprint the migration-test runner uses (its FINGERPRINT_SQL, scripts/db/run-migration-test.mjs), for
// the cutover's recovery checks: writes one line per catalog object to <out> (0600) and prints the line count and a
// digest. It reads the catalog only, in a READ ONLY transaction with a statement timeout, on its own connection: the
// runner's sql() path refuses production by design (db-target-guard: migration, pretest and rollback SQL never run
// there) and stays that way; this file runs no migration or test SQL, only the one catalog query.
//   LC_DB_URL_FILE=<0600 file> node scripts/agntei-launch/fingerprint.mjs <out file>
//   node scripts/agntei-launch/fingerprint.mjs --diff <before file> <after file>   lines only in one of them (JSON)
import fs from 'node:fs'
import crypto from 'node:crypto'
import pg from 'pg'
import { FINGERPRINT_SQL } from '../db/run-migration-test.mjs'
const norm = (l) => (l.startsWith('con\t') ? l.replace(/[()]/g, '').replace(/\s+/g, ' ') : l)
export async function catalogFingerprint(connectionString, { timeoutMs = 120_000 } = {}) {
  const c = new pg.Client({ connectionString, application_name: 'agntei-fingerprint (read-only)' })
  await c.connect()
  try {
    await c.query('begin transaction read only')
    await c.query(`set local statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`)
    await c.query("set local timezone = 'UTC'")
    const ro = (await c.query('show transaction_read_only')).rows[0].transaction_read_only
    if (ro !== 'on') throw new Error('the fingerprint transaction is not read-only')
    const r = await c.query({ text: FINGERPRINT_SQL, rowMode: 'array' })
    // one line per object; a value's own line breaks are escaped so each object is exactly one line
    const lines = r.rows.map((row) => row.map((v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')).join('\t')).map(norm).sort()
    return { lines, digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16) }
  } finally { await c.query('rollback').catch(() => {}); await c.end().catch(() => {}) }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--diff') {
    const a = new Set(fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean)); const b = new Set(fs.readFileSync(process.argv[4], 'utf8').split('\n').filter(Boolean))
    console.log(JSON.stringify({ onlyBefore: [...a].filter((l) => !b.has(l)), onlyAfter: [...b].filter((l) => !a.has(l)) }))
  } else {
    const f = process.env.LC_DB_URL_FILE; if (!f) { console.error('Set LC_DB_URL_FILE'); process.exit(2) }
    const out = process.argv[2]; if (!out) { console.error('usage: fingerprint.mjs <out file>'); process.exit(2) }
    try {
      const r = await catalogFingerprint(fs.readFileSync(f, 'utf8').trim())
      if (!r.lines.length) throw new Error('the catalog query returned no objects')
      fs.writeFileSync(out, r.lines.join('\n') + '\n', { mode: 0o600 })
      const back = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean)
      if (crypto.createHash('sha256').update(back.join('\n')).digest('hex').slice(0, 16) !== r.digest) throw new Error('the written fingerprint does not read back identically')
      console.log(JSON.stringify({ lines: r.lines.length, digest: r.digest }))
    } catch (e) { console.error(`fingerprint not taken: ${String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`); process.exit(1) }
  }
}
