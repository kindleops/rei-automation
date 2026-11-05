// Apply EXACTLY ONE reviewed migration of the agntei gateway chain, the way docs/ACTION-MCP.md §7 prescribes: its pretest
// first inside a READ ONLY transaction (any write is refused by PostgreSQL), then the migration itself in ONE transaction
// (all or nothing). Refuses a file whose bytes differ from the reviewed manifest, a name that is not in the chain, and a
// migration whose predecessors are not applied. The owner connection string comes from a 0600 file, never printed.
//   LC_OWNER_DB_URL_FILE=<0600 file> node scripts/agntei-launch/apply-one.mjs <migration name>
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { review, liveCatalog } from './review-chain.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
/** The SQL a driver can run: the documented files carry only psql's "\set ON_ERROR_STOP on" (the driver already stops at
 * the first error); any OTHER psql meta-command is refused rather than silently skipped. */
export function driverSql(text, file) {
  const meta = text.split('\n').filter((l) => /^\s*\\/.test(l))
  const other = meta.filter((l) => !/^\s*\\set\s+ON_ERROR_STOP\s+on\s*$/i.test(l))
  if (other.length) throw new Error(`${file} uses psql meta-commands (${other[0].trim()}): run it with psql, as docs/ACTION-MCP.md describes`)
  return text.split('\n').filter((l) => !/^\s*\\set\s+ON_ERROR_STOP\s+on\s*$/i.test(l)).join('\n')
}
export async function applyOne(connectionString, name, { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/agntei-launch/gateway-chain.manifest.json'), 'utf8')), log = console.log } = {}) {
  const m = manifest.migrations.find((x) => x.name === name); if (!m) throw new Error(`${name} is not a migration of the reviewed chain`)
  const file = path.join(ROOT, m.file); const sql = fs.readFileSync(file)
  if (crypto.createHash('sha256').update(sql).digest('hex') !== m.sha256) throw new Error(`${m.file} differs from the reviewed manifest: refusing`)
  const before = review(manifest, (await liveCatalog(connectionString)).live)
  if (before.drift.length || before.orderBroken) throw new Error('drift or a broken order in the target database: refusing')
  if (before.next !== name) throw new Error(`the next migration is ${before.next ?? 'none (all applied)'}, not ${name}`)
  const c = new pg.Client({ connectionString }); await c.connect()
  try {
    if (m.pretest) {
      await c.query('begin transaction read only')
      try { await c.query(driverSql(fs.readFileSync(path.join(ROOT, m.pretest), 'utf8'), m.pretest)); log(`pretest ${path.basename(m.pretest)}: passed (read-only)`) } finally { await c.query('rollback') }
    }
    await c.query('begin')
    try { await c.query(driverSql(sql.toString('utf8'), m.file)); await c.query('commit'); log(`applied ${name} in one transaction`) } catch (e) { await c.query('rollback'); throw new Error(`${name} rolled back: ${e.message}`) }
  } finally { await c.end() }
  const after = review(manifest, (await liveCatalog(connectionString)).live)
  const st = after.rows.find((r) => r.name === name)?.status
  log(`read back: ${name} is ${st}`)
  if (st !== 'applied') throw new Error(`${name} did not read back as applied (${st})`)
  return { name, status: st, next: after.next }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.env.LC_OWNER_DB_URL_FILE
  if (!f || (fs.statSync(f).mode & 0o077) !== 0) { console.error('Set LC_OWNER_DB_URL_FILE to a 0600 file holding the owner connection string.'); process.exit(2) }
  try { await applyOne(fs.readFileSync(f, 'utf8').trim(), process.argv[2]) } catch (e) { console.error(e.message); process.exit(1) }
}
