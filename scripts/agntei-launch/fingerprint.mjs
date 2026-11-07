// The schema fingerprint the migration-test runner uses (scripts/db/run-migration-test.mjs), for the cutover's recovery
// checks: writes one line per catalog object to <out> (0600) and prints the line count and a digest. Read-only.
//   LC_DB_URL_FILE=<0600 file> node scripts/agntei-launch/fingerprint.mjs <out file>
//   node scripts/agntei-launch/fingerprint.mjs --diff <before file> <after file>   lines only in one of them (JSON)
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fingerprint } from '../db/run-migration-test.mjs'
const norm = (l) => (l.startsWith('con\t') ? l.replace(/[()]/g, '').replace(/\s+/g, ' ') : l)
if (process.argv[2] === '--diff') {
  const a = new Set(fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean)); const b = new Set(fs.readFileSync(process.argv[4], 'utf8').split('\n').filter(Boolean))
  console.log(JSON.stringify({ onlyBefore: [...a].filter((l) => !b.has(l)), onlyAfter: [...b].filter((l) => !a.has(l)) }))
} else {
  const f = process.env.LC_DB_URL_FILE; if (!f) { console.error('Set LC_DB_URL_FILE'); process.exit(2) }
  const r = await fingerprint(fs.readFileSync(f, 'utf8').trim()); const lines = (r.lines ?? r).map(norm).sort()
  fs.writeFileSync(process.argv[2], lines.join('\n') + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ lines: lines.length, digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16) }))
}
