#!/usr/bin/env node
// "NO SILENT CREDENTIAL DERIVATION" scan (rc-8.5.21-c, owner directive 2026-10-16).
//
//   "Never allow testing or migration tooling to silently derive writable production
//    credentials from local API environment files."
//
// Fails when a test, fixture, migration-test harness, script or package.json script
// entry derives database / service credentials from the ambient environment:
//
//   env-file          loads a dotenv file (node --env-file, dotenv, process.loadEnvFile,
//                     a literal .env / .env.local / .env.production path, `source .env`)
//   db-url-env        READS SUPABASE_DB_URL / DATABASE_URL / POSTGRES_URL* / DIRECT_URL /
//                     SUPABASE_DB_PASSWORD from the environment
//   service-role-env  READS SUPABASE_SERVICE_ROLE_KEY (or any *SERVICE_ROLE* key) from the
//                     environment
//   dburl-file        reads /tmp/.dburl (the operator's postgres-role URL file)
//   runtime-credential-import   (scripts only) imports a runtime module that resolves
//                     DB / service credentials from the ambient environment
//                     (src/lib/postgres/resolve-database-url, src/lib/postgres/client,
//                     src/lib/supabase/client, src/lib/agent/quick-scan/read-client) —
//                     the same silent derivation, one import away
//
// The one sanctioned path to a production database is scripts/lib/prod-db-credentials.mjs
// (LC_RO_<PURPOSE>_DB_URL_FILE per read-only purpose, role-verified; --prod-write=<ref> +
// LC_PROD_WRITE_DB_URL_FILE + an interactive TTY confirmation for writes).
//
// Every pre-existing script that still derives credentials is in the inventory
// (scripts/db/credential-inventory.mjs, rendered in docs/CREDENTIAL-SAFETY.md) with the
// rules it is allowed. That allowlist is FROZEN: every allowlisted (file, rule) pair must
// appear in scripts/db/credential-derivation.frozen.txt, whose sha256 is pinned below.
// The allowlist may shrink (migrate a script, drop its entry); it can never grow without
// editing two frozen artifacts, which this scan and its tests reject.
//
//   node scripts/db/scan-credential-derivation.mjs [--json] [--inventory-md]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { inScope as testScope, listTrackedFiles } from './scan-test-prod-targets.mjs'
import { INVENTORY, CLASSES } from './credential-inventory.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '../..')
export const FROZEN_BASELINE_FILE = 'scripts/db/credential-derivation.frozen.txt'
// sha256 of credential-derivation.frozen.txt at the 2026-10-16 freeze. Never update it to
// admit a new entry: migrate the script to scripts/lib/prod-db-credentials.mjs instead.
export const FROZEN_BASELINE_SHA256 = '3012054e8c21d1c5a3647bd1d8c43276ed9c7abf516067365844d1ce1d723b32'

// A READ: the name is reached through an environment accessor, is not being assigned
// (`= x`, but `==`/`===` are reads) and is not being deleted.
const READ_PREFIX = String.raw`(?<!delete\s)(?:\bprocess\.env\.|\bprocess\.env\[['"]|(?<![.\w])env\.|(?<![.\w])env\[['"]|\bimport\.meta\.env\.|\bDeno\.env\.get\(['"]|\bos\.environ(?:\.get\(|\[)['"]?|\bos\.getenv\(['"]|\$\{?|\benv\(['"])`
// `x = v`, `x ||= v`, `x ??= v`, `x &&= v` are assignments (placeholders), not reads
const NOT_ASSIGNED = String.raw`\b(?!['"]?\]?\s*(?:\|\||\?\?|&&)?=(?!=))`
const envRead = (names) => new RegExp(`${READ_PREFIX}(${names})${NOT_ASSIGNED}`)

export const RULES = Object.freeze([
  {
    id: 'env-file',
    re: /--env-file(?:-if-exists)?\b|\bdotenv\b|\bloadEnvFile\b|(?<![\w.-])\.env(?:\.(?:local|production|prod|development|dev|staging|preview)[\w.-]*)?(?=['"`\s);,]|$)|^\s*(?:source|\.)\s+\S*\.env\b/,
    detail: 'loads a dotenv file (credentials must not be derived from local env files)',
  },
  {
    id: 'db-url-env',
    re: envRead('SUPABASE_DB_URL|SUPABASE_URL_NO_POOL|SUPABASE_POOLER_URL|DATABASE_URL|POSTGRES_URL\\w*|DIRECT_URL|SUPABASE_DB_PASSWORD'),
    detail: 'reads a database URL from the environment',
  },
  {
    id: 'service-role-env',
    re: envRead('\\w*SERVICE_ROLE\\w*'),
    detail: 'reads a service-role key from the environment',
  },
  { id: 'dburl-file', re: /\/tmp\/\.dburl\b/, detail: 'reads /tmp/.dburl (the postgres-role URL file)' },
  {
    id: 'runtime-credential-import',
    scopes: ['script'],
    re: /(?:src\/lib|@\/lib)\/(?:postgres\/(?:resolve-database-url|client)|supabase\/client|agent\/quick-scan\/read-client)(?:\.[cm]?js)?['"]/,
    detail: 'imports a runtime module that derives DB / service credentials from the environment',
  },
])
export const RULE_IDS = Object.freeze(RULES.map((r) => r.id))

// Files whose job is to NAME these patterns (the scanners, the loader's refusal list).
export const SELF = Object.freeze({
  'scripts/db/scan-credential-derivation.mjs': 'this scanner\'s own patterns and documentation',
  'scripts/db/credential-inventory.mjs': 'the inventory describes each script\'s derivation in prose',
  'scripts/db/scan-test-prod-targets.mjs': 'the production-target scanner\'s own patterns',
  'scripts/lib/prod-db-credentials.mjs': 'the loader\'s refusal list (it never reads these)',
  'scripts/db/db-target-guard.mjs': 'sanitizedPgEnv deletes these names from child environments',
  'apps/api/tests/critical/credential-derivation-scan.test.mjs': 'feeds forbidden strings to this scanner to prove it catches them; never connects',
  'apps/api/tests/critical/prod-db-credentials-loader.test.mjs': 'proves the loader refuses these sources; disposable PG17 only',
})

const SCRIPT_FILE = /^(?:scripts\/|apps\/[^/]+\/scripts\/|packages\/[^/]+\/scripts\/|[^/]+\.(?:m?[jt]s|cjs|sh|py)$)/
const CODE = /\.(?:m?[jt]sx?|cjs|sh|bash|py|sql)$/

/** 'script' | 'test' | 'migration-harness' | 'package-json' | false */
export function scopeOf(rel, readSrc) {
  if (/(^|\/)node_modules\//.test(rel) || /^tmp\//.test(rel)) return false
  if (/^(?:apps\/[^/]+\/|packages\/[^/]+\/)?package\.json$/.test(rel)) return 'package-json'
  const t = testScope(rel, readSrc)
  if (t && t !== 'workflow') return t
  if (SCRIPT_FILE.test(rel) && CODE.test(rel)) return 'script'
  return false
}

/** Scan one file's text against every rule. Pure; no allowlist applied. */
export function scanSource(rel, src, scope = 'script') {
  const findings = []
  if (scope === 'package-json') {
    let scripts = {}
    try { scripts = JSON.parse(src).scripts || {} } catch { return [{ file: rel, line: 0, rule: 'unparseable', detail: 'package.json does not parse', scope }] }
    for (const [name, cmd] of Object.entries(scripts)) {
      for (const rule of RULES) if (!rule.scopes && rule.re.test(String(cmd))) findings.push({ file: rel, line: 0, entry: name, rule: rule.id, detail: rule.detail, scope })
    }
    return findings
  }
  const rules = RULES.filter((r) => !r.scopes || r.scopes.includes(scope))
  src.split('\n').forEach((line, i) => {
    for (const rule of rules) if (rule.re.test(line)) findings.push({ file: rel, line: i + 1, rule: rule.id, detail: rule.detail, scope })
  })
  return findings
}

/** key for the frozen baseline: `path rule` or `path#scripts.name rule` */
export function findingKey(f) {
  return `${f.entry ? `${f.file}#scripts.${f.entry}` : f.file} ${f.rule}`
}

/** The allowlisted (file|file#scripts.entry, rule) keys the inventory declares. */
export function allowlistKeys(inventory = INVENTORY) {
  const keys = new Set()
  for (const e of inventory) for (const r of e.allow || []) keys.add(`${e.path} ${r}`)
  return keys
}

export function readFrozenBaseline(root = REPO_ROOT) {
  const raw = fs.readFileSync(path.join(root, FROZEN_BASELINE_FILE), 'utf8')
  const keys = new Set(raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
  return { raw, keys, sha256: crypto.createHash('sha256').update(raw).digest('hex') }
}

/**
 * Integrity of the allowlist itself:
 *  - the frozen baseline's digest equals the pinned digest
 *  - every allowlisted key is in the baseline (the allowlist can only shrink)
 *  - every inventory entry has a known class and a note
 */
export function checkAllowlistIntegrity({ inventory = INVENTORY, baseline, pinned = FROZEN_BASELINE_SHA256 } = {}) {
  const problems = []
  if (baseline.sha256 !== pinned) problems.push(`${FROZEN_BASELINE_FILE} was edited (sha256 ${baseline.sha256.slice(0, 16)}… ≠ pinned ${String(pinned).slice(0, 16)}…): the allowlist is frozen — migrate the script to scripts/lib/prod-db-credentials.mjs instead`)
  for (const k of allowlistKeys(inventory)) if (!baseline.keys.has(k)) problems.push(`new allowlist entry "${k}" is not in the frozen baseline: new scripts must use scripts/lib/prod-db-credentials.mjs`)
  const seen = new Set()
  for (const e of inventory) {
    if (seen.has(e.path)) problems.push(`inventory lists ${e.path} twice`)
    seen.add(e.path)
    if (!CLASSES[e.cls]) problems.push(`inventory ${e.path}: unknown class ${e.cls}`)
    if (!e.note) problems.push(`inventory ${e.path}: no note`)
    for (const r of e.allow || []) if (!RULE_IDS.includes(r)) problems.push(`inventory ${e.path}: unknown rule ${r}`)
  }
  return problems
}

/** Apply the allowlist to raw findings. */
export function applyAllowlist(findings, inventory = INVENTORY) {
  const keys = allowlistKeys(inventory)
  return findings.filter((f) => !SELF[f.file] && !keys.has(findingKey(f)))
}

export function scanRepo(root = REPO_ROOT, { inventory = INVENTORY, pinned = FROZEN_BASELINE_SHA256 } = {}) {
  const raw = []
  let scanned = 0
  for (const rel of listTrackedFiles(root)) {
    let src = null
    const full = path.join(root, rel)
    const read = () => (src ??= fs.readFileSync(full, 'utf8'))
    let scope
    try {
      if (!fs.existsSync(full)) continue
      scope = scopeOf(rel, read)
    } catch { continue }
    if (!scope) continue
    scanned++
    raw.push(...scanSource(rel, read(), scope))
  }
  const findings = applyAllowlist(raw, inventory)
  const integrity = checkAllowlistIntegrity({ inventory, baseline: readFrozenBaseline(root), pinned })
  const hit = new Set(raw.map(findingKey))
  const stale = [...allowlistKeys(inventory)].filter((k) => !hit.has(k))
  return { scanned, raw, findings, integrity, stale }
}

export function inventoryMarkdown(inventory = INVENTORY) {
  const order = Object.keys(CLASSES)
  const rows = [...inventory].sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || a.path.localeCompare(b.path))
  const out = ['| # | Script | Class | Status | Allowlisted rules | Note |', '|---|---|---|---|---|---|']
  rows.forEach((e, i) => out.push(`| ${i + 1} | \`${e.path}\` | ${CLASSES[e.cls]} | ${e.status} | ${(e.allow || []).join(', ') || '—'} | ${e.note.replace(/\|/g, '\\|')} |`))
  return out.join('\n')
}

export function inventoryCounts(inventory = INVENTORY) {
  const byClass = {}
  const byStatus = {}
  for (const e of inventory) {
    byClass[e.cls] = (byClass[e.cls] || 0) + 1
    byStatus[e.status] = (byStatus[e.status] || 0) + 1
  }
  return { total: inventory.length, byClass, byStatus }
}

function main(argv) {
  if (argv.includes('--inventory-md')) {
    console.log(inventoryMarkdown())
    return 0
  }
  const r = scanRepo()
  if (argv.includes('--json')) console.log(JSON.stringify({ scanned: r.scanned, findings: r.findings, integrity: r.integrity, stale: r.stale }, null, 2))
  else {
    for (const f of r.findings) console.log(`${f.file}${f.entry ? `#scripts.${f.entry}` : `:${f.line}`}: [${f.rule}] ${f.detail} (${f.scope})`)
    for (const p of r.integrity) console.log(`allowlist: ${p}`)
    if (r.stale.length) console.log(`note: ${r.stale.length} allowlisted pair(s) no longer occur — drop them from scripts/db/credential-inventory.mjs:\n  ${r.stale.join('\n  ')}`)
    console.log(`scan-credential-derivation: ${r.scanned} file(s) in scope, ${r.findings.length} finding(s), ${r.integrity.length} allowlist problem(s)`)
  }
  return r.findings.length || r.integrity.length ? 1 : 0
}

// realpath: a symlinked checkout or tmp dir (/var → /private/var) must still count as "run directly"
const isMain = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) {
  process.exitCode = main(process.argv.slice(2))
}
