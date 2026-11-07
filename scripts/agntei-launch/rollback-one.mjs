// Reverse EXACTLY ONE link of the agntei gateway chain with its reviewed rollback file: only the LAST applied link (the
// chain is reversed in reverse order, never out of it), in ONE transaction with bounded lock and statement waits, then
// read back as not applied with no drift. Refuses a link that is not the last applied, a database with drift or a broken
// order, and a rollback file that differs from the bytes the cutover authorized (LC_ROLLBACK_SHA256, when given). The
// rollback files drop what their link created: export those tables first (gateway-cutover.mjs rollback does).
//   LC_OWNER_DB_URL_FILE=<0600 file> node scripts/agntei-launch/rollback-one.mjs <migration name>
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { review, liveCatalog } from './review-chain.mjs'
import { driverSql } from './apply-one.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
/** One top-level begin/commit pair is the file's own transaction: the body runs inside ours instead. */
export function bodyOf(text) {
  const lines = text.split('\n'); const b = lines.filter((l) => /^\s*(begin|start\s+transaction)\s*;\s*$/i.test(l)).length; const c = lines.filter((l) => /^\s*commit\s*;\s*$/i.test(l)).length
  if (b === 0 && c === 0) return text
  if (b === 1 && c === 1) return lines.filter((l) => !/^\s*(begin|start\s+transaction)\s*;\s*$/i.test(l) && !/^\s*commit\s*;\s*$/i.test(l)).join('\n')
  throw new Error('the rollback file has more than one transaction: refusing')
}
export const rollbackSha = (manifest, name) => { const m = manifest.migrations.find((x) => x.name === name); return m?.rollback ? crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, m.rollback))).digest('hex') : null }
export async function rollbackOne(connectionString, name, { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/agntei-launch/gateway-chain.manifest.json'), 'utf8')), log = console.log, expectSha = process.env.LC_ROLLBACK_SHA256 || null } = {}) {
  const m = manifest.migrations.find((x) => x.name === name); if (!m) throw new Error(`${name} is not a migration of the reviewed chain`)
  if (!m.rollback) throw new Error(`${name} has no reviewed rollback file`)
  const text = fs.readFileSync(path.join(ROOT, m.rollback))
  const sha = crypto.createHash('sha256').update(text).digest('hex')
  if (expectSha && sha !== expectSha) throw new Error(`${m.rollback} differs from the authorized bytes: refusing`)
  const before = review(manifest, (await liveCatalog(connectionString)).live)
  if (before.drift.length || before.orderBroken) throw new Error('drift or a broken order in the target database: refusing')
  const applied = before.rows.filter((r) => r.status === 'applied').map((r) => r.name)
  if (applied[applied.length - 1] !== name) throw new Error(`the last applied link is ${applied[applied.length - 1] ?? 'none'}, not ${name}: the chain is reversed in reverse order only`)
  const c = new pg.Client({ connectionString }); await c.connect()
  try {
    await c.query('begin')
    const lockMs = Math.max(1000, Number(process.env.LC_APPLY_LOCK_TIMEOUT_MS ?? 15000) || 15000)
    await c.query(`set local lock_timeout = ${lockMs}`); await c.query(`set local statement_timeout = ${Math.max(60000, lockMs * 8)}`)
    try { await c.query(bodyOf(driverSql(text.toString('utf8'), m.rollback))); await c.query('commit'); log(`rolled back ${name} in one transaction`) } catch (e) { await c.query('rollback'); throw new Error(`${name} rollback did not run (nothing changed): ${e.message}`) }
  } finally { await c.end() }
  const after = review(manifest, (await liveCatalog(connectionString)).live)
  const st = after.rows.find((r) => r.name === name)?.status
  log(`read back: ${name} is ${st}`)
  if (st === 'applied' || after.drift.length || after.orderBroken) throw new Error(`${name} did not read back as reversed (${st}${after.drift.length ? `, drift ${after.drift.length}` : ''})`)
  return { name, status: st, sha }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.env.LC_OWNER_DB_URL_FILE
  if (!f || (fs.statSync(f).mode & 0o077) !== 0) { console.error('Set LC_OWNER_DB_URL_FILE to a 0600 file holding the owner connection string.'); process.exit(2) }
  try { await rollbackOne(fs.readFileSync(f, 'utf8').trim(), process.argv[2]) } catch (e) { console.error(e.message); process.exit(1) }
}
