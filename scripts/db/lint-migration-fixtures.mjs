#!/usr/bin/env node
// MIGRATION FIXTURE LINTER (rc-8.5.15.1, after the 2026-10-14 incident).
//
// On 2026-10-14 a "chain pretest" that was supposed to end in ROLLBACK
// `\ir`-included a rollback file that ends in its own `commit;`. The inner
// COMMIT committed the outer transaction and a PROPOSED migration became
// applied in production. This linter makes that class of script impossible
// to land in the repository.
//
// TEST FIXTURES (pretest / posttest / verify / rollback-only / supabase/tests):
//   - no COMMIT, END, ABORT, SAVEPOINT, RELEASE, ROLLBACK TO, PREPARE/COMMIT/
//     ROLLBACK PREPARED, START TRANSACTION beyond the first BEGIN;
//   - at most ONE BEGIN, and it must be the first statement;
//   - at most ONE ROLLBACK, only as the final statement, only after that BEGIN;
//   - no file inclusion or reconnection: \i \ir \include \include_relative
//     \connect \c, no \gexec (dynamic statements), no \! (shell), no
//     \set AUTOCOMMIT, no \copy, no pg_read_file / lo_import / COPY ... FROM;
//   - no SET / RESET SESSION AUTHORIZATION;
//   - no CALL (a procedure may COMMIT), no dblink (a second connection commits
//     on its own), and no COMMIT / ROLLBACK inside any DO / function body or
//     EXECUTEd string. Any dollar-quoted text is treated as code (conservative:
//     a $q$ literal that says "commit;" is reported too).
// APPLY + ROLLBACK FILES (*.sql that are not fixtures) may carry their own
//   BEGIN/COMMIT: they are applied, never included. A fixture can never include
//   one, because a fixture can never include anything.
//
// Fixture = file name matches *pretest*.sql / *posttest*.sql / *_verify.sql /
// supabase/tests/*.sql, OR its leading comment block declares it
// ("-- lc-fixture: pretest|posttest|verify|rollback-only", "-- PRETEST ...",
// "-- Rollback-only pretest ...", "-- Rollback-only: ...").
//
// Usage:
//   node scripts/db/lint-migration-fixtures.mjs            # lint the repo
//   node scripts/db/lint-migration-fixtures.mjs a.sql b.sql # lint given files
//   --json  machine-readable output
// Exit 0 = clean, 1 = violations, 2 = usage / IO error.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lexPsqlScript, stripBody, leadingWords } from './sql-fixture-lexer.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '../..')

/** Directories whose *.sql files are considered. */
export const FIXTURE_SCAN_DIRS = ['supabase/migrations', 'supabase/tests', 'supabase/rollbacks', 'apps/api/supabase/migrations', 'apps/api/tests', 'scripts/db/fixtures']

const APPLY_CLASS_NAME = /(_rollback\.sql|_ROLLBACK\.sql|\.rollback\.sql)$/
const FIXTURE_NAME = /(pretest|posttest)[^/]*\.sql$|_verify\.sql$/i
// Case-sensitive on purpose: "-- Pretest: <file>" in a migration header POINTS AT a fixture; it is not one.
const DECLARATION = /^\s*--\s*(?:lc-fixture:\s*(pretest|posttest|verify|rollback-only)\b|(PRETEST)\s+(?:for|of)\b|(Rollback-only)(?:\s+pretest\b|:))/

/**
 * Classify a file: 'fixture' (with a kind) or 'apply'.
 * @param {string} relPath repo-relative path
 * @param {string} src file contents
 */
export function classifyFile(relPath, src) {
  const rel = relPath.split(path.sep).join('/')
  const header = leadingCommentBlock(src)
  const explicit = header.map((l) => /^\s*--\s*lc-fixture:\s*([a-z-]+)/i.exec(l)).find(Boolean)
  if (explicit) {
    const kind = explicit[1].toLowerCase()
    if (kind === 'apply') return { cls: 'apply', kind: 'apply', reason: 'declared lc-fixture: apply' }
    return { cls: 'fixture', kind, reason: 'declared lc-fixture' }
  }
  if (FIXTURE_NAME.test(rel)) {
    const kind = /posttest/i.test(rel) ? 'posttest' : /pretest/i.test(rel) ? 'pretest' : 'verify'
    return { cls: 'fixture', kind, reason: 'file name' }
  }
  if (/^supabase\/tests\/.+\.sql$/.test(rel) || /(^|\/)tests\/.+\.sql$/.test(rel)) {
    return { cls: 'fixture', kind: 'test', reason: 'test directory' }
  }
  if (APPLY_CLASS_NAME.test(rel)) return { cls: 'apply', kind: 'rollback', reason: 'rollback file name' }
  const declared = header.map((l) => DECLARATION.exec(l)).find(Boolean)
  if (declared) {
    const kind = (declared[1] || (declared[2] ? 'pretest' : 'rollback-only')).toLowerCase()
    return { cls: 'fixture', kind, reason: 'declared in header' }
  }
  return { cls: 'apply', kind: 'apply', reason: 'migration' }
}

function leadingCommentBlock(src) {
  const lines = src.split('\n')
  const out = []
  for (const l of lines) {
    if (/^\s*$/.test(l)) { out.push(l); continue }
    if (/^\s*--/.test(l)) { out.push(l); continue }
    break
  }
  return out
}

const INCLUDE_META = new Set(['i', 'ir', 'include', 'include_relative', 'connect', 'c'])
const FORBIDDEN_META = {
  gexec: 'executes query results as statements (dynamic SQL can COMMIT)',
  '!': 'runs a shell command',
  copy: 'reads or writes a client file',
  o: 'redirects output to a file or pipe',
  out: 'redirects output to a file or pipe',
  w: 'writes the query buffer to a file',
  write: 'writes the query buffer to a file',
  e: 'opens an editor',
  edit: 'opens an editor',
}

/**
 * Lint one file's contents.
 * @param {string} relPath
 * @param {string} src
 * @returns {{ file: string, cls: string, kind: string, violations: Array<{line:number, rule:string, detail:string}> }}
 */
export function lintFixtureSource(relPath, src) {
  const { cls, kind } = classifyFile(relPath, src)
  const violations = []
  const v = (line, rule, detail) => violations.push({ line, rule, detail })
  if (cls !== 'fixture') return { file: relPath, cls, kind, violations }

  const items = lexPsqlScript(src)
  const statements = items.filter((x) => x.kind === 'statement')
  let beginSeen = 0
  let rollbackSeen = 0
  statements.forEach((st, idx) => {
    const w = leadingWords(st.text)
    const [a, b, c] = w
    const isFirst = idx === 0
    const isLast = idx === statements.length - 1
    if (a === 'BEGIN' || (a === 'START' && b === 'TRANSACTION')) {
      beginSeen++
      if (beginSeen > 1) v(st.line, 'begin-beyond-first', 'a second BEGIN / START TRANSACTION')
      else if (!isFirst) v(st.line, 'begin-not-first', 'BEGIN must be the first statement of a fixture (anything before it runs outside the transaction)')
      if (/\bATOMIC\b/.test(w.join(' '))) v(st.line, 'begin-atomic', 'BEGIN ATOMIC is not supported in fixtures')
      return
    }
    if (a === 'COMMIT' || a === 'END' || a === 'ABORT') {
      if (b === 'PREPARED') v(st.line, 'two-phase', `${a} PREPARED`)
      else v(st.line, 'commit', `${a} ends the transaction: a fixture must never commit`)
      return
    }
    if (a === 'ROLLBACK') {
      if (b === 'TO' || (b === 'WORK' && c === 'TO') || (b === 'TRANSACTION' && c === 'TO')) { v(st.line, 'savepoint', 'ROLLBACK TO SAVEPOINT'); return }
      if (b === 'PREPARED') { v(st.line, 'two-phase', 'ROLLBACK PREPARED'); return }
      if (/\bAND\s+CHAIN\b/i.test(st.text) && !/\bAND\s+NO\s+CHAIN\b/i.test(st.text)) { v(st.line, 'rollback-chain', 'ROLLBACK AND CHAIN opens a new transaction'); return }
      rollbackSeen++
      if (rollbackSeen > 1) v(st.line, 'rollback-not-final', 'more than one ROLLBACK')
      else if (!isLast) v(st.line, 'rollback-not-final', 'ROLLBACK is only allowed as the final statement')
      else if (beginSeen === 0) v(st.line, 'rollback-without-begin', 'a final ROLLBACK without a leading BEGIN rolls back nothing')
      return
    }
    if (a === 'SAVEPOINT' || a === 'RELEASE') { v(st.line, 'savepoint', `${a}`); return }
    if (a === 'PREPARE' && b === 'TRANSACTION') { v(st.line, 'two-phase', 'PREPARE TRANSACTION'); return }
    if ((a === 'SET' || a === 'RESET') && /\bSESSION\s+AUTHORIZATION\b/i.test(st.text)) { v(st.line, 'session-authorization', `${a} SESSION AUTHORIZATION`); return }
    if (a === 'SET' && b === 'TRANSACTION' && /\bSNAPSHOT\b/i.test(st.text)) { v(st.line, 'snapshot', 'SET TRANSACTION SNAPSHOT'); return }
    if (a === 'CALL') { v(st.line, 'call', 'CALL: a procedure may COMMIT'); return }
    if (a === 'COPY' && /\bFROM\b/i.test(st.text) && !/\bFROM\s+STDIN\b/i.test(st.text)) v(st.line, 'file-reference', 'COPY ... FROM a file / program')
    if (a === 'COPY' && /\bTO\s+(?:PROGRAM|'')/i.test(st.text)) v(st.line, 'file-reference', 'COPY ... TO a file / program')
    scanCode(st.text, st.line, v)
    for (const body of st.bodies) scanBody(body, st.line, v)
  })
  for (const m of items.filter((x) => x.kind === 'meta')) {
    const cmd = m.command
    if (INCLUDE_META.has(cmd)) {
      v(m.line, cmd === 'connect' || cmd === 'c' ? 'connect' : 'include', `\\${cmd} ${m.args}`.trim() + (cmd === 'connect' || cmd === 'c' ? ' — a fixture never reconnects' : ' — a fixture never references another file'))
      continue
    }
    if (FORBIDDEN_META[cmd]) { v(m.line, 'meta-command', `\\${cmd}: ${FORBIDDEN_META[cmd]}`); continue }
    if (cmd === 'set' && /^AUTOCOMMIT\b/i.test(m.args)) v(m.line, 'autocommit', '\\set AUTOCOMMIT')
  }
  return { file: relPath, cls, kind, violations }
}

function scanCode(code, line, v) {
  if (/\bdblink(?:_exec|_connect|_send_query)?\s*\(/i.test(code)) v(line, 'dblink', 'dblink opens a second connection that commits independently')
  if (/\bpg_background_launch\s*\(/i.test(code)) v(line, 'dblink', 'pg_background runs in its own transaction')
  if (/\b(pg_read_file|pg_read_binary_file|lo_import|pg_file_write)\s*\(/i.test(code)) v(line, 'file-reference', 'server-side file access')
}

function scanBody(body, line, v, depth = 0) {
  if (depth > 8) return
  // EXECUTE of a quoted transaction-control statement (the literal is stripped below)
  if (/\bexecute\s+(?:format\s*\(\s*)?E?'\s*(commit|rollback|begin|start\s+transaction|savepoint|release|end|abort)\b/i.test(body)) {
    v(line, 'body-transaction-control', 'EXECUTE of a transaction-control statement')
  }
  const { code: raw, nested } = stripBody(body)
  const code = raw.replace(/\bon\s+commit\s+(drop|delete\s+rows|preserve\s+rows)\b/gi, ' ')
  // PL/pgSQL transaction control inside a DO / procedure body
  if (/(^|[\s;])(commit|rollback)\b(?!\s+to\b)/i.test(code)) {
    const word = /(^|[\s;])(commit|rollback)\b/i.exec(code)[2].toUpperCase()
    v(line, 'body-transaction-control', `${word} inside a dollar-quoted body`)
  }
  if (/\bexecute\b[^;]*\b(commit|rollback|begin|savepoint|release)\b/i.test(code)) v(line, 'body-transaction-control', 'EXECUTE of a transaction-control statement')
  scanCode(code, line, v)
  for (const inner of nested) scanBody(inner, line, v, depth + 1)
}

/** Every *.sql file in the scan dirs (tracked or not), repo-relative. */
export function listCandidateFiles(root = REPO_ROOT) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel) } else if (e.name.endsWith('.sql')) out.push(rel)
    }
  }
  for (const d of FIXTURE_SCAN_DIRS) walk(d)
  return out.sort()
}

export function lintFiles(files, root = REPO_ROOT) {
  return files.map((rel) => {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel)
    const display = path.isAbsolute(rel) ? path.relative(root, rel) || rel : rel
    return lintFixtureSource(display, fs.readFileSync(abs, 'utf8'))
  })
}

function main(argv) {
  const json = argv.includes('--json')
  const files = argv.filter((a) => !a.startsWith('--'))
  let results
  try {
    results = lintFiles(files.length ? files : listCandidateFiles())
  } catch (e) {
    console.error(`lint-migration-fixtures: ${e.message}`)
    return 2
  }
  const fixtures = results.filter((r) => r.cls === 'fixture')
  const bad = fixtures.filter((r) => r.violations.length)
  if (json) {
    console.log(JSON.stringify({ fixtures: fixtures.length, violations: bad }, null, 2))
  } else {
    for (const r of bad) for (const x of r.violations) console.log(`${r.file}:${x.line}: [${x.rule}] ${x.detail}`)
    console.log(`lint-migration-fixtures: ${fixtures.length} fixture file(s) checked, ${bad.length} with violations`)
  }
  return bad.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
