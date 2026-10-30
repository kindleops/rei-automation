#!/usr/bin/env node
// PRODUCTION-COPY REHEARSAL — one restartable tool, read-only by default, for an ISOLATED LOCAL copy of a backup.
// Runbook: docs/PRODUCTION-COPY-REHEARSAL.md. Nothing here can reach production: every target must be a loopback /
// unix-socket PostgreSQL (never a Supabase-like or other hosted host, whatever any environment variable says), every
// rehearsal database must be named lc_prodcopy_<tag>, and every subcommand runs the guard first.
//
//   guard            refuse unless the admin URL is loopback / unix socket, not hosted, the server carries no Supabase
//                    platform role, and the database name starts with lc_prodcopy_
//   validate-backup  --file: sha256, format, pg_restore --list TOC counts (or a header + statement scan for plain SQL);
//                    never row data
//   restore          --file: create lc_prodcopy_<tag>, restore with --no-owner --no-privileges (then, by default, the
//                    archive's ACL entries alone, so privilege self-checks can be evaluated), time it, count key tables
//   prereqs          the read-only §1 query of docs/AGENT-MESSAGES-MIGRATION-PLAN.md (+ the reader 1.0 prerequisite of
//                    #30 and the switches); any false stops every later step
//   migrate          the five links #29 #30 #31 A B: SHA-256 against docs/AGENT-TEXTS-DIFF-AUDIT.md, then pretest → apply →
//                    posttest each (from scripts/db/migration-tests.manifest.mjs, executed with run-migration-test.mjs
//                    helpers), CHECK re-validation cost, rollback all in reverse with rollback posttests, fingerprint
//                    equals pre-apply, re-apply + posttest; switches stay OFF
//   census           read-only: lc_mcp_corpus_census (its PROPOSED reader chain is applied inside the copy only if
//                    absent) + aggregate counts; eligibility eligible / blocked / UNKNOWN apart, unknown never contactable
//   hidden-gold      read-only: historical seller-conversation ranking (lc_opportunity_rank_v1 over the 1.1 worklist) with
//                    opaque ids, categories, scores, evidence message ids and an eligibility verdict; resumable
//   report           one markdown summary of every step's evidence
//   destroy          drop the isolated database
//
// Every step writes <out>/<step>.json and appends <out>/<step>.log; re-running a passed step is a no-op (restore,
// migrate) or an identical re-read (prereqs, census, report). Census / hidden-gold sessions run with
// default_transaction_read_only = on (PGOPTIONS and SET), proven by a refused write in the same mode.
//
//   node scripts/db/prod-copy-rehearsal.mjs <subcommand> --admin-url postgres://postgres@127.0.0.1:54341/postgres \
//     --db lc_prodcopy_<tag> --out <evidence dir> [--file <backup>] [--pg-bin /usr/lib/postgresql/17/bin] [options]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertDisposableTarget, parseConnTarget, sanitizedPgEnv, UnsafeDbTargetError } from './db-target-guard.mjs'
import { MIGRATION_TESTS } from './migration-tests.manifest.mjs'
import { fingerprint, rowCounts, diffLines, applyFile, lintTestFixtures } from './run-migration-test.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '../..')
export const TOOL_VERSION = 'prod-copy-rehearsal/1'
export const PREFIX = 'lc_prodcopy_'
export const SYNTH_PREFIX = 'lc_prodcopy_synth_'
export const DB_NAME_RE = /^lc_prodcopy_[a-z0-9_]{1,50}$/
export const PLAN_DOC = 'docs/AGENT-MESSAGES-MIGRATION-PLAN.md'
export const AUDIT_DOC = 'docs/AGENT-TEXTS-DIFF-AUDIT.md'

// ════════════════════════════════════════════════════════════════════════════════════════════ guard ═══
/** Anything that looks hosted / remote is refused even before the loopback rule (belt and braces). */
export const REMOTE_HINTS = Object.freeze([
  /supabase/i, /pooler/i, /amazonaws\.com/i, /\brds\b/i, /neon\.tech/i, /render\.com/i, /heroku/i, /azure/i, /database\.windows\.net/i,
  /googleapis\.com/i, /cloudsql/i, /aiven/i, /timescale/i, /crunchydata/i, /digitalocean/i, /railway\.app/i, /rlwy\.net/i,
  /fly\.dev/i, /flycast/i, /xata/i, /cockroachlabs/i, /tembo/i, /prisma/i,
])
export const SUPABASE_PLATFORM_ROLES = Object.freeze(['supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_replication_admin', 'pgbouncer'])
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1'])

const refused = (m) => new UnsafeDbTargetError(`refused: ${m}`)

/** A rehearsal database name: lc_prodcopy_<tag> (lower-case letters, digits, underscores). */
export function assertDbName(db, prefix = PREFIX) {
  if (typeof db !== 'string' || !DB_NAME_RE.test(db)) throw refused(`database name ${JSON.stringify(db ?? null)} — a rehearsal database is named lc_prodcopy_<tag> (a-z, 0-9, _)`)
  if (!db.startsWith(prefix)) throw refused(`database ${db} does not start with ${prefix}`)
  return db
}

/**
 * A postgres:// URL that may only reach a loopback / unix-socket server. LC_DISPOSABLE_DB_HOST is NEVER honoured here
 * (the migration runner's escape hatch for CI service containers does not apply to production data).
 */
export function assertRehearsalUrl(url) {
  const raw = String(url ?? '').trim()
  if (!raw) throw refused('no database URL given')
  if (!/^postgres(?:ql)?:\/\//i.test(raw)) throw refused('give a postgres:// URL (keyword/value conninfo is not accepted by the rehearsal)')
  for (const re of REMOTE_HINTS) if (re.test(raw)) throw refused(`the URL looks like a hosted / remote database (${re.source})`)
  const parsed = parseConnTarget(raw)
  if (!parsed.hosts.length) throw refused('the URL names no host: give 127.0.0.1, localhost, ::1 or a unix-socket directory explicitly')
  const r = assertDisposableTarget(raw, { env: {} })
  if (!r.local) throw refused('only a loopback or unix-socket server is accepted')
  return { hosts: r.hosts, user: r.user, dbname: r.dbname }
}

export function urlForDb(adminUrl, db) {
  const m = /^(postgres(?:ql)?:\/\/[^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/i.exec(String(adminUrl))
  if (!m) throw refused('unparseable admin URL')
  return `${m[1]}/${db}${m[3] || ''}`
}

/** Static guard: the admin URL and the rehearsal database URL derived from it. Never connects. */
export function guardTarget({ adminUrl, db, prefix = PREFIX }) {
  const admin = assertRehearsalUrl(adminUrl)
  assertDbName(db, prefix)
  if (admin.dbname && admin.dbname.startsWith(PREFIX)) throw refused('the admin URL must name a maintenance database (e.g. postgres), not a rehearsal database')
  const url = urlForDb(adminUrl, db)
  const t = assertRehearsalUrl(url)
  if (t.dbname !== db) throw refused(`the derived URL names ${t.dbname}, not ${db}`)
  return { adminUrl, url, db, hosts: t.hosts }
}

export function redactUrl(u) {
  return String(u).replace(/(\/\/[^:@/]*):[^@/]*@/, '$1:***@').replace(/([?&]password=)[^&]*/i, '$1***')
}

// ════════════════════════════════════════════════════════════════════════════════ process helpers ═══
export function pgTool(name) {
  const bin = process.env.LC_PG_BIN
  return bin ? path.join(bin, name) : name
}
export function childEnv(extra = {}) {
  return sanitizedPgEnv(process.env, { PGAPPNAME: 'lc-prodcopy-rehearsal', ...extra })
}
const READ_ONLY_PGOPTIONS = '-c default_transaction_read_only=on'

function psql(url, args, { readOnly = false, input } = {}) {
  assertRehearsalUrl(url)
  const r = spawnSync(pgTool('psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-d', url, ...args], {
    encoding: 'utf8', env: childEnv(readOnly ? { PGOPTIONS: READ_ONLY_PGOPTIONS } : {}), input, maxBuffer: 1024 * 1024 * 1024,
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** The ERROR line(s) only — never DETAIL / CONTEXT (they can quote row values) — scrubbed. */
export function errorSummary(stderr) {
  const lines = String(stderr || '').split('\n').filter((l) => /ERROR:/.test(l)).map((l) => l.replace(/^psql:[^:]*:\d+:\s*/, ''))
  return scrubText(lines.slice(0, 2).join(' | ') || String(stderr || '').trim().split('\n')[0] || 'unknown error').slice(0, 500)
}
export function sqlState(stderr) {
  const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(String(stderr || ''))
  return m ? m[1] : null
}

/** One query (tab-separated, unaligned). Read-only sessions are read-only twice: PGOPTIONS and SET. */
export function q(url, sqlText, { readOnly = false } = {}) {
  const r = psql(url, ['-At', '-F', '\t', ...(readOnly ? ['-c', 'set default_transaction_read_only = on'] : []), '-c', sqlText], { readOnly })
  if (r.status !== 0) {
    const e = new Error(`query failed: ${errorSummary(r.stderr)}`)
    e.sqlstate = sqlState(r.stderr)
    throw e
  }
  return r.stdout.replace(/\n$/, '')
}
const qJson = (url, sqlText, opts) => {
  const out = q(url, sqlText, opts)
  return out === '' ? null : JSON.parse(out)
}
const lit = (v) => (v == null ? 'null' : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)

// ════════════════════════════════════════════════════════════════════════════════ privacy helpers ═══
const UUIDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX_LONG = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi
/** Values under these keys are opaque database ids or hashes (a property id can be a 10-digit number): no pattern check. */
const ID_KEY = /(^|_)(id|ids)$|sha256|fingerprint|hash|^rank$/
const ISO_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g
const PHONE = /(?<!\w)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)/
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i
const STREET = /\b\d{1,6}\s+[A-Za-z0-9.]+(?:\s+[A-Za-z0-9.]+)?\s+(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Cir|Circle|Hwy|Pkwy|Ter|Trl)\b/
/** Keys that carry PII or message content: never in a default output. */
export const FORBIDDEN_KEYS = Object.freeze(new Set(['body', 'message_body', 'text', 'latest_seller_text', 'seller_text', 'span', 'phone', 'phone_e164', 'canonical_e164',
  'thread_key', 'to_phone_number', 'from_phone_number', 'name', 'full_name', 'display_name', 'owner_name', 'address', 'property_address', 'property_address_full', 'email']))

/** Masks email- and phone-shaped text (10-15 digits, not part of an identifier, a hex string or a timestamp). */
export function scrubText(s) {
  return String(s ?? '').replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, '[email]')
    .replace(/(?<![\w.:-])\+?\(?\d[\d().\s-]{8,}\d(?![\w.:-])/g, (m) => { const n = m.replace(/\D/g, '').length; return n >= 10 && n <= 15 ? '[digits]' : m })
}

/** Throws when a value (deep) carries a forbidden key, a phone- / email- / street-address-shaped string. */
export function assertNoPii(value, where = 'output') {
  const walk = (v, p, idKey = false) => {
    if (v == null) return
    if (typeof v === 'string') {
      if (idKey) return
      const s = v.replace(UUIDS, '').replace(HEX_LONG, '').replace(ISO_TS, '')
      if (PHONE.test(s)) throw new Error(`${where}: phone-shaped value at ${p}`)
      if (EMAIL.test(s)) throw new Error(`${where}: email-shaped value at ${p}`)
      if (STREET.test(s)) throw new Error(`${where}: street-address-shaped value at ${p}`)
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`, idKey)); return }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) throw new Error(`${where}: forbidden key ${p}.${k}`)
        walk(x, `${p}.${k}`, ID_KEY.test(k))
      }
    }
  }
  walk(value, '$')
  return true
}

// ════════════════════════════════════════════════════════════════════════════ eligibility verdict ═══
// THE RULE (fails closed). A thread is ELIGIBLE only when LeadCommand's own eligibility read (reader 1.3,
// lc_mcp_thread_contact_eligibility) affirms eligible_for_outreach with no blocking reason AND every input that read can
// be missing is present: the hold registry, the contact/property resolution with a confirmed owner, a phone row with a
// known line type and activity, a recorded contactability status. Any blocker → BLOCKED. Anything missing → UNKNOWN.
// UNKNOWN IS NEVER CONTACTABLE. An eligible verdict is a READ of the guard's inputs, never a send authorization.
export const VERDICTS = Object.freeze(['eligible', 'blocked', 'unknown'])
const BLOCKING_ROLES = new Set(['not_owner', 'former_owner', 'suppressed', 'ownership_declined_unverified'])
const NOT_TEXTABLE = /landline|voip_fixed|fax|toll/i
const BAD_PHONE_STATUS = /opt|dnc|do_not|invalid|disconnect|wrong|dead|blocked|suppress/i

export function eligibilityVerdict({ eligibility = null, worklistContact = null } = {}) {
  const blockers = []
  const unknowns = []
  const e = eligibility
  if (!e) unknowns.push('eligibility_read_unavailable')
  else if (e.thread_found === false) unknowns.push('thread_not_found')
  else {
    const reasons = Array.isArray(e.blocking_reasons) ? e.blocking_reasons.map(String) : []
    blockers.push(...reasons)
    if (e.eligible_for_outreach !== true && !reasons.length) unknowns.push('eligibility_not_affirmed')
    const src = e.sources || {}
    if (src.automation_hold_for !== true) unknowns.push('holds_unavailable')
    if (src.contact_property_resolution !== true) unknowns.push('ownership_source_unavailable')
    const cp = e.contact_property
    if (cp && typeof cp === 'object') {
      if (cp.rejected === true) blockers.push('contact_property_rejected')
      if (BLOCKING_ROLES.has(cp.role)) blockers.push(`contact_role_${cp.role}`)
      else if (cp.role !== 'confirmed_owner') unknowns.push('ownership_unconfirmed')
    } else unknowns.push('ownership_unconfirmed')
    const flags = e.thread_flags || {}
    if (flags.paused === true) blockers.push('thread_paused_review')
    const cs = flags.contactability_status == null ? null : String(flags.contactability_status).toLowerCase()
    if (!cs) unknowns.push('contactability_not_recorded')
    else if (cs !== 'contactable' && !reasons.some((r) => r.startsWith('contactability_'))) unknowns.push(`contactability_${cs.replace(/[^a-z0-9_]/g, '_').slice(0, 30)}`)
    const phones = Array.isArray(e.phone_rows) ? e.phone_rows : []
    if (!phones.length) unknowns.push('no_phone_record')
    for (const p of phones) {
      if (NOT_TEXTABLE.test(String(p.phone_type || ''))) blockers.push('not_textable_line_type')
      else if (!p.phone_type) unknowns.push('line_type_unknown')
      if (BAD_PHONE_STATUS.test(String(p.contact_status || ''))) blockers.push('phone_status_blocked')
      if (p.wrong_number_at) blockers.push('phone_wrong_number')
      if (!p.activity_status || /unknown/i.test(String(p.activity_status))) unknowns.push('phone_activity_unknown')
    }
  }
  if (worklistContact) {
    for (const b of worklistContact.blockers || []) blockers.push(String(b))
    for (const u of worklistContact.unknowns || []) {
      // the worklist never reads phones / ownership; the eligibility read above does
      if (e && e.thread_found !== false && (u === 'phone_and_ownership_not_read_here' || u === 'holds_unavailable' || u === 'contactability_not_recorded')) continue
      unknowns.push(String(u))
    }
  }
  const b = [...new Set(blockers)]
  const u = [...new Set(unknowns)]
  const verdict = b.length ? 'blocked' : u.length ? 'unknown' : e && e.eligible_for_outreach === true ? 'eligible' : 'unknown'
  return { verdict, contactable: verdict === 'eligible', blocking_reasons: b, unknown_reasons: u, authoritative: false }
}

/** Fail closed on any record that claims contact for a verdict other than eligible. */
export function assertContactInvariant(records, where = 'output') {
  for (const r of records) {
    const v = r?.eligibility ?? r
    if (!VERDICTS.includes(v?.verdict)) throw new Error(`${where}: unknown verdict ${JSON.stringify(v?.verdict)}`)
    if (v.contactable !== (v.verdict === 'eligible')) throw new Error(`${where}: verdict ${v.verdict} marked contactable=${v.contactable} — only eligible is contactable; unknown never is`)
  }
  return true
}

export function aggregateEligibility(verdicts) {
  assertContactInvariant(verdicts, 'eligibility aggregate')
  const out = { threads: verdicts.length, eligible: 0, blocked: 0, unknown: 0, contactable: 0, unknown_counted_as_contactable: 0, by_blocking_reason: {}, by_unknown_reason: {} }
  for (const v of verdicts) {
    out[v.verdict] += 1
    if (v.contactable) out.contactable += 1
    if (v.verdict === 'unknown' && v.contactable) out.unknown_counted_as_contactable += 1
    for (const r of v.blocking_reasons) out.by_blocking_reason[r] = (out.by_blocking_reason[r] || 0) + 1
    if (v.verdict === 'unknown') for (const r of v.unknown_reasons) out.by_unknown_reason[r] = (out.by_unknown_reason[r] || 0) + 1
  }
  out.rule = 'contactable = eligible only; unknown and blocked are never contactable; eligible is a read of the send-time guard inputs, never a send authorization'
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════════ hidden-gold rows ═══
export const CATEGORY_RULE = 'first match: unanswered_interested_seller (verified unanswered + interest in the seller\'s words) · seller_stated_price · offer_requested · interested_seller · timeline_stated · unanswered_seller · label_only · other'
export function categorize(row, ranked) {
  const has = (f) => ranked.factors.some((x) => x.factor === f)
  if (has('unanswered_verified') && has('interest')) return 'unanswered_interested_seller'
  if (has('price_ask_candidate')) return 'seller_stated_price'
  if (has('offer_request')) return 'offer_requested'
  if (has('interest')) return 'interested_seller'
  if (has('timeline')) return 'timeline_stated'
  if (has('unanswered_verified')) return 'unanswered_seller'
  if (has('label_only')) return 'label_only'
  return 'other'
}

/** The default (no-PII) projection of one ranked thread. */
export function projectRanked(row, ranked, verdict) {
  const cited = new Set()
  for (const b of row.interest?.basis || []) if (b.message_id) cited.add(String(b.message_id))
  for (const p of row.readings?.price_mentions || []) if (p.message_id) cited.add(String(p.message_id))
  for (const t of row.readings?.timeline_mentions || []) if (t.message_id) cited.add(String(t.message_id))
  const evidence = cited.size ? [...cited] : (row.inbound || []).map((m) => String(m.id))
  const next = verdict.verdict !== 'eligible' && /reply/.test(ranked.next_step) ? `human_review_eligibility_${verdict.verdict}` : ranked.next_step
  return {
    thread_id: String(row.thread_id),
    property_id: row.property_id == null ? null : String(row.property_id),
    category: categorize(row, ranked),
    score: ranked.score,
    factors: ranked.factors.map((f) => ({ factor: f.factor, points: f.points })),
    evidence_message_ids: evidence,
    eligibility: { verdict: verdict.verdict, contactable: verdict.contactable, blocking_reasons: verdict.blocking_reasons, unknown_reasons: verdict.unknown_reasons },
    next_step: next,
    flags: ranked.flags,
    interest: row.interest?.state ?? null,
    verified: row.verified?.state ?? null,
    last_inbound_at: row.last_inbound_at ?? null,
  }
}

/** Sort, rank, and check every invariant of the default output. */
export function finalizeRanking(records, { top = null } = {}) {
  assertContactInvariant(records, 'hidden-gold')
  const sorted = [...records].sort((a, b) => b.score - a.score || String(b.last_inbound_at).localeCompare(String(a.last_inbound_at)) || a.thread_id.localeCompare(b.thread_id))
  sorted.forEach((r, i) => { r.rank = i + 1 })
  const out = top ? sorted.slice(0, top) : sorted
  assertNoPii(out, 'hidden-gold ranking')
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════════ evidence I/O ═══
function sha256File(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(8 * 1024 * 1024)
  try {
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}
const sha256Text = (s) => crypto.createHash('sha256').update(s).digest('hex')
const toolSha = () => sha256Text(fs.readFileSync(fileURLToPath(import.meta.url)))

function writeFileSecure(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

class Ctx {
  constructor(opts) {
    Object.assign(this, opts)
    fs.mkdirSync(this.out, { recursive: true, mode: 0o700 })
  }
  evidence(name) { return path.join(this.out, name) }
  log(step, msg) {
    const line = `${new Date().toISOString()} ${scrubText(msg)}`
    fs.appendFileSync(this.evidence(`${step}.log`), `${line}\n`, { mode: 0o600 })
    console.log(`[${step}] ${scrubText(msg)}`)
  }
  read(step) { return readJson(this.evidence(`${step}.json`)) }
  write(step, doc) {
    assertNoPii(doc, `${step}.json`)
    writeFileSecure(this.evidence(`${step}.json`), `${JSON.stringify(doc, null, 2)}\n`)
  }
}

/** Run one step: guard first, record timing / status, write <step>.json even on a stop. */
async function runStep(ctx, step, fn, { requires = [] } = {}) {
  const started = new Date()
  const doc = { step, tool: TOOL_VERSION, tool_sha256: toolSha(), database: ctx.db, admin_url: redactUrl(ctx.adminUrl), started_at: started.toISOString() }
  try {
    doc.guard = guardConnectedAll(ctx)
    for (const r of requires) {
      const prev = ctx.read(r)
      if (!prev || prev.status !== 'pass') throw stop(`${r} has not passed (${prev ? prev.status : 'not run'}): ${r} must pass before ${step}`)
    }
    const res = await fn(doc)
    doc.status = doc.status || 'pass'
    if (res !== undefined) doc.results = res
  } catch (e) {
    doc.status = e instanceof UnsafeDbTargetError ? 'refused' : e.stop ? 'stopped' : 'fail'
    doc.stop_reason = scrubText(e.message).slice(0, 2000)
    if (e.results) doc.results = e.results
    ctx.log(step, `${doc.status.toUpperCase()}: ${doc.stop_reason}`)
  }
  doc.finished_at = new Date().toISOString()
  doc.ms = Date.now() - started.getTime()
  ctx.write(step, doc)
  ctx.log(step, `${step}: ${doc.status} (${doc.ms} ms)`)
  return doc
}
const stop = (m) => Object.assign(new Error(m), { stop: true })

// ══════════════════════════════════════════════════════════════════════════════ connected guard ═══
/** Connected checks: loopback server address, no Supabase platform role, the expected database. */
export function guardConnected(url, { expectDb = null } = {}) {
  const out = q(url, `select current_database(), coalesce(host(inet_server_addr()), ''), (select coalesce(string_agg(rolname, ',' order by rolname), '') from pg_roles where rolname in (${SUPABASE_PLATFORM_ROLES.map(lit).join(', ')})), current_setting('server_version'), current_setting('server_version_num')`)
  const [database, addr, roles, version, versionNum] = out.split('\t')
  if (addr && !LOOPBACK_ADDRS.has(addr)) throw refused(`the connected server address ${addr} is not loopback`)
  if (roles) throw refused(`the server carries Supabase platform roles (${roles}) — not an isolated local server`)
  if (expectDb && database !== expectDb) throw refused(`connected to ${database}, expected ${expectDb}`)
  return { database, server_address: addr || 'unix-socket', server_version: version, server_version_num: Number(versionNum) }
}

function dbExists(ctx) {
  return q(ctx.adminUrl, `select count(*) from pg_database where datname = ${lit(ctx.db)}`) === '1'
}

function guardConnectedAll(ctx) {
  const t = guardTarget({ adminUrl: ctx.adminUrl, db: ctx.db, prefix: ctx.prefix })
  const admin = guardConnected(ctx.adminUrl)
  const exists = dbExists(ctx)
  const target = exists ? guardConnected(t.url, { expectDb: ctx.db }) : null
  return { static: 'pass', hosts: t.hosts, admin, target_exists: exists, target }
}

// ══════════════════════════════════════════════════════════════════════════════ validate-backup ═══
export function detectFormat(file) {
  const st = fs.statSync(file)
  if (st.isDirectory()) return fs.existsSync(path.join(file, 'toc.dat')) ? 'directory' : 'unknown-directory'
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(512)
  fs.readSync(fd, head, 0, 512, 0)
  fs.closeSync(fd)
  if (head.subarray(0, 5).toString('latin1') === 'PGDMP') return 'custom'
  if (head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar'
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip'
  if (/PostgreSQL database dump/.test(head.toString('utf8'))) return 'plain'
  return 'unknown'
}

/** Parse `pg_restore --list` output: header facts and TOC counts (object metadata only, never row data). */
export function parseTocList(text) {
  const header = {}
  const byType = {}
  const bySchema = {}
  const tableData = []
  const entries = []
  for (const line of String(text).split('\n')) {
    let m
    if ((m = /^;\s+(Archive created at|dbname|TOC Entries|Compression|Dump Version|Format|Dumped from database version|Dumped by pg_dump version):\s*(.*)$/.exec(line))) header[m[1]] = m[2].trim()
    if (!/^\d+;/.test(line)) continue
    // "<id>; <tableoid> <oid> <DESC words> <schema> <name> <owner>" — DESC can be several words
    const mm = /^(\d+);\s+\d+\s+\d+\s+(.*)$/.exec(line)
    if (!mm) continue
    const rest = mm[2]
    const desc = (/^(TABLE DATA|SEQUENCE SET|DEFAULT ACL|ACL|COMMENT|FK CONSTRAINT|CHECK CONSTRAINT|INDEX ATTACH|TABLE ATTACH|MATERIALIZED VIEW DATA|MATERIALIZED VIEW|EVENT TRIGGER|FOREIGN TABLE|LARGE OBJECT|BLOBS|BLOB|TEXT SEARCH \w+|SHELL TYPE|PUBLICATION TABLE|PUBLICATION|SUBSCRIPTION|POLICY|ROW SECURITY|DEFAULT|CONSTRAINT|EXTENSION|SCHEMA|TABLE|VIEW|SEQUENCE OWNED BY|SEQUENCE|INDEX|TRIGGER|RULE|FUNCTION|PROCEDURE|AGGREGATE|TYPE|DOMAIN|OPERATOR|CAST|COLLATION|CONVERSION|SERVER|USER MAPPING|DATABASE PROPERTIES|DATABASE|ENCODING|STDSTRINGS|SEARCHPATH)\b/.exec(rest) || [null, rest.split(' ')[0]])[1]
    const after = rest.slice(desc.length).trim().split(/\s+/)
    const schema = after.length >= 3 ? after[0] : '-'
    byType[desc] = (byType[desc] || 0) + 1
    bySchema[schema] = (bySchema[schema] || 0) + 1
    if (desc === 'TABLE DATA') tableData.push(`${after[0]}.${after[1]}`)
    entries.push({ id: Number(mm[1]), desc, schema, line })
  }
  return { header, by_type: byType, by_schema: bySchema, table_data: tableData, entries }
}

/** Plain SQL: header + a statement / meta-command scan (cluster-level or reconnecting statements are refused). */
export function scanPlainSql(file) {
  const counts = { create_table: 0, copy_from_stdin: 0, insert: 0, create_function: 0, grant: 0, alter_owner: 0 }
  const forbidden = []
  const text = fs.readFileSync(file, 'utf8')
  let inCopy = false
  let lineNo = 0
  for (const line of text.split('\n')) {
    lineNo += 1
    if (inCopy) { if (line === '\\.') inCopy = false; continue }
    if (/^COPY .* FROM stdin;$/.test(line)) { counts.copy_from_stdin += 1; inCopy = true; continue }
    if (/^CREATE TABLE /.test(line)) counts.create_table += 1
    else if (/^INSERT INTO /.test(line)) counts.insert += 1
    else if (/^CREATE (OR REPLACE )?FUNCTION /.test(line)) counts.create_function += 1
    else if (/^GRANT /.test(line)) counts.grant += 1
    else if (/ OWNER TO /.test(line)) counts.alter_owner += 1
    if (/^\\(?!restrict\b|unrestrict\b)/.test(line)) forbidden.push({ line: lineNo, what: `psql meta-command \\${line.slice(1).split(/\s/)[0]}` })
    if (/^(CREATE|DROP|ALTER) (DATABASE|ROLE|USER|TABLESPACE) |^ALTER SYSTEM |COPY .* (TO|FROM) PROGRAM /i.test(line)) forbidden.push({ line: lineNo, what: line.split(/\s+/).slice(0, 3).join(' ') })
  }
  return { header_ok: /PostgreSQL database dump/.test(text.slice(0, 4096)), counts, forbidden: forbidden.slice(0, 20), forbidden_total: forbidden.length }
}

function toolVersion(name) {
  const r = spawnSync(pgTool(name), ['--version'], { encoding: 'utf8', env: childEnv() })
  return r.status === 0 ? r.stdout.trim() : null
}

async function cmdValidateBackup(ctx) {
  return runStep(ctx, 'validate-backup', async () => {
    if (!ctx.file) throw stop('--file <backup> is required')
    const file = path.resolve(ctx.file)
    if (!fs.existsSync(file)) throw stop(`backup file not found: ${file}`)
    const format = detectFormat(file)
    const st = fs.statSync(file)
    const res = { file, format, bytes: st.isDirectory() ? null : st.size, pg_restore: toolVersion('pg_restore') }
    ctx.log('validate-backup', `format ${format}; hashing…`)
    if (format === 'directory') {
      const h = crypto.createHash('sha256')
      for (const f of fs.readdirSync(file).sort()) h.update(`${f}\0${sha256File(path.join(file, f))}\n`)
      res.sha256 = h.digest('hex')
      res.sha256_rule = 'sha256 over "<file>\\0<sha256(file)>\\n" for every file in name order'
    } else res.sha256 = sha256File(file)
    if (['custom', 'directory', 'tar'].includes(format)) {
      const r = spawnSync(pgTool('pg_restore'), ['--list', file], { encoding: 'utf8', env: childEnv(), maxBuffer: 1024 * 1024 * 1024 })
      if (r.status !== 0) throw stop(`pg_restore --list failed (${errorSummary(r.stderr)}); is pg_restore at least the dump's version? use --pg-bin`)
      const toc = parseTocList(r.stdout)
      res.archive = { header: toc.header, toc_entries: toc.entries.length, by_type: toc.by_type, by_schema: toc.by_schema, table_data_entries: toc.table_data.length }
      const keys = ['public.properties', 'public.eg_property_facts', 'public.inbox_thread_state', 'public.message_events', 'public.campaign_target_graph', 'public.sms_suppression_list', 'public.phones']
      res.key_tables_with_data = Object.fromEntries(keys.map((k) => [k, toc.table_data.includes(k)]))
    } else if (format === 'plain') {
      const scan = scanPlainSql(file)
      res.plain = scan
      if (!scan.header_ok) throw stop('plain SQL file without a pg_dump header')
      if (scan.forbidden_total) throw stop(`plain SQL carries ${scan.forbidden_total} statement(s) the rehearsal refuses (meta-commands, cluster-level DDL, COPY PROGRAM): restore it from a custom-format dump instead`)
    } else throw stop(`unsupported backup format "${format}": give a pg_dump custom (-Fc), directory (-Fd), tar (-Ft) or plain SQL dump`)
    res.never_printed = 'row data, names, phone numbers, addresses, message bodies'
    ctx.log('validate-backup', `sha256 ${res.sha256}`)
    return res
  })
}

// ═══════════════════════════════════════════════════════════════════════════════════════ restore ═══
/** Supabase platform schemas left out by default: credentials / auth PII / platform internals no rehearsal step reads. */
export const DEFAULT_EXCLUDED_SCHEMAS = Object.freeze(['auth', 'storage', 'vault', 'pgsodium', 'pgsodium_masks', 'realtime', '_realtime', 'supabase_functions',
  'supabase_migrations', 'net', 'graphql', '_analytics', 'pgbouncer'])
export const KEY_TABLES = Object.freeze(['public.properties', 'public.eg_property_facts', 'public.inbox_thread_state', 'public.message_events', 'public.campaigns', 'public.campaign_targets',
  'public.campaign_target_graph', 'public.send_queue', 'public.sms_suppression_list', 'public.phones', 'public.master_owners', 'public.prospects', 'public.contact_property_resolution',
  'public.acquisition_opportunities', 'public.seller_offers', 'public.followup_intents', 'public.property_acquisition_scores', 'public.ai_generated_messages', 'public.automation_holds',
  'public.automation_suppressions', 'public.system_control', 'agent.ops_work_item', 'action_gateway.capability_grants', 'action_gateway.action_intents', 'action_gateway.seller_action_receipts'])

// The minimum of the Supabase platform the archive's policies and functions reference, created only when missing:
// API roles (NOLOGIN, cluster-global, never platform-admin roles) and auth.uid()/auth.role()/auth.jwt() stubs.
const PLATFORM_ROLES_SQL = `do $$ declare r text; made text[] := '{}'; begin
  foreach r in array array['anon','authenticated','service_role','authenticator'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); made := made || r; end if;
  end loop;
  raise notice 'lc_prodcopy roles created: %', coalesce(array_to_string(made, ','), ''); end $$`
const AUTH_STUB_SQL = `create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select nullif(coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')), '')::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;`

/** Role names an archive's GRANT / REVOKE / CREATE POLICY statements name (object metadata, no data). */
export function extractGrantees(sqlText) {
  const roles = new Set()
  const add = (list) => {
    for (const raw of String(list).split(',')) {
      const r = raw.trim().replace(/^"|"$/g, '')
      if (r && !/^(PUBLIC|CURRENT_USER|SESSION_USER|CURRENT_ROLE)$/i.test(r) && /^[A-Za-z_][\w$]*$/.test(r)) roles.add(r)
    }
  }
  for (const stmt of String(sqlText).split(/;\s*\n/)) {
    const st = stmt.replace(/^\s*--[^\n]*\n/gm, '').trim().replace(/;\s*$/, '')
    let m
    if (/^GRANT\b/i.test(st) && (m = /\sTO\s+(.+?)(\s+WITH\s+(GRANT|ADMIN)\s+OPTION|\s+GRANTED\s+BY\s+.*)?$/is.exec(st))) add(m[1])
    else if (/^REVOKE\b/i.test(st) && (m = /\sFROM\s+(.+?)(\s+CASCADE|\s+RESTRICT|\s+GRANTED\s+BY\s+.*)?$/is.exec(st))) add(m[1])
    else if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(st)) {
      if ((m = /\sFOR\s+(?:ROLE|USER)\s+([\w$", ]+?)\s+(?:IN\s+SCHEMA|GRANT|REVOKE)\b/is.exec(st))) add(m[1])
      if ((m = /\sGRANT\s.+\sTO\s+(.+?)(\s+WITH\s+GRANT\s+OPTION)?$/is.exec(st))) add(m[1])
      else if ((m = /\sREVOKE\s.+\sFROM\s+(.+?)(\s+CASCADE|\s+RESTRICT)?$/is.exec(st))) add(m[1])
    } else if (/^CREATE\s+POLICY\b/i.test(st) && (m = /\sTO\s+(.+?)(\s+USING\b|\s+WITH\s+CHECK\b|$)/is.exec(st))) add(m[1])
  }
  return [...roles].sort()
}
/** Never created by the rehearsal: platform-admin roles (their presence makes the guard refuse the server) and reserved names. */
const NEVER_CREATE = (r) => SUPABASE_PLATFORM_ROLES.includes(r) || /^(pg_|supabase)/i.test(r)
/** Gateway roles the PROPOSED links grant to authenticator themselves (PROPOSED_20261019150000 / _160000). */
const AUTHENTICATOR_MEMBERS = new Set(['lc_mcp_reader', 'lc_action_gateway'])

const ERROR_CLASSES = [
  ['extension_unavailable', /extension .*(not available|does not exist)|could not open extension control file|could not access file/i],
  ['role_missing', /role .* does not exist/i],
  ['schema_missing', /schema .* does not exist/i],
  ['already_exists', /already exists/i],
  ['copy_failed', /COPY failed/i],
  ['dependency_missing', /(function|type|relation|operator) .* does not exist/i],
  ['permission', /permission denied|must be (owner|superuser)/i],
]
/** Summarize pg_restore stderr by class and TOC descriptor — never the statement text or a CONTEXT line. */
export function summarizeRestoreErrors(stderr) {
  const lines = String(stderr || '').split('\n')
  const errors = []
  let cur = null
  for (const l of lines) {
    if (/^pg_restore: error: /.test(l)) {
      if (cur) errors.push(cur)
      const cls = (ERROR_CLASSES.find(([, re]) => re.test(l)) || ['other'])[0]
      cur = { class: cls, toc: null, command: null }
    } else if (cur && !cur.command && /^Command was: /.test(l)) {
      // the statement's first words only (e.g. "CREATE SCHEMA public", "COPY public.t"): object metadata, never values
      cur.command = scrubText(l.slice('Command was: '.length).split(/\s+/).slice(0, 4).join(' ').replace(/\(.*$/, '')).slice(0, 120)
    } else if (cur && /^pg_restore: from TOC entry /.test(l)) {
      const m = /^pg_restore: from TOC entry (\d+); \d+ \d+ (.*)$/.exec(l)
      if (m) cur.toc = { id: Number(m[1]), object: m[2].split(' ').slice(0, 4).join(' ') }
    }
  }
  if (cur) errors.push(cur)
  // the auth stub creates schema auth before the restore (its policies call auth.uid()); the archive's own
  // CREATE SCHEMA auth then reports "already exists": expected, not a defect
  for (const e of errors) if (e.class === 'already_exists' && /^CREATE SCHEMA auth;?$/.test(e.command || '')) e.class = 'expected_stub_schema_exists'
  const byClass = {}
  for (const e of errors) byClass[e.class] = (byClass[e.class] || 0) + 1
  const ignored = /errors ignored on restore: (\d+)/.exec(stderr || '')
  return { errors: errors.length, reported_ignored: ignored ? Number(ignored[1]) : 0, by_class: byClass, objects: errors.slice(0, 200).map((e) => ({ class: e.class, command: e.command, toc: e.toc })) }
}

function keyTableCounts(url) {
  const present = q(url, `select string_agg(t, ',') from unnest(array[${KEY_TABLES.map(lit).join(',')}]) t where to_regclass(t) is not null`).split(',').filter(Boolean)
  if (!present.length) return {}
  const out = q(url, `select ${present.map((t, i) => `(select count(*) from ${t}) as c${i}`).join(', ')}`, { readOnly: true }).split('\t')
  return Object.fromEntries(KEY_TABLES.map((t) => [t, present.includes(t) ? Number(out[present.indexOf(t)]) : null]))
}

async function cmdRestore(ctx) {
  return runStep(ctx, 'restore', async (doc) => {
    if (!ctx.file) throw stop('--file <backup> is required')
    const v = ctx.read('validate-backup')
    if (!v || v.status !== 'pass') throw stop('validate-backup must pass first')
    const file = path.resolve(ctx.file)
    if (v.results.file !== file) throw stop(`validate-backup checked ${v.results.file}, not ${file}`)
    const prev = ctx.read('restore')
    const exists = dbExists(ctx)
    if (exists && prev?.status === 'pass' && prev.results?.backup_sha256 === v.results.sha256 && !ctx.replace) {
      doc.status = 'pass'
      ctx.log('restore', `already restored from ${v.results.sha256}; nothing to do (--replace re-creates it)`)
      return { ...prev.results, reused: true }
    }
    if (exists && !ctx.replace) throw stop(`database ${ctx.db} already exists without a passed restore of this backup: pass --replace to drop and re-create it`)
    ctx.log('restore', 're-hashing the backup (it must be the file validate-backup checked)…')
    const sha = v.results.format === 'directory' ? v.results.sha256 : sha256File(file)
    if (sha !== v.results.sha256) throw stop('the backup changed since validate-backup (sha256 differs)')
    const t0 = Date.now()
    if (exists) { q(ctx.adminUrl, `drop database ${ctx.db} with (force)`); ctx.log('restore', `dropped the previous ${ctx.db}`) }
    for (const f of ['prereqs', 'migrate', 'migrate.progress', 'census', 'hidden-gold', 'hidden-gold.state']) if (fs.existsSync(ctx.evidence(`${f}.json`))) fs.renameSync(ctx.evidence(`${f}.json`), ctx.evidence(`${f}.json.superseded-${Date.now()}`))
    q(ctx.adminUrl, `create database ${ctx.db} template template0`)
    const url = urlForDb(ctx.adminUrl, ctx.db)
    guardConnected(url, { expectDb: ctx.db })
    ctx.log('restore', `created ${ctx.db}`)
    const excluded = ctx.noDefaultExcludes ? [...ctx.excludeSchemas] : [...new Set([...DEFAULT_EXCLUDED_SCHEMAS, ...ctx.excludeSchemas])]
    const pre = psql(url, ['-c', PLATFORM_ROLES_SQL])
    const rolesCreated = (/lc_prodcopy roles created: (.*)$/m.exec(pre.stderr) || [])[1] || ''
    if (excluded.includes('auth')) psql(url, ['-c', AUTH_STUB_SQL])
    const res = { backup_sha256: sha, format: v.results.format, excluded_schemas: excluded, roles_created_on_local_server: rolesCreated ? rolesCreated.split(',') : [], auth_stub: excluded.includes('auth'), options: ['--no-owner', '--no-privileges'] }
    const r0 = Date.now()
    if (v.results.format === 'plain') {
      const r = psql(url, ['-v', 'ON_ERROR_STOP=0', '-f', file])
      res.data_restore = { ms: Date.now() - r0, exit: r.status, errors: (r.stderr.match(/ERROR:/g) || []).length, note: 'plain SQL: owners and privileges are NOT stripped (their statements fail or apply as written); schemas are not excluded' }
    } else {
      // roles the archive's privileges and policies name: created NOLOGIN NOINHERIT when missing on this local server
      const list = spawnSync(pgTool('pg_restore'), ['--list', file], { encoding: 'utf8', env: childEnv(), maxBuffer: 1024 * 1024 * 1024 })
      const toc = parseTocList(list.stdout)
      const roleEntries = toc.entries.filter((e) => ['ACL', 'DEFAULT ACL', 'POLICY'].includes(e.desc) && !excluded.includes(e.schema))
      const roleListFile = ctx.evidence(`restore.role-list.${process.pid}`)
      fs.writeFileSync(roleListFile, `${roleEntries.map((e) => e.line).join('\n')}\n`, { mode: 0o600 })
      const script = spawnSync(pgTool('pg_restore'), ['-f', '-', '-L', roleListFile, file], { encoding: 'utf8', env: childEnv(), maxBuffer: 1024 * 1024 * 1024 })
      fs.rmSync(roleListFile, { force: true })
      const grantees = extractGrantees(script.stdout)
      const existing = new Set(q(url, `select coalesce(string_agg(rolname, ','), '') from pg_roles`).split(','))
      const toCreate = grantees.filter((r) => !existing.has(r) && !NEVER_CREATE(r))
      for (const r of toCreate) {
        q(url, `create role "${r}" nologin noinherit`)
        if (AUTHENTICATOR_MEMBERS.has(r)) q(url, `grant "${r}" to authenticator`)
      }
      res.roles_named_by_archive = grantees
      res.roles_created_on_local_server = [...res.roles_created_on_local_server, ...toCreate]
      res.roles_not_created = grantees.filter((r) => !existing.has(r) && NEVER_CREATE(r))
      if (toCreate.length) ctx.log('restore', `created ${toCreate.length} missing role(s) NOLOGIN NOINHERIT on the local server: ${toCreate.join(', ')}`)
      const args = ['--no-owner', '--no-privileges', '-d', url, '--jobs', String(ctx.jobs), ...excluded.flatMap((s) => ['--exclude-schema', s]), file]
      const r = spawnSync(pgTool('pg_restore'), args, { encoding: 'utf8', env: childEnv(), maxBuffer: 1024 * 1024 * 1024 })
      res.data_restore = { ms: Date.now() - r0, exit: r.status, ...summarizeRestoreErrors(r.stderr) }
      ctx.log('restore', `pg_restore --no-owner --no-privileges: exit ${r.status}, ${res.data_restore.errors} error(s) ${JSON.stringify(res.data_restore.by_class)} in ${res.data_restore.ms} ms`)
      if (ctx.aclPass) {
        const acl = toc.entries.filter((e) => (e.desc === 'ACL' || e.desc === 'DEFAULT ACL') && !excluded.includes(e.schema))
        const listFile = ctx.evidence(`restore.acl-list.${process.pid}`)
        fs.writeFileSync(listFile, `${acl.map((e) => e.line).join('\n')}\n`, { mode: 0o600 })
        const a0 = Date.now()
        const ra = spawnSync(pgTool('pg_restore'), ['--no-owner', '-L', listFile, '-d', url, file], { encoding: 'utf8', env: childEnv(), maxBuffer: 1024 * 1024 * 1024 })
        fs.rmSync(listFile, { force: true })
        res.acl_pass = { entries: acl.length, ms: Date.now() - a0, exit: ra.status, ...summarizeRestoreErrors(ra.stderr), why: 'the data restore runs with --no-privileges; the archive\'s GRANT / REVOKE entries are then restored alone (no owners), so the privilege self-checks the links and the §1 query run are judged on production\'s ACLs; grants to roles absent on this local server fail and are counted' }
        ctx.log('restore', `ACL pass: ${acl.length} entries, ${res.acl_pass.errors} error(s) ${JSON.stringify(res.acl_pass.by_class)}`)
      } else res.acl_pass = { skipped: true, consequence: 'privilege self-checks (gateway_self_check, reader self-checks) will judge default ACLs, not production\'s' }
    }
    res.restore_ms = Date.now() - t0
    res.key_table_counts = keyTableCounts(url)
    res.database_bytes = Number(q(url, 'select pg_database_size(current_database())'))
    res.schemas = q(url, `select coalesce(string_agg(nspname, ',' order by nspname), '') from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`).split(',').filter(Boolean)
    res.extensions = q(url, `select coalesce(string_agg(extname, ',' order by extname), '') from pg_extension`).split(',').filter(Boolean)
    res.counts_are = 'exact count(*) per key table; no row is read out'
    if (res.data_restore.exit !== 0 && !res.data_restore.errors) throw stop('pg_restore failed without reporting errors')
    // a table whose rows did not load would make every later count wrong: stop (extension / platform-role errors do not)
    if (res.data_restore.by_class?.copy_failed) throw Object.assign(stop(`${res.data_restore.by_class.copy_failed} table(s) failed to load their rows (COPY failed): the copy is incomplete`), { results: res })
    return res
  }, { requires: ['validate-backup'] })
}

// ═══════════════════════════════════════════════════════════════════════════════════════ prereqs ═══
/** The §1 verification query, verbatim from the migration plan (the first ```sql block after "## 1."). */
export function planSection1Sql() {
  const src = fs.readFileSync(path.join(REPO_ROOT, PLAN_DOC), 'utf8')
  const i = src.indexOf('\n## 1.')
  if (i < 0) throw new Error(`${PLAN_DOC}: section 1 not found`)
  const m = /```sql\n([\s\S]*?)```/.exec(src.slice(i))
  if (!m) throw new Error(`${PLAN_DOC}: the §1 sql block not found`)
  return m[1].trim()
}
/** The V-A / V-B / V-OFF verification queries of the plan §3, verbatim. */
export function planVerifySql(label) {
  const src = fs.readFileSync(path.join(REPO_ROOT, PLAN_DOC), 'utf8')
  // the definition starts a line ("**V-A** (after A):"); earlier mentions ("Verify with **V-A**") are references
  const at = new RegExp(`^\\*\\*${label}\\*\\*`, 'm').exec(src)
  if (!at) throw new Error(`${PLAN_DOC}: ${label} not found`)
  const i = at.index
  const m = /```sql\n([\s\S]*?)```/.exec(src.slice(i))
  return m[1].replace(/--[^\n]*/g, '').trim()
}

const S1_REQUIRED = ['ledger', 'link_26', 'link_27', 'link_28', 'link_28_send_authority', 'gateway_self_check', 'relations']
const S1_APPLIED_BY_SEQUENCE = ['link_29', 'link_31', 'link_31_check']

/** The same checks as the §1 query, each guarded so a missing prerequisite reads false instead of erroring. */
function guardedSection1(url) {
  const base = q(url, `select to_regclass('public.ai_generated_messages') is not null,
      to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is not null,
      to_regclass('action_gateway.extensions') is not null,
      to_regclass('action_gateway.seller_action_receipts') is not null,
      to_regprocedure('public.negotiation_send_authorization_consume(uuid,text,numeric)') is not null,
      to_regclass('action_gateway.lead_annotations') is not null,
      to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is not null,
      coalesce((select pg_get_constraintdef(oid) ~ 'conversation.queue_reply' from pg_constraint
                 where conrelid = to_regclass('action_gateway.capability_grants') and conname = 'capability_grants_standing_seller_facing_chk'), false),
      to_regproc('action_gateway.self_check') is not null,
      to_regclass('public.campaign_targets') is not null and to_regclass('public.message_events') is not null and to_regclass('public.idempotency_ledger') is not null`, { readOnly: true }).split('\t').map((x) => x === 't')
  const names = ['ledger', 'link_26', 'link_27', 'link_28', 'link_28_send_authority', 'link_29', 'link_31', 'link_31_check', 'self_check_exists', 'relations']
  const r = Object.fromEntries(names.map((n, i) => [n, base[i]]))
  r.gateway_self_check = false
  if (r.self_check_exists) {
    try { r.gateway_self_check = q(url, `select coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false)`, { readOnly: true }) === 't' } catch (e) { r.gateway_self_check = false; r.gateway_self_check_error = e.message }
  }
  delete r.self_check_exists
  return r
}

function section1(url) {
  const sqlText = planSection1Sql()
  const out = { sql_sha256: sha256Text(sqlText), source: `${PLAN_DOC} §1 (verbatim)` }
  try {
    const r = psql(url, ['-c', 'set default_transaction_read_only = on', '-A', '-F', '\t', '-c', sqlText], { readOnly: true })
    if (r.status !== 0) throw Object.assign(new Error(errorSummary(r.stderr)), { sqlstate: sqlState(r.stderr) })
    const lines = r.stdout.trim().split('\n').filter((l) => !/^\(\d+ rows?\)$/.test(l))
    const cols = lines[0].split('\t')
    const vals = lines[1].split('\t')
    out.verbatim = Object.fromEntries(cols.map((c, i) => [c, vals[i] === 't' ? true : vals[i] === 'f' ? false : null]))
  } catch (e) {
    out.verbatim = null
    out.verbatim_error = e.message
  }
  out.guarded = guardedSection1(url)
  if (out.verbatim) out.verbatim_matches_guarded = Object.keys(out.verbatim).every((k) => Boolean(out.verbatim[k]) === Boolean(out.guarded[k]))
  return out
}

export const SWITCH_KEYS = Object.freeze(['ai_agent_text_enabled', 'ai_agent_message_enabled', 'ai_conversation_send_enabled'])
/** OFF = the row is absent or its value is 'false' (the code enables a switch only on 'true'). */
export function switchesOff(state) {
  const rows = SWITCH_KEYS.map((k) => {
    const v = state[k]
    const off = v === undefined || v === null || String(v).trim().toLowerCase() === 'false'
    return { key: k, value: v === undefined ? 'absent' : v, off }
  })
  return { ok: rows.every((r) => r.off), switches: rows, rule: 'absent or false (each is enabled only by the value true)' }
}
function readSwitches(url) {
  if (q(url, `select to_regclass('public.system_control') is not null`, { readOnly: true }) !== 't') return { ok: false, error: 'public.system_control is missing' }
  const out = q(url, `select key, coalesce(value, '<null>') from public.system_control where key in (${SWITCH_KEYS.map(lit).join(',')})`, { readOnly: true })
  const state = {}
  for (const l of out.split('\n').filter(Boolean)) { const [k, v] = l.split('\t'); state[k] = v === '<null>' ? null : v }
  return switchesOff(state)
}

function readerState(url) {
  const [role, selfCheck, conv, census, acq] = q(url, `select exists (select 1 from pg_roles where rolname = 'lc_mcp_reader'),
      to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is not null,
      to_regprocedure('public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)') is not null,
      to_regprocedure('public.lc_mcp_corpus_census(text)') is not null,
      to_regprocedure('public.lc_mcp_thread_contact_eligibility(uuid)') is not null`, { readOnly: true }).split('\t').map((x) => x === 't')
  return { reader_1_0: role && selfCheck, reader_1_1_conversation_intel: conv, reader_1_2_corpus_census: census, reader_1_3_acquisition_reads: acq }
}

async function cmdPrereqs(ctx) {
  return runStep(ctx, 'prereqs', async () => {
    const url = urlForDb(ctx.adminUrl, ctx.db)
    const s1 = section1(url)
    const g = s1.guarded
    const missing = S1_REQUIRED.filter((k) => !g[k])
    const alreadyApplied = S1_APPLIED_BY_SEQUENCE.filter((k) => g[k])
    const reader = readerState(url)
    const switches = readSwitches(url)
    const res = {
      section1: s1,
      interpretation: `${PLAN_DOC} §1 was written for links A and B only, so it also asks for #29 and #31. The rehearsal applies #29, #30, #31, A, B in order (docs/AGENT-TEXTS-CHANGE-RISK-REPORT.md, deployment step 3): before it, ${S1_REQUIRED.join(', ')} must be true and ${S1_APPLIED_BY_SEQUENCE.join(', ')} must still be false; migrate re-runs the verbatim query after #31 and requires every value true before A.`,
      required_true: Object.fromEntries(S1_REQUIRED.map((k) => [k, g[k]])),
      must_not_be_applied_yet: Object.fromEntries(S1_APPLIED_BY_SEQUENCE.map((k) => [k, g[k]])),
      reader,
      switches,
      warnings: [],
    }
    if (!reader.reader_1_1_conversation_intel || !reader.reader_1_2_corpus_census) {
      res.warnings.push('ORDERING: reader 1.1 / 1.2 are not applied. Once #30 is applied, 1.1 and 1.2 can no longer be applied (their apply self-check refuses #30\'s functions as unexpected reachable definers) until #30 is rolled back — the documented reader order is 1.0 → 1.1 → 1.2 → #30. The census step applies them inside this copy by rolling #30 back first and re-applying it after.')
    }
    const problems = []
    if (missing.length) problems.push(`prerequisite(s) false: ${missing.join(', ')}`)
    if (alreadyApplied.length) problems.push(`already applied (the five-link sequence does not fit this copy; the owner decides which links remain): ${alreadyApplied.join(', ')}`)
    if (!reader.reader_1_0) problems.push('reader 1.0 (lc_mcp_reader + lc_mcp_reader_self_check) is absent: #30\'s pretest requires it')
    if (reader.reader_1_3_acquisition_reads) problems.push('#30 (lc_mcp_acquisition_reads) is already applied')
    if (!switches.ok) problems.push(`a switch is not OFF: ${JSON.stringify(switches.switches.filter((s) => !s.off))}`)
    res.problems = problems
    ctx.log('prereqs', `required ${JSON.stringify(res.required_true)}; not yet applied ${JSON.stringify(res.must_not_be_applied_yet)}; reader ${JSON.stringify(reader)}; switches ok=${switches.ok}`)
    if (problems.length) {
      throw Object.assign(stop(`STOP: ${problems.join('; ')}`), { results: res })
    }
    return res
  }, { requires: ['restore'] })
}

// ═══════════════════════════════════════════════════════════════════════════════════════ migrate ═══
export const LINKS = Object.freeze([
  Object.freeze({ key: '#29', id: 'action_gateway_ohg', audit_runner_id: 'ohg', what: 'Operation Hidden Gold: the Action Gateway acquisitions family' }),
  Object.freeze({ key: '#30', id: 'lc_mcp_acquisition_reads', audit_runner_id: 'lc_mcp_acquisition_reads', what: 'reader 1.3: five per-thread acquisition reads' }),
  Object.freeze({ key: '#31', id: 'action_gateway_standing_reply', audit_runner_id: 'action_gateway_standing_reply', what: 'the standing seller-facing reply' }),
  Object.freeze({ key: 'A', id: 'ai_generated_outbound', audit_runner_id: 'ai_generated_outbound', what: 'AI-message ledger kinds (agent_outbound, agent_text)' }),
  Object.freeze({ key: 'B', id: 'action_gateway_agent_message', audit_runner_id: 'action_gateway_agent_message', what: 'link #32: agent texts, lead ownership, the event feed' }),
])
/** Posttests written for an isolated runner world: their outcome is recorded, never a stop (unless --strict-posttests). */
export const ADVISORY_POSTTESTS = Object.freeze({
  lc_mcp_acquisition_reads: 'written for its isolated runner world: it CREATEs schema action_gateway inside its transaction (so it fails wherever link #26 is applied, which #29 / #31 / B require) and asserts the synthetic seeds of lc_mcp_acquisition_reads_emulation.sql (threads 101 / 102 / 107). Its pretest, the apply\'s own self-check post-condition, its rollback posttest and the fingerprint checks remain stops.',
})

/** SHA-256 pins from the diff audit: { file → { sha256, rollback_prefix } }. */
export function auditPins() {
  const src = fs.readFileSync(path.join(REPO_ROOT, AUDIT_DOC), 'utf8')
  const pins = {}
  for (const line of src.split('\n')) {
    const m = /`(PROPOSED_\d+_[a-z0-9_]+\.sql)`\s*\|\s*`([0-9a-f]{64})`.*?\|\s*`([0-9a-f]{12})…`/.exec(line)
    if (m) pins[m[1]] = { sha256: m[2], rollback_prefix: m[3] }
  }
  return pins
}

const fileSha = (rel) => sha256Text(fs.readFileSync(path.join(REPO_ROOT, rel)))
const manifestEntry = (id) => {
  const t = MIGRATION_TESTS.find((x) => x.id === id)
  if (!t) throw new Error(`manifest entry ${id} not found`)
  return t
}

/** Every differing fingerprint line (run-migration-test's diffLines keeps only the first 20, for messages). */
export function fullDiff(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  return { removed: a.filter((x) => !B.has(x)), added: b.filter((x) => !A.has(x)) }
}
function changedConstraints(before, after) {
  const names = new Set()
  for (const l of fullDiff(before.lines, after.lines).added) if (l.startsWith('con\t')) names.add(l.split('\t')[1])
  return [...names]
}

/** Relations that existed before an apply (fingerprint 'rel' rows, schema-qualified). */
const relationsOf = (fp) => new Set(fp.lines.filter((l) => l.startsWith('rel\t')).map((l) => l.split('\t')[1]))

/**
 * For every CHECK constraint the apply added or re-created on a table that ALREADY EXISTED (a new table's constraints
 * cost nothing to validate): table size, rows, and the time of a read-only scan that evaluates the same expression.
 */
function checkRevalidationCost(url, conNames, existedBefore) {
  if (!conNames.length) return []
  const rows = q(url, `select c.conrelid::regclass::text, c.conname, c.contype, c.convalidated, pg_get_expr(c.conbin, c.conrelid), pg_total_relation_size(c.conrelid)
                         from pg_constraint c where c.contype = 'c' and format('%s.%s', c.conrelid::regclass, c.conname) = any(array[${conNames.map(lit).join(',')}])`, { readOnly: true })
  const out = []
  for (const l of rows.split('\n').filter(Boolean)) {
    const [rel, con, , validated, expr, bytes] = l.split('\t')
    if (!existedBefore.has(rel.includes('.') ? rel : `public.${rel}`)) continue
    const t0 = Date.now()
    const [n, bad] = q(url, `select count(*), count(*) filter (where not coalesce((${expr}), true)) from ${rel}`, { readOnly: true }).split('\t')
    out.push({ table: rel, constraint: con, validated: validated === 't', rows: Number(n), table_bytes: Number(bytes), scan_ms: Date.now() - t0, violating_rows: Number(bad),
      note: validated === 't' ? 'VALIDATED at apply: the apply scanned every row under its lock; scan_ms is the read-only cost of the same evaluation' : 'NOT VALID: no scan at apply' })
  }
  return out
}

function runFixture(url, file) {
  const t0 = Date.now()
  const r = psql(url, ['-f', path.join(REPO_ROOT, file)])
  return { file, ms: Date.now() - t0, ok: r.status === 0, error: r.status === 0 ? null : errorSummary(r.stderr) }
}

async function cmdMigrate(ctx) {
  return runStep(ctx, 'migrate', async (doc) => {
    const url = urlForDb(ctx.adminUrl, ctx.db)
    const prev = ctx.read('migrate')
    if (prev?.status === 'pass' && !ctx.force) {
      doc.status = 'pass'
      ctx.log('migrate', 'already passed on this copy; nothing to do')
      return { ...prev.results, reused: true }
    }
    const progressFile = ctx.evidence('migrate.progress.json')
    if (fs.existsSync(progressFile)) throw stop(`a previous migrate run stopped part-way (${progressFile}): the copy is in an intermediate state. Re-create it (restore --replace, then prereqs) and run migrate again.`)
    const progress = { started_at: new Date().toISOString(), actions: [] }
    const mark = (a) => { progress.actions.push(a); writeFileSecure(progressFile, `${JSON.stringify(progress, null, 2)}\n`) }
    const pins = auditPins()
    const res = { links: [], hash_check: [], cycle1: [], rollback: [], cycle2: [], checks: {} }
    // 1. hashes + fixture lint before anything runs
    for (const L of LINKS) {
      const t = manifestEntry(L.id)
      const apply = t.apply[0]
      const rb = t.rollback[0]
      const pin = pins[path.basename(apply)]
      const got = { link: L.key, runner_id: L.id, apply: path.basename(apply), sha256: fileSha(apply), expected: pin?.sha256 || null, rollback: path.basename(rb), rollback_sha256: fileSha(rb), rollback_expected_prefix: pin?.rollback_prefix || null }
      got.ok = Boolean(pin) && got.sha256 === pin.sha256 && got.rollback_sha256.startsWith(pin.rollback_prefix)
      got.fixtures = Object.fromEntries([t.pretest, ...(t.posttest || []), ...(t.rollbackPosttest || [])].map((f) => [path.basename(f), fileSha(f)]))
      res.hash_check.push(got)
      if (!got.ok) throw stop(`SHA-256 mismatch for ${L.key} (${got.apply}): ${got.sha256} vs ${AUDIT_DOC} ${pin?.sha256 || 'no pin'}`)
      const lint = lintTestFixtures(t)
      if (lint.length) throw stop(`fixture lint failed for ${L.id}: ${lint.map((x) => `${x.file}:${x.line} ${x.rule}`).join('; ')}`)
    }
    ctx.log('migrate', `SHA-256 of all five links match ${AUDIT_DOC}; fixtures lint clean`)
    res.checks.switches_before = readSwitches(url)
    if (!res.checks.switches_before.ok) throw stop('a switch is not OFF before apply')
    const fp0 = fingerprint(url)
    const rows0 = rowCounts(url)
    res.checks.fingerprint_pre_apply = fp0.hash
    const posttestOutcome = (L, r) => {
      if (r.ok) return 'pass'
      if (ADVISORY_POSTTESTS[L.id] && !ctx.strictPosttests) return 'advisory_fail'
      throw stop(`${L.key} posttest ${path.basename(r.file)} failed: ${r.error}`)
    }
    const cycle = (label, sink) => {
      for (const L of LINKS) {
        const t = manifestEntry(L.id)
        const entry = { link: L.key, runner_id: L.id }
        const fpA = fingerprint(url)
        const rowsA = rowCounts(url)
        const pre = runFixture(url, t.pretest)
        mark({ label, link: L.key, action: 'pretest', ok: pre.ok })
        if (!pre.ok) throw stop(`${label}: ${L.key} pretest refused: ${pre.error}`)
        const fpB = fingerprint(url)
        if (fpB.hash !== fpA.hash) throw stop(`${label}: ${L.key} pretest changed the schema`)
        if (rowCounts(url) !== rowsA) throw stop(`${label}: ${L.key} pretest changed row counts`)
        entry.pretest = { ms: pre.ms, ok: true, left_no_trace: true }
        const a0 = Date.now()
        const ap = applyFile(url, t.apply[0])
        entry.apply = { file: path.basename(t.apply[0]), ms: Date.now() - a0, ok: ap.status === 0 }
        mark({ label, link: L.key, action: 'apply', ok: ap.status === 0 })
        if (ap.status !== 0) throw stop(`${label}: ${L.key} apply failed: ${errorSummary(ap.stderr)}`)
        const fpC = fingerprint(url)
        entry.apply.constraints_added_or_changed = changedConstraints(fpB, fpC)
        entry.apply.check_revalidation = checkRevalidationCost(url, entry.apply.constraints_added_or_changed, relationsOf(fpB))
        entry.posttests = []
        for (const f of t.posttest || []) {
          const r = runFixture(url, f)
          const outcome = posttestOutcome(L, r)
          entry.posttests.push({ file: path.basename(f), ms: r.ms, outcome, error: r.ok ? null : r.error, advisory_reason: outcome === 'advisory_fail' ? ADVISORY_POSTTESTS[L.id] : undefined })
          mark({ label, link: L.key, action: `posttest ${path.basename(f)}`, outcome })
          if (fingerprint(url).hash !== fpC.hash) throw stop(`${label}: ${L.key} posttest changed the schema (it must end in ROLLBACK)`)
        }
        sink.push(entry)
        ctx.log('migrate', `${label}: ${L.key} pretest ${pre.ms} ms · apply ${entry.apply.ms} ms · posttest ${entry.posttests.map((p) => `${p.outcome} ${p.ms} ms`).join(', ')}${entry.apply.check_revalidation.length ? ` · CHECK re-validation ${entry.apply.check_revalidation.map((c) => `${c.table} ${c.rows} rows ${c.scan_ms} ms`).join('; ')}` : ''}`)
        if (L.key === '#31') {
          const s1 = section1(url)
          entry.section1_after = s1
          const all = s1.verbatim && Object.values(s1.verbatim).every((x) => x === true)
          if (!all) throw stop(`${label}: after #31 the verbatim §1 query must be all true before A: ${JSON.stringify(s1.verbatim || s1.verbatim_error)}`)
          ctx.log('migrate', `${label}: §1 verbatim all true after #31 (the plan's precondition for A and B)`)
        }
      }
    }
    // 2. cycle 1
    cycle('cycle 1', res.cycle1)
    const fp1 = fingerprint(url)
    res.checks.fingerprint_applied = fp1.hash
    res.checks.verify_after_cycle1 = verifyPlanQueries(url)
    res.checks.switches_after_cycle1 = readSwitches(url)
    if (!res.checks.switches_after_cycle1.ok) throw stop('a switch is ON after the apply')
    if (!res.checks.verify_after_cycle1.ok) throw stop(`V-A / V-B / V-OFF not satisfied after cycle 1: ${JSON.stringify(res.checks.verify_after_cycle1)}`)
    // 3. roll everything back in reverse
    for (const L of [...LINKS].reverse()) {
      const t = manifestEntry(L.id)
      const entry = { link: L.key, runner_id: L.id }
      const r0 = Date.now()
      const rb = applyFile(url, t.rollback[0], t.rollbackEnv)
      entry.rollback = { file: path.basename(t.rollback[0]), ms: Date.now() - r0, ok: rb.status === 0 }
      mark({ label: 'rollback', link: L.key, action: 'rollback', ok: rb.status === 0 })
      if (rb.status !== 0) throw stop(`rollback of ${L.key} failed: ${errorSummary(rb.stderr)}`)
      entry.rollback_posttests = []
      for (const f of t.rollbackPosttest || []) {
        const r = runFixture(url, f)
        entry.rollback_posttests.push({ file: path.basename(f), ms: r.ms, ok: r.ok, error: r.error })
        mark({ label: 'rollback', link: L.key, action: `rollback posttest ${path.basename(f)}`, ok: r.ok })
        if (!r.ok) throw stop(`rollback posttest of ${L.key} failed: ${r.error}`)
      }
      res.rollback.push(entry)
      ctx.log('migrate', `rollback ${L.key}: ${entry.rollback.ms} ms · rollback posttest ${entry.rollback_posttests.map((p) => `${p.ok ? 'pass' : 'FAIL'} ${p.ms} ms`).join(', ')}`)
    }
    const fpBack = fingerprint(url)
    const d = fullDiff(fp0.lines, fpBack.lines)
    const nonRole = { removed: d.removed.filter((l) => !l.startsWith('role\t')), added: d.added.filter((l) => !l.startsWith('role\t')) }
    res.checks.fingerprint_after_rollback = fpBack.hash
    res.checks.rollback_restored_fingerprint = fpBack.hash === fp0.hash
    res.checks.rollback_fingerprint_diff_excluding_cluster_roles = nonRole
    if (nonRole.removed.length || nonRole.added.length) throw stop(`the rollback did not restore the pre-apply schema: ${JSON.stringify(diffLines(nonRole.removed.length ? fp0.lines.filter((l) => !l.startsWith('role\t')) : [], fpBack.lines.filter((l) => !l.startsWith('role\t')))).slice(0, 1500)}`)
    if (fpBack.hash !== fp0.hash) res.checks.cluster_role_rows_changed = { removed: d.removed.filter((l) => l.startsWith('role\t')), added: d.added.filter((l) => l.startsWith('role\t')), note: 'roles are cluster-global: a change here comes from another database on the same server, not from this copy' }
    res.checks.rollback_restored_row_counts = rowCounts(url) === rows0
    if (!res.checks.rollback_restored_row_counts) throw stop('the rollback did not restore the pre-apply row counts')
    ctx.log('migrate', `rollback restored the pre-apply fingerprint ${fp0.hash} and the row counts`)
    // 4. re-apply
    cycle('cycle 2 (re-apply)', res.cycle2)
    const fp2 = fingerprint(url)
    res.checks.fingerprint_reapplied = fp2.hash
    res.checks.reapply_matches_first_apply = fp2.hash === fp1.hash
    if (!res.checks.reapply_matches_first_apply) {
      const dd = fullDiff(fp1.lines, fp2.lines)
      if (dd.removed.some((l) => !l.startsWith('role\t')) || dd.added.some((l) => !l.startsWith('role\t'))) throw stop(`the re-apply produced a different schema than the first apply: ${JSON.stringify(dd).slice(0, 1500)}`)
    }
    res.checks.verify_after_reapply = verifyPlanQueries(url)
    res.checks.switches_after_reapply = readSwitches(url)
    if (!res.checks.verify_after_reapply.ok || !res.checks.switches_after_reapply.ok) throw stop('V-A / V-B / V-OFF or the switches failed after the re-apply')
    res.timings = summarizeTimings(res)
    fs.rmSync(progressFile, { force: true })
    return res
  }, { requires: ['prereqs'] })
}

function verifyPlanQueries(url) {
  const run = (label) => {
    const r = psql(url, ['-c', 'set default_transaction_read_only = on', '-A', '-F', '\t', '-c', planVerifySql(label)], { readOnly: true })
    if (r.status !== 0) return { error: errorSummary(r.stderr) }
    const lines = r.stdout.trim().split('\n').filter((l) => !/^\(\d+ rows?\)$/.test(l))
    const cols = lines[0].split('\t')
    const vals = lines[1].split('\t')
    return Object.fromEntries(cols.map((c, i) => [c, vals[i] === 't' ? true : vals[i] === 'f' ? false : vals[i] === '' ? null : /^\d+$/.test(vals[i]) ? Number(vals[i]) : vals[i]]))
  }
  const va = run('V-A')
  const vb = run('V-B')
  const voff = run('V-OFF')
  const allTrue = (o) => o && !o.error && Object.values(o).every((x) => x === true)
  const offOk = voff && !voff.error && voff.refusal === 'AGENT_TEXT_KILL_SWITCH_OFF' && voff.at_switch === null && voff.new_grants === 0 && voff.standing_at === 0
  return { 'V-A': va, 'V-B': vb, 'V-OFF': voff, ok: allTrue(va) && allTrue(vb) && offOk, expected_v_off: { refusal: 'AGENT_TEXT_KILL_SWITCH_OFF', at_switch: null, new_grants: 0, standing_at: 0 } }
}

function summarizeTimings(res) {
  const rows = []
  for (const [label, list] of [['cycle 1', res.cycle1], ['cycle 2', res.cycle2]]) {
    for (const e of list) rows.push({ cycle: label, link: e.link, pretest_ms: e.pretest.ms, apply_ms: e.apply.ms, posttest_ms: e.posttests.reduce((n, p) => n + p.ms, 0), posttest: e.posttests.map((p) => p.outcome).join(','), check_constraints: e.apply.check_revalidation.map((c) => ({ table: c.table, rows: c.rows, scan_ms: c.scan_ms })) })
  }
  for (const e of res.rollback) rows.push({ cycle: 'rollback', link: e.link, rollback_ms: e.rollback.ms, rollback_posttest_ms: e.rollback_posttests.reduce((n, p) => n + p.ms, 0) })
  return rows
}

// ═══════════════════════════════════════════════════════════════════════════ reader stack (census) ═══
const READER_LINKS = Object.freeze([
  { id: 'lc_mcp_reader', fn: 'public.lc_mcp_reader_self_check(text[],text[],name)', what: 'reader 1.0' },
  { id: 'lc_mcp_conversation_intel', fn: 'public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)', what: 'reader 1.1 conversation intelligence' },
  { id: 'lc_mcp_corpus_census', fn: 'public.lc_mcp_corpus_census(text)', what: 'reader 1.2 corpus census' },
])

/**
 * WRITE session, inside the isolated copy only: the census / worklist functions are PROPOSED links. Apply each only if
 * absent, in the documented reader order 1.0 → 1.1 → 1.2 → #30. Because 1.1 / 1.2 refuse to apply once #30 is applied,
 * #30 is rolled back first and re-applied after (pretest, apply; its rollback posttest proves the 1.0 reader intact).
 */
function ensureReaderStack(ctx, step) {
  const url = urlForDb(ctx.adminUrl, ctx.db)
  const present = (fn) => q(url, `select to_regprocedure(${lit(fn)}) is not null`) === 't'
  const missing = READER_LINKS.filter((l) => !present(l.fn))
  const actions = []
  if (!missing.length) return { applied: [], note: 'reader 1.0, 1.1 and 1.2 already present' }
  const acq = manifestEntry('lc_mcp_acquisition_reads')
  const acqPresent = present('public.lc_mcp_thread_contact_eligibility(uuid)')
  if (acqPresent && missing.some((l) => l.id !== 'lc_mcp_reader')) {
    const r = applyFile(url, acq.rollback[0])
    if (r.status !== 0) throw stop(`could not roll #30 back to apply the reader chain in order: ${errorSummary(r.stderr)}`)
    const rp = runFixture(url, acq.rollbackPosttest[0])
    actions.push({ action: 'rollback #30 (documented reader order: 1.1 / 1.2 before #30)', ok: rp.ok })
    if (!rp.ok) throw stop(`#30 rollback posttest failed: ${rp.error}`)
  }
  for (const l of missing) {
    const t = manifestEntry(l.id)
    const pre = runFixture(url, t.pretest)
    if (!pre.ok) throw stop(`${l.what} pretest refused: ${pre.error}`)
    const a0 = Date.now()
    const r = applyFile(url, t.apply[0])
    if (r.status !== 0) throw stop(`${l.what} apply failed: ${errorSummary(r.stderr)}`)
    actions.push({ action: `apply ${l.what}`, file: path.basename(t.apply[0]), sha256: fileSha(t.apply[0]), pretest: 'pass', apply_ms: Date.now() - a0, posttest: 'not run (its posttest asserts the runner\'s synthetic seeds)' })
    ctx.log(step, `applied ${l.what} inside the copy (${Date.now() - a0} ms)`)
  }
  if (acqPresent && missing.some((l) => l.id !== 'lc_mcp_reader')) {
    const pre = runFixture(url, acq.pretest)
    if (!pre.ok) throw stop(`#30 re-apply pretest refused: ${pre.error}`)
    const r = applyFile(url, acq.apply[0])
    if (r.status !== 0) throw stop(`#30 re-apply failed: ${errorSummary(r.stderr)}`)
    actions.push({ action: 're-apply #30 after the reader chain', pretest: 'pass', ok: true })
  }
  return { applied: actions, note: 'PROPOSED reader links applied inside the isolated copy only, in the documented order; production is untouched' }
}

/** Proof that a session in the read-only mode refuses a write (SQLSTATE 25006). */
function readOnlyProof(url) {
  const show = q(url, 'show default_transaction_read_only', { readOnly: true })
  let refusedState = null
  try { q(url, 'create table public.lc_prodcopy_write_probe (x int)', { readOnly: true }) } catch (e) { refusedState = e.sqlstate || 'refused' }
  if (!refusedState) throw new Error('a write succeeded in a read-only session')
  return { default_transaction_read_only: show, write_probe_refused_sqlstate: refusedState, how: 'PGOPTIONS=-c default_transaction_read_only=on and SET default_transaction_read_only = on in every census / hidden-gold session' }
}

// ════════════════════════════════════════════════════════════════════════════════════════ census ═══
function columnsOf(url, tables) {
  const out = q(url, `select table_schema || '.' || table_name || '.' || column_name from information_schema.columns
                       where table_schema || '.' || table_name = any(array[${tables.map(lit).join(',')}])`, { readOnly: true })
  return new Set(out.split('\n').filter(Boolean))
}
const groupCounts = (url, sqlText) => {
  const out = q(url, sqlText, { readOnly: true })
  const o = {}
  for (const l of out.split('\n').filter(Boolean)) { const [k, n] = l.split('\t'); o[k === '' ? '(not set)' : k] = Number(n) }
  return o
}
/** k-anonymity for small areas: groups below minCell are folded into one bucket. */
export function foldSmallCells(groups, minCell) {
  const out = {}
  let folded = 0
  let foldedGroups = 0
  for (const [k, n] of Object.entries(groups)) {
    if (n < minCell) { folded += n; foldedGroups += 1 } else out[k] = n
  }
  if (foldedGroups) out[`(${foldedGroups} group(s) under ${minCell}, folded)`] = folded
  return out
}

function censusAggregates(url, { minCell }) {
  const T = ['public.inbox_thread_state', 'public.message_events', 'public.eg_property_facts', 'public.acquisition_opportunities', 'public.seller_offers', 'public.followup_intents',
    'public.sms_suppression_list', 'public.automation_suppressions', 'public.campaign_target_graph', 'public.properties']
  const cols = columnsOf(url, T)
  const has = (c) => cols.has(c)
  const ro = { readOnly: true }
  const n = (s) => Number(q(url, s, ro))
  const a = {}
  const definitions = {}
  const TEMP = `lower(coalesce(to_jsonb(s)->>'lead_temperature', to_jsonb(s)->>'temperature', ''))`
  const BLOCKED_FLAGS = `(coalesce((to_jsonb(s)->>'is_suppressed')::boolean, false) or coalesce((to_jsonb(s)->>'opt_out')::boolean, false) or coalesce((to_jsonb(s)->>'wrong_number')::boolean, false)
                         or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) in ('opted_out','do_not_text','do_not_contact','dnc','wrong_number','blocked','suppressed','not_contactable','unreachable'))`
  a.leads = n('select count(*) from public.eg_property_facts')
  a.properties = n('select count(*) from public.properties')
  a.unique_contacts = Object.fromEntries(q(url, `select (select count(distinct canonical_e164) from public.campaign_target_graph where canonical_e164 is not null),
      (select count(distinct thread_key) from public.inbox_thread_state where thread_key is not null),
      (select count(*) from (select canonical_e164 x from public.campaign_target_graph where canonical_e164 is not null union select thread_key from public.inbox_thread_state where thread_key is not null) u)`, ro)
    .split('\t').map((x, i) => [['phones_on_graph', 'thread_numbers', 'distinct_numbers_total'][i], Number(x)]))
  definitions.unique_contacts = 'distinct E.164 numbers (counted, never listed) on the campaign graph, on inbox threads, and across both'
  const [threads, withIn, twoWay, older] = q(url, `select count(*), count(*) filter (where last_inbound_at is not null), count(*) filter (where last_inbound_at is not null and last_outbound_at is not null),
      count(*) filter (where last_inbound_at < now() - interval '365 days') from public.inbox_thread_state`, ro).split('\t').map(Number)
  const [msgs, inb, outb] = q(url, `select count(*), count(*) filter (where lower(direction) like 'in%'), count(*) filter (where lower(direction) like 'out%') from public.message_events`, ro).split('\t').map(Number)
  a.sms_conversations = { threads, with_inbound: withIn, two_way: twoWay, last_inbound_older_than_365d: older, messages: msgs, inbound_messages: inb, outbound_messages: outb }
  // the seller spoke last, verified on the message log (not on the thread projection)
  const unans = q(url, `with last as (select distinct on (m.thread_key) m.thread_key, lower(m.direction) d, m.created_at from public.message_events m where m.thread_key is not null order by m.thread_key, m.created_at desc, m.id::text desc)
      select count(*) filter (where l.d like 'in%'),
             count(*) filter (where l.d like 'in%' and l.created_at < now() - interval '24 hours'),
             count(*) filter (where l.d like 'in%' and l.created_at < now() - interval '7 days'),
             count(*) filter (where l.d like 'in%' and l.created_at < now() - interval '30 days'),
             count(*) filter (where l.d like 'in%' and not exists (select 1 from public.inbox_thread_state s where s.thread_key = l.thread_key and ${BLOCKED_FLAGS})
                                and not exists (select 1 from public.message_events o where o.thread_key = l.thread_key and o.is_opt_out is true))
        from last l`, ro).split('\t').map(Number)
  a.unanswered_seller_messages = { threads_seller_spoke_last: unans[0], waiting_over_24h: unans[1], waiting_over_7d: unans[2], waiting_over_30d: unans[3], excluding_opted_out_suppressed_wrong_number: unans[4] }
  definitions.unanswered_seller_messages = 'threads whose latest message_events row (by created_at) is inbound'
  a.interest = {
    inbound_by_detected_intent: has('public.message_events.detected_intent') ? groupCounts(url, `select coalesce(detected_intent, ''), count(*) from public.message_events where lower(direction) like 'in%' group by 1 order by 2 desc, 1 limit 30`) : 'column absent',
    interest_stage_labels: has('public.eg_property_facts.conversation_stage') ? n(`select count(*) from public.eg_property_facts f where lower(coalesce(f.conversation_stage, '')) in ('interested','offer_interest','asking_price','property_condition','offer','s2','s3','s4','s5')`) : 'column absent',
  }
  definitions.interest = 'detected intents as recorded on inbound messages, and pipeline interest labels (labels, not seller words; the hidden-gold step reads the words)'
  a.asking_prices_and_counteroffers = {
    seller_offers: q(url, `select to_regclass('public.seller_offers') is not null`, ro) === 't' ? {
      rows: n('select count(*) from public.seller_offers'),
      by_direction: groupCounts(url, `select coalesce(to_jsonb(o)->>'direction', ''), count(*) from public.seller_offers o group by 1 order by 1`),
      by_offer_type: groupCounts(url, `select coalesce(to_jsonb(o)->>'offer_type', ''), count(*) from public.seller_offers o group by 1 order by 1`),
      by_status: groupCounts(url, `select coalesce(to_jsonb(o)->>'status', ''), count(*) from public.seller_offers o group by 1 order by 1`),
    } : 'table absent',
    opportunities_with_asking_price: has('public.acquisition_opportunities.asking_price') ? n('select count(*) from public.acquisition_opportunities where asking_price is not null') : 'column absent',
    opportunities_with_current_offer: has('public.acquisition_opportunities.current_offer') ? n('select count(*) from public.acquisition_opportunities where current_offer is not null') : 'column absent',
    inbound_with_price_intent: has('public.message_events.detected_intent') ? n(`select count(*) from public.message_events where lower(direction) like 'in%' and lower(coalesce(detected_intent, '')) ~ '(price|counter|asking)'`) : 'column absent',
    inbound_with_dollar_amount: n(`select count(*) from public.message_events m where lower(m.direction) like 'in%' and coalesce(to_jsonb(m)->>'message_body', '') ~ '\\$\\s?[0-9]'`),
  }
  definitions.asking_prices_and_counteroffers = 'seller_offers rows by direction / type / status; opportunities carrying an asking price or a current offer; inbound messages whose recorded intent names a price / counter, or whose text holds a dollar amount (counted, never read out)'
  a.callbacks = {
    followup_intents_by_state: q(url, `select to_regclass('public.followup_intents') is not null`, ro) === 't' ? groupCounts(url, `select coalesce(state, ''), count(*) from public.followup_intents group by 1 order by 1`) : 'table absent',
    followup_intents_by_kind: q(url, `select to_regclass('public.followup_intents') is not null`, ro) === 't' ? groupCounts(url, `select coalesce(kind, ''), count(*) from public.followup_intents group by 1 order by 2 desc, 1 limit 20`) : 'table absent',
    inbound_callback_requests: n(`select count(*) from public.message_events m where lower(m.direction) like 'in%' and (lower(coalesce(to_jsonb(m)->>'detected_intent', '')) like '%callback%' or coalesce(to_jsonb(m)->>'message_body', '') ~* '\\mcall (me|us)( back)?\\M')`),
  }
  const OPEN = `lower(coalesce(to_jsonb(o)->>'opportunity_status', 'open')) not in ('closed','dead','lost','closed_won','closed_lost','archived')`
  const ACTIVITY = `greatest((to_jsonb(o)->>'last_activity_at')::timestamptz, (select greatest(s.last_inbound_at, s.last_outbound_at) from public.inbox_thread_state s where s.thread_key = o.primary_thread_key limit 1))`
  const NEGOTIATING = `((to_jsonb(o)->>'asking_price') is not null or (to_jsonb(o)->>'current_offer') is not null or lower(coalesce(to_jsonb(o)->>'acquisition_stage', '')) ~ '(negotiat|offer|counter)')`
  a.stalled_negotiations = {
    open_negotiations: n(`select count(*) from public.acquisition_opportunities o where ${OPEN} and ${NEGOTIATING}`),
    no_activity_14d: n(`select count(*) from public.acquisition_opportunities o where ${OPEN} and ${NEGOTIATING} and coalesce(${ACTIVITY}, '-infinity') < now() - interval '14 days'`),
    no_activity_30d: n(`select count(*) from public.acquisition_opportunities o where ${OPEN} and ${NEGOTIATING} and coalesce(${ACTIVITY}, '-infinity') < now() - interval '30 days'`),
  }
  definitions.stalled_negotiations = 'open opportunities with an asking price, a current offer or a negotiation / offer / counter stage, and no thread or opportunity activity for 14 / 30 days'
  a.warm_hot = {
    threads_by_temperature: groupCounts(url, `select ${TEMP}, count(*) from public.inbox_thread_state s group by 1 order by 1`),
    threads_warm_or_hot: n(`select count(*) from public.inbox_thread_state s where ${TEMP} in ('warm','hot')`),
    opportunities_by_temperature: has('public.acquisition_opportunities.temperature') ? groupCounts(url, `select lower(coalesce(temperature, '')), count(*) from public.acquisition_opportunities group by 1 order by 1`) : 'column absent',
  }
  const PENDING_FU = q(url, `select to_regclass('public.followup_intents') is not null`, ro) === 't'
    ? `exists (select 1 from public.followup_intents fi where fi.thread_key = s.thread_key and fi.state in ('planned','materializing','ready','held'))` : 'false'
  const OPEN_OPP_ACTION = `exists (select 1 from public.acquisition_opportunities o where o.primary_thread_key = s.thread_key and ${OPEN} and (to_jsonb(o)->>'next_action') is not null)`
  a.missing_next_actions = {
    threads: n(`select count(*) from public.inbox_thread_state s where s.last_inbound_at is not null and not ${BLOCKED_FLAGS}
                 and (to_jsonb(s)->>'next_action') is null and not ${PENDING_FU} and not ${OPEN_OPP_ACTION}`),
    of_which_seller_spoke_last: n(`select count(*) from public.inbox_thread_state s where s.last_inbound_at is not null and not ${BLOCKED_FLAGS}
                 and (to_jsonb(s)->>'next_action') is null and not ${PENDING_FU} and not ${OPEN_OPP_ACTION} and s.last_inbound_at > coalesce(s.last_outbound_at, '-infinity')`),
  }
  definitions.missing_next_actions = 'threads with seller inbound, not suppressed / opted out / wrong number by their flags, with no next_action on the thread, no pending follow-up intent and no open opportunity carrying a next action'
  a.duplicates_conflicts = {
    identity_conflict_threads: n(`select count(*) from (select m.thread_key from public.message_events m where m.thread_key is not null and m.property_id is not null group by m.thread_key having count(distinct m.property_id) > 1) x`),
    suppression_conflict_threads: n(`select count(*) from public.inbox_thread_state s where s.thread_key is not null and
        exists (select 1 from public.sms_suppression_list x where (x.phone_e164 = s.thread_key or to_jsonb(x)->>'phone_number' = s.thread_key) and coalesce(x.is_active, false))
        is distinct from (coalesce((to_jsonb(s)->>'opt_out')::boolean, false) or lower(coalesce(to_jsonb(s)->>'contactability_status', '')) = 'opted_out' or coalesce((to_jsonb(s)->>'is_suppressed')::boolean, false))`),
  }
  definitions.duplicates_conflicts = 'with the census duplicates: threads whose messages name more than one property; threads where the active suppression list and the thread\'s own opt-out / suppressed flags disagree (either direction)'
  a.suppression = {
    suppression_list_active_rows: n('select count(*) from public.sms_suppression_list where coalesce(is_active, false)'),
    suppression_list_by_type: groupCounts(url, `select coalesce(to_jsonb(x)->>'suppression_type', ''), count(*) from public.sms_suppression_list x where coalesce(x.is_active, false) group by 1 order by 1`),
    threads_flagged_suppressed: n(`select count(*) from public.inbox_thread_state s where coalesce((to_jsonb(s)->>'is_suppressed')::boolean, false)`),
    threads_by_contactability: groupCounts(url, `select lower(coalesce(to_jsonb(s)->>'contactability_status', '')), count(*) from public.inbox_thread_state s group by 1 order by 1`),
    opt_out_messages: n('select count(*) from public.message_events where is_opt_out is true'),
    automation_suppressions_active: q(url, `select to_regclass('public.automation_suppressions') is not null`, ro) === 't' && has('public.automation_suppressions.status')
      ? n(`select count(*) from public.automation_suppressions a where coalesce(a.status, 'active') = 'active' and (a.expires_at is null or a.expires_at > now())`) : 'table or column absent',
  }
  const byMarket = groupCounts(url, `select coalesce(market, ''), count(*) from public.eg_property_facts group by 1 order by 2 desc, 1`)
  const inbMarket = groupCounts(url, `select coalesce(f.market, ''), count(*) from public.inbox_thread_state s left join public.eg_property_facts f on f.property_id = s.property_id where s.last_inbound_at is not null group by 1 order by 2 desc, 1`)
  const unansMarket = groupCounts(url, `with last as (select distinct on (m.thread_key) m.thread_key, lower(m.direction) d from public.message_events m where m.thread_key is not null order by m.thread_key, m.created_at desc, m.id::text desc)
      select coalesce(f.market, ''), count(*) from last l join public.inbox_thread_state s on s.thread_key = l.thread_key left join public.eg_property_facts f on f.property_id = s.property_id where l.d like 'in%' group by 1 order by 2 desc, 1`)
  const byZip = has('public.eg_property_facts.zip_code') ? groupCounts(url, `select coalesce(zip_code, ''), count(*) from public.eg_property_facts group by 1 order by 2 desc, 1`) : null
  const zipInbound = has('public.eg_property_facts.zip_code') ? groupCounts(url, `select coalesce(f.zip_code, ''), count(*) from public.inbox_thread_state s join public.eg_property_facts f on f.property_id = s.property_id where s.last_inbound_at is not null group by 1 order by 2 desc, 1`) : null
  const top = (o, k) => Object.fromEntries(Object.entries(o).slice(0, k))
  a.concentration = {
    leads_by_market: byMarket,
    threads_with_inbound_by_market: inbMarket,
    unanswered_by_market: unansMarket,
    leads_by_zip_top25: byZip ? top(foldSmallCells(byZip, minCell), 26) : 'column absent',
    threads_with_inbound_by_zip_top25: zipInbound ? top(foldSmallCells(zipInbound, minCell), 26) : 'column absent',
    zip_min_cell: minCell,
    zip_groups_total: byZip ? Object.keys(byZip).length : null,
  }
  definitions.concentration = `markets in full; ZIP groups under ${minCell} leads are folded (small-area counts are not published)`
  return { aggregates: a, definitions }
}

function threadEligibility(url) {
  const fnPresent = q(url, `select to_regprocedure('public.lc_mcp_thread_contact_eligibility(uuid)') is not null`, { readOnly: true }) === 't'
  if (!fnPresent) {
    const nThreads = Number(q(url, 'select count(*) from public.inbox_thread_state', { readOnly: true }))
    return { source: 'absent (reader 1.3 not applied): every thread is UNKNOWN', verdicts: Array.from({ length: nThreads }, () => eligibilityVerdict({ eligibility: null })) }
  }
  const out = q(url, `select jsonb_build_object('thread_found', x->'thread_found', 'eligible_for_outreach', x->'eligible_for_outreach', 'blocking_reasons', x->'blocking_reasons', 'sources', x->'sources',
                        'contact_property', x->'contact_property', 'thread_flags', x->'thread_flags', 'phone_rows', x->'phone_rows')::text
                      from (select public.lc_mcp_thread_contact_eligibility(s.id) x from public.inbox_thread_state s order by s.id) t`, { readOnly: true })
  const verdicts = out.split('\n').filter(Boolean).map((l) => eligibilityVerdict({ eligibility: JSON.parse(l) }))
  return { source: 'public.lc_mcp_thread_contact_eligibility (reader 1.3) for every inbox thread, judged by the rehearsal\'s fail-closed rule', verdicts }
}

async function cmdCensus(ctx) {
  return runStep(ctx, 'census', async () => {
    const url = urlForDb(ctx.adminUrl, ctx.db)
    const prep = ensureReaderStack(ctx, 'census')
    const ro = readOnlyProof(url)
    const census = qJson(url, 'select public.lc_mcp_corpus_census(null)::text', { readOnly: true })
    const { aggregates, definitions } = censusAggregates(url, { minCell: ctx.minCell })
    const el = threadEligibility(url)
    aggregates.eligibility = { source: el.source, ...aggregateEligibility(el.verdicts) }
    const res = { reader_stack: prep, read_only: ro, lc_mcp_corpus_census: census, aggregates, definitions, output_policy: 'aggregate counts only: no names, phone numbers, addresses, thread keys or message bodies' }
    ctx.log('census', `leads ${aggregates.leads} · threads ${aggregates.sms_conversations.threads} · seller spoke last ${aggregates.unanswered_seller_messages.threads_seller_spoke_last} · eligibility eligible ${aggregates.eligibility.eligible} / blocked ${aggregates.eligibility.blocked} / unknown ${aggregates.eligibility.unknown} (contactable ${aggregates.eligibility.contactable})`)
    return res
  }, { requires: ['migrate'] })
}

// ═══════════════════════════════════════════════════════════════════════════════════════ hidden-gold ═══
const RPC_ALLOW = new Set(['lc_mcp_conversation_worklist', 'lc_mcp_thread_contact_eligibility'])
/** The reader adapters' `svc.db.rpc` over a read-only psql session (named arguments, literal values, allowlisted names). */
export function readOnlyRpc(url) {
  return {
    rpc(name, params) {
      if (!RPC_ALLOW.has(name)) return Promise.resolve({ data: null, error: { code: '42501', message: `rpc ${name} not allowed` } })
      const args = Object.entries(params).map(([k, v]) => { if (!/^p_[a-z_]+$/.test(k)) throw new Error('bad parameter'); return `${k} => ${lit(v)}` }).join(', ')
      try {
        return Promise.resolve({ data: qJson(url, `select public.${name}(${args})::text`, { readOnly: true }), error: null })
      } catch (e) {
        return Promise.resolve({ data: null, error: { code: e.sqlstate || 'XX000', message: e.message } })
      }
    },
  }
}

async function loadRanker() {
  // apps/api/src is ESM without "type": "module": silence only that one notice (the MCP package scripts do the same)
  const emit = process.emitWarning
  process.emitWarning = (w, ...rest) => (/MODULE_TYPELESS_PACKAGE_JSON|Module type of file/.test(`${w} ${JSON.stringify(rest)}`) ? undefined : emit.call(process, w, ...rest))
  const { register } = await import('node:module')
  register(pathToFileURL(path.join(REPO_ROOT, 'mcp/leadcommand-mcp/src/loader/alias-hooks.mjs')).href)
  return import(pathToFileURL(path.join(REPO_ROOT, 'mcp/leadcommand-mcp/src/adapters/conversations.mjs')).href)
}

const EXCLUDED_INTEREST = new Set(['opted_out', 'possible_opt_out', 'not_owner', 'negative'])

async function cmdHiddenGold(ctx) {
  return runStep(ctx, 'hidden-gold', async () => {
    const url = urlForDb(ctx.adminUrl, ctx.db)
    const prep = ensureReaderStack(ctx, 'hidden-gold')
    const ro = readOnlyProof(url)
    const ranker = await loadRanker()
    const svc = { db: readOnlyRpc(url) }
    const eligibilityPresent = q(url, `select to_regprocedure('public.lc_mcp_thread_contact_eligibility(uuid)') is not null`, { readOnly: true }) === 't'
    const params = { window_days: ctx.windowDays, market: ctx.market || null, category: 'recent_inbound', rule: ranker.RANK_RULE }
    const statePath = ctx.evidence('hidden-gold.state.json')
    const rowsPath = ctx.evidence('hidden-gold.rows.jsonl')
    const ownerPath = ctx.evidence('hidden-gold.owner-only.jsonl')
    let state = ctx.fresh ? null : readJson(statePath)
    if (state && JSON.stringify(state.params) !== JSON.stringify(params)) throw stop(`the checkpoint in ${statePath} was made with other parameters: pass --fresh to start over`)
    if (!state) {
      state = { params, now: new Date().toISOString(), after: null, pages: 0, done: false }
      for (const f of [rowsPath, ownerPath]) fs.rmSync(f, { force: true })
      writeFileSecure(statePath, `${JSON.stringify(state, null, 2)}\n`)
    }
    const now = new Date(state.now)
    const seen = new Set()
    if (fs.existsSync(rowsPath)) for (const l of fs.readFileSync(rowsPath, 'utf8').split('\n').filter(Boolean)) seen.add(JSON.parse(l).thread_id)
    ctx.log('hidden-gold', `${state.done ? 'complete checkpoint' : state.after ? `resuming after page ${state.pages}` : 'starting'} (${seen.size} thread(s) already analysed)`)
    while (!state.done) {
      const page = await ranker.searchConversationWorklist({ category: 'recent_inbound', window_days: ctx.windowDays, market: ctx.market || undefined, limit: ranker.RANK_PAGE }, svc, { after: state.after, now })
      const lines = []
      const owner = []
      for (const row of page.rows) {
        if (seen.has(String(row.thread_id))) continue
        let rec
        if (EXCLUDED_INTEREST.has(row.interest.state)) rec = { thread_id: String(row.thread_id), excluded: row.interest.state }
        else {
          const elig = eligibilityPresent ? (await svc.db.rpc('lc_mcp_thread_contact_eligibility', { p_thread_id: row.thread_id })).data : null
          const verdict = eligibilityVerdict({ eligibility: elig, worklistContact: row.contact })
          const ranked = ranker.rankRow(row, now)
          rec = projectRanked(row, ranked, verdict)
          if (ctx.includeText) owner.push({ thread_id: rec.thread_id, latest_seller_text: row.inbound.length ? row.inbound[row.inbound.length - 1].text : null, factor_evidence: ranked.factors.map((f) => ({ factor: f.factor, evidence: f.evidence })) })
        }
        assertNoPii(rec, 'hidden-gold row')
        lines.push(JSON.stringify(rec))
        seen.add(rec.thread_id)
      }
      if (lines.length) {
        const fd = fs.openSync(rowsPath, 'a', 0o600)
        fs.writeSync(fd, `${lines.join('\n')}\n`)
        fs.fsyncSync(fd)
        fs.closeSync(fd)
      }
      if (owner.length) fs.appendFileSync(ownerPath, `${owner.map((o) => JSON.stringify(o)).join('\n')}\n`, { mode: 0o600 })
      state = { ...state, after: page.last, pages: state.pages + 1, total_with_inbound: page.total, done: !(page.has_more && page.last) }
      writeFileSecure(statePath, `${JSON.stringify(state, null, 2)}\n`)
    }
    const all = fs.existsSync(rowsPath) ? fs.readFileSync(rowsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    const excluded = {}
    for (const r of all.filter((x) => x.excluded)) excluded[r.excluded] = (excluded[r.excluded] || 0) + 1
    const ranked = finalizeRanking(all.filter((x) => !x.excluded), { top: ctx.top })
    const verdicts = all.filter((x) => !x.excluded).map((x) => x.eligibility)
    const byCategory = {}
    for (const r of all.filter((x) => !x.excluded)) byCategory[r.category] = (byCategory[r.category] || 0) + 1
    const res = {
      reader_stack: prep, read_only: ro,
      parameters: params, as_of: state.now, pages_read: state.pages, threads_with_inbound_in_window: state.total_with_inbound ?? null, analysed: all.length,
      excluded_before_ranking: excluded,
      by_category: byCategory,
      eligibility: aggregateEligibility(verdicts),
      eligibility_source: eligibilityPresent ? 'lc_mcp_thread_contact_eligibility (reader 1.3) + the worklist contact reading, judged fail-closed' : 'reader 1.3 absent: every verdict UNKNOWN',
      ranked,
      rule: ranker.RANK_RULE, factors: ranker.RANK_FACTORS, category_rule: CATEGORY_RULE,
      window_note: `the reader worklist covers threads whose last inbound is within ${ctx.windowDays} days (its bound is 365); older threads are counted by the census (last_inbound_older_than_365d), not ranked`,
      output_policy: 'opaque ids (thread / property / message ids), categories, scores, factor names and an eligibility verdict; no names, phones, addresses or message text',
      owner_only_text: ctx.includeText ? { file: path.basename(ownerPath), note: 'OWNER-ONLY: seller words and factor evidence; mode 0600; never part of the report or of any shared evidence' } : 'off (default)',
    }
    ctx.log('hidden-gold', `analysed ${all.length} thread(s) over ${state.pages} page(s); ranked ${ranked.length}; excluded ${JSON.stringify(excluded)}; eligibility ${JSON.stringify({ eligible: res.eligibility.eligible, blocked: res.eligibility.blocked, unknown: res.eligibility.unknown })}`)
    return res
  }, { requires: ['migrate'] })
}

// ═════════════════════════════════════════════════════════════════════════════════════════ report ═══
const STEPS = ['validate-backup', 'restore', 'prereqs', 'migrate', 'census', 'hidden-gold']

export function renderReport(docs, { title = 'Production-copy rehearsal' } = {}) {
  const L = []
  const st = (d) => (d ? d.status.toUpperCase() : 'NOT RUN')
  const g = docs.guard || docs['validate-backup'] || docs.restore
  L.push(`# ${title}`, '')
  L.push(`Database \`${g?.database ?? '?'}\` on \`${g?.admin_url ?? '?'}\` (${g?.guard?.admin?.server_version ? `PostgreSQL ${g.guard.admin.server_version}, ` : ''}server address ${g?.guard?.admin?.server_address ?? '?'}). Tool \`${TOOL_VERSION}\`. Generated ${new Date().toISOString()}.`, '')
  L.push('| Step | Status | Duration | Key result |', '|---|---|---|---|')
  const key = {
    'validate-backup': (r) => r && `${r.format}, ${(r.bytes / 1048576).toFixed(1)} MB, sha256 \`${r.sha256.slice(0, 16)}…\`${r.archive ? `, ${r.archive.toc_entries} TOC entries, ${r.archive.table_data_entries} with data` : ''}`,
    restore: (r) => r && `restore ${r.restore_ms} ms; pg_restore errors ${r.data_restore.errors} ${JSON.stringify(r.data_restore.by_class)}; ACL pass ${r.acl_pass?.skipped ? 'skipped' : `${r.acl_pass.entries} entries, ${r.acl_pass.errors} errors`}`,
    prereqs: (r) => r && `required ${Object.values(r.required_true).every(Boolean) ? 'all true' : 'NOT all true'}; switches ${r.switches.ok ? 'OFF' : 'NOT OFF'}`,
    migrate: (r) => r && `rollback fingerprint ${r.checks.rollback_restored_fingerprint ? 'identical' : 'identical except cluster roles'}; re-apply ${r.checks.reapply_matches_first_apply ? 'identical' : 'differs'}; V-A/V-B/V-OFF ${r.checks.verify_after_reapply.ok ? 'ok' : 'NOT ok'}`,
    census: (r) => r && `leads ${r.aggregates.leads}; threads ${r.aggregates.sms_conversations.threads}; eligible ${r.aggregates.eligibility.eligible} / blocked ${r.aggregates.eligibility.blocked} / unknown ${r.aggregates.eligibility.unknown}`,
    'hidden-gold': (r) => r && `analysed ${r.analysed}; ranked ${r.ranked.length}; contactable ${r.eligibility.contactable}; unknown ${r.eligibility.unknown} (never contactable)`,
  }
  for (const s of STEPS) {
    const d = docs[s]
    L.push(`| ${s} | ${st(d)} | ${d ? `${d.ms} ms` : ''} | ${d?.status === 'pass' ? key[s](d.results) : d ? (d.stop_reason || '').replace(/\|/g, '/').slice(0, 300) : ''} |`)
  }
  L.push('')
  const v = docs['validate-backup']?.results
  if (v) {
    L.push('## Backup', '')
    L.push(`- File \`${path.basename(v.file)}\`, format \`${v.format}\`, sha256 \`${v.sha256}\`, read with ${v.pg_restore || 'pg_restore'}.`)
    if (v.archive) L.push(`- Archive header: ${Object.entries(v.archive.header).filter(([k]) => k !== 'Archive created at').map(([k, x]) => `${k} ${x}`).join('; ')}.`, `- TOC: ${v.archive.toc_entries} entries; by type ${JSON.stringify(v.archive.by_type)}.`, `- Key tables with data: ${JSON.stringify(v.key_tables_with_data)}.`)
    L.push('')
  }
  const r = docs.restore?.results
  if (r) {
    L.push('## Restore', '')
    L.push(`- Options ${r.options.join(' ')}; excluded schemas ${r.excluded_schemas.join(', ')}; auth stub ${r.auth_stub ? 'created' : 'not needed'}; roles created on the local server: ${r.roles_created_on_local_server.length ? r.roles_created_on_local_server.join(', ') : 'none'}.`)
    L.push(`- Data restore ${r.data_restore.ms} ms (exit ${r.data_restore.exit}, ${r.data_restore.errors} error(s) ${JSON.stringify(r.data_restore.by_class)}); ACL pass ${r.acl_pass?.skipped ? 'skipped' : `${r.acl_pass.entries} entries in ${r.acl_pass.ms} ms, ${r.acl_pass.errors} error(s) ${JSON.stringify(r.acl_pass.by_class)}`}; total ${r.restore_ms} ms; database ${(r.database_bytes / 1048576).toFixed(1)} MB.`)
    L.push('', '| Key table | Rows |', '|---|---|')
    for (const [t, n] of Object.entries(r.key_table_counts)) L.push(`| ${t} | ${n ?? 'absent'} |`)
    L.push('')
  }
  const p = docs.prereqs
  if (p) {
    const pr = p.results || {}
    L.push('## Prerequisites (§1)', '')
    if (pr.section1) {
      L.push(`Verbatim §1 query (sha256 \`${pr.section1.sql_sha256.slice(0, 16)}…\`): ${pr.section1.verbatim ? JSON.stringify(pr.section1.verbatim) : `error: ${pr.section1.verbatim_error}`}.`, '')
      L.push(`- Required before the sequence: ${JSON.stringify(pr.required_true)}`, `- Must not be applied yet (the sequence applies them): ${JSON.stringify(pr.must_not_be_applied_yet)}`, `- Reader links: ${JSON.stringify(pr.reader)}`, `- Switches: ${pr.switches.switches.map((s) => `${s.key}=${s.value}`).join(', ')} → ${pr.switches.ok ? 'OFF' : 'NOT OFF'}`)
      for (const w of pr.warnings || []) L.push(`- **Warning:** ${w}`)
    }
    if (p.status !== 'pass') L.push(`- **${p.status.toUpperCase()}:** ${p.stop_reason}`)
    L.push('')
  }
  const m = docs.migrate?.results
  if (m) {
    L.push('## Migrations #29 #30 #31 A B', '')
    L.push('SHA-256 of every apply file equals the pin in `docs/AGENT-TEXTS-DIFF-AUDIT.md` (rollback files match their pinned prefix):', '')
    for (const h of m.hash_check) L.push(`- ${h.link} \`${h.apply}\` \`${h.sha256.slice(0, 16)}…\` ${h.ok ? 'match' : 'MISMATCH'}`)
    L.push('', '| Cycle | Link | Pretest ms | Apply ms | Posttest | CHECKs re-validated on existing tables (rows; read-only scan ms) |', '|---|---|---|---|---|---|')
    const checks = (list) => {
      const by = {}
      for (const c of list) { const b = (by[c.table] ||= { rows: c.rows, n: 0, ms: 0, validated: 0 }); b.n += 1; b.ms += c.scan_ms; if (c.validated) b.validated += 1 }
      return Object.entries(by).map(([t, b]) => `${t}: ${b.n} CHECK(s), ${b.validated} validated at apply, ${b.rows} rows; ${b.ms} ms`).join('; ') || '—'
    }
    for (const [label, list] of [['1', m.cycle1], ['2 (re-apply)', m.cycle2]]) {
      for (const e of list) L.push(`| ${label} | ${e.link} | ${e.pretest.ms} | ${e.apply.ms} | ${e.posttests.map((x) => `${x.outcome} (${x.ms} ms)`).join(', ')} | ${checks(e.apply.check_revalidation)} |`)
    }
    L.push('', '| Rollback | ms | Rollback posttest |', '|---|---|---|')
    for (const e of m.rollback) L.push(`| ${e.link} | ${e.rollback.ms} | ${e.rollback_posttests.map((x) => `${x.ok ? 'pass' : 'FAIL'} (${x.ms} ms)`).join(', ')} |`)
    L.push('', `- Fingerprint before apply \`${m.checks.fingerprint_pre_apply}\`, after rollback \`${m.checks.fingerprint_after_rollback}\` → ${m.checks.rollback_restored_fingerprint ? 'identical' : 'identical apart from cluster-global role rows (another database on the server)'}; row counts restored: ${m.checks.rollback_restored_row_counts}.`)
    L.push(`- Fingerprint after the first apply \`${m.checks.fingerprint_applied}\`, after the re-apply \`${m.checks.fingerprint_reapplied}\` → ${m.checks.reapply_matches_first_apply ? 'identical' : 'differs'}.`)
    L.push(`- V-A ${JSON.stringify(m.checks.verify_after_reapply['V-A'])}`, `- V-B ${JSON.stringify(m.checks.verify_after_reapply['V-B'])}`, `- V-OFF ${JSON.stringify(m.checks.verify_after_reapply['V-OFF'])}`)
    L.push(`- Switches after the re-apply: ${m.checks.switches_after_reapply.switches.map((s) => `${s.key}=${s.value}`).join(', ')} → ${m.checks.switches_after_reapply.ok ? 'OFF' : 'NOT OFF'}.`)
    const adv = [...m.cycle1, ...m.cycle2].flatMap((e) => e.posttests.filter((x) => x.outcome === 'advisory_fail').map((x) => ({ link: e.link, ...x })))
    if (adv.length) L.push(`- Advisory posttest outcomes (recorded, not a stop): ${[...new Set(adv.map((x) => `${x.link} ${x.file}: ${x.error}`))].join('; ')}. Why advisory: ${adv[0].advisory_reason}`)
    L.push('')
  } else if (docs.migrate) L.push('## Migrations', '', `**${docs.migrate.status.toUpperCase()}:** ${docs.migrate.stop_reason}`, '')
  const c = docs.census?.results
  if (c) {
    const a = c.aggregates
    L.push('## Census (read-only, aggregates only)', '')
    L.push(`Read-only proof: default_transaction_read_only=${c.read_only.default_transaction_read_only}, write probe refused with SQLSTATE ${c.read_only.write_probe_refused_sqlstate}. Reader links applied inside the copy: ${c.reader_stack.applied.length ? c.reader_stack.applied.map((x) => x.action).join('; ') : 'none (already present)'}.`, '')
    L.push('| Measure | Count |', '|---|---|')
    const rows = [
      ['Leads (eg_property_facts)', a.leads], ['Properties', a.properties], ['Unique contacts (distinct numbers, graph ∪ threads)', a.unique_contacts.distinct_numbers_total],
      ['SMS threads / with inbound / two-way', `${a.sms_conversations.threads} / ${a.sms_conversations.with_inbound} / ${a.sms_conversations.two_way}`],
      ['Messages in / out', `${a.sms_conversations.inbound_messages} / ${a.sms_conversations.outbound_messages}`],
      ['Seller spoke last (message log) / >24 h / >7 d / >30 d', `${a.unanswered_seller_messages.threads_seller_spoke_last} / ${a.unanswered_seller_messages.waiting_over_24h} / ${a.unanswered_seller_messages.waiting_over_7d} / ${a.unanswered_seller_messages.waiting_over_30d}`],
      ['… excluding opted-out / suppressed / wrong-number threads', a.unanswered_seller_messages.excluding_opted_out_suppressed_wrong_number],
      ['Interest stage labels', a.interest.interest_stage_labels],
      ['Inbound with a price / counter intent; with a dollar amount', `${a.asking_prices_and_counteroffers.inbound_with_price_intent}; ${a.asking_prices_and_counteroffers.inbound_with_dollar_amount}`],
      ['Opportunities with asking price / current offer', `${a.asking_prices_and_counteroffers.opportunities_with_asking_price} / ${a.asking_prices_and_counteroffers.opportunities_with_current_offer}`],
      ['Inbound callback requests', a.callbacks.inbound_callback_requests],
      ['Open negotiations / stalled 14 d / stalled 30 d', `${a.stalled_negotiations.open_negotiations} / ${a.stalled_negotiations.no_activity_14d} / ${a.stalled_negotiations.no_activity_30d}`],
      ['Threads warm or hot', a.warm_hot.threads_warm_or_hot],
      ['Threads missing a next action (seller spoke last)', `${a.missing_next_actions.threads} (${a.missing_next_actions.of_which_seller_spoke_last})`],
      ['Identity conflicts / suppression conflicts', `${a.duplicates_conflicts.identity_conflict_threads} / ${a.duplicates_conflicts.suppression_conflict_threads}`],
      ['Active suppression-list rows', a.suppression.suppression_list_active_rows],
      ['Eligibility: eligible / blocked / UNKNOWN', `${a.eligibility.eligible} / ${a.eligibility.blocked} / ${a.eligibility.unknown}`],
      ['Contactable (= eligible only; unknown counted as contactable)', `${a.eligibility.contactable} (${a.eligibility.unknown_counted_as_contactable})`],
    ]
    for (const [k, x] of rows) L.push(`| ${k} | ${typeof x === 'object' ? JSON.stringify(x) : x} |`)
    L.push('', `- Blocking reasons: ${JSON.stringify(a.eligibility.by_blocking_reason)}`, `- Unknown reasons: ${JSON.stringify(a.eligibility.by_unknown_reason)}`)
    L.push(`- Leads by market: ${JSON.stringify(a.concentration.leads_by_market)}; unanswered by market: ${JSON.stringify(a.concentration.unanswered_by_market)}`, `- Leads by ZIP (min cell ${a.concentration.zip_min_cell}): ${JSON.stringify(a.concentration.leads_by_zip_top25)}`)
    const cc = c.lc_mcp_corpus_census
    if (cc) L.push(`- lc_mcp_corpus_census: coverage ${JSON.stringify(cc.coverage)}; duplicates ${JSON.stringify(cc.duplicates)}; contact ${JSON.stringify(cc.contact)}; columns absent ${(cc.columns_absent || []).length}.`)
    L.push('')
  } else if (docs.census) L.push('## Census', '', `**${docs.census.status.toUpperCase()}:** ${docs.census.stop_reason}`, '')
  const h = docs['hidden-gold']?.results
  if (h) {
    L.push('## Hidden gold (read-only, opaque ids)', '')
    L.push(`Rule \`${h.rule}\` over the reader worklist (\`recent_inbound\`, ${h.parameters.window_days} days); ${h.analysed} thread(s) analysed in ${h.pages_read} page(s); excluded before ranking ${JSON.stringify(h.excluded_before_ranking)}; categories ${JSON.stringify(h.by_category)}.`, '')
    L.push(`Eligibility: eligible ${h.eligibility.eligible}, blocked ${h.eligibility.blocked}, UNKNOWN ${h.eligibility.unknown}; contactable ${h.eligibility.contactable} (unknown counted as contactable: ${h.eligibility.unknown_counted_as_contactable}).`, '')
    L.push('| Rank | Thread | Property | Category | Score | Eligibility | Contactable | Next step | Evidence message ids |', '|---|---|---|---|---|---|---|---|---|')
    for (const x of h.ranked.slice(0, 50)) L.push(`| ${x.rank} | \`${x.thread_id}\` | ${x.property_id == null ? '' : `\`${x.property_id}\``} | ${x.category} | ${x.score} | ${x.eligibility.verdict}${x.eligibility.verdict !== 'eligible' ? ` (${[...x.eligibility.blocking_reasons, ...x.eligibility.unknown_reasons].join(', ')})` : ''} | ${x.eligibility.contactable ? 'yes' : 'no'} | ${x.next_step} | ${x.evidence_message_ids.map((i) => `\`${i}\``).join(' ')} |`)
    L.push('', `- ${h.window_note}.`, '')
  } else if (docs['hidden-gold']) L.push('## Hidden gold', '', `**${docs['hidden-gold'].status.toUpperCase()}:** ${docs['hidden-gold'].stop_reason}`, '')
  const z = docs.destroy
  L.push('## Isolated database', '')
  L.push(z ? `- \`destroy\` ${z.status.toUpperCase()} at ${z.finished_at}: ${z.results ? `dropped ${z.results.dropped}, database gone ${z.results.database_gone}` : z.stop_reason}.` : '- Not destroyed yet: run `destroy` when the evidence is reviewed.', '')
  L.push('## What this does not prove', '')
  L.push('- Nothing here touched production: every step ran on the isolated local copy named above.', '- An eligible verdict is a read of the send-time guard\'s inputs, not an authorization to contact anyone; unknown is never contactable.', '- No message was sent, queued or drafted; no switch or grant was changed.')
  return `${L.join('\n')}\n`
}

async function cmdReport(ctx) {
  guardConnectedAll(ctx)
  const docs = {}
  for (const s of [...STEPS, 'guard', 'destroy']) docs[s] = ctx.read(s)
  const md = renderReport(docs, { title: ctx.title || 'Production-copy rehearsal' })
  const scrub = md.replace(/`[^`]*`/g, '``')
  assertNoPii(scrub, 'report.md')
  writeFileSecure(ctx.evidence('report.md'), md)
  ctx.log('report', `wrote ${ctx.evidence('report.md')}`)
  return md
}

// ════════════════════════════════════════════════════════════════════════════════════ guard / destroy ═══
async function cmdGuard(ctx) {
  return runStep(ctx, 'guard', async (doc) => ({ verdict: 'pass', checks: ['loopback / unix socket only (LC_DISPOSABLE_DB_HOST ignored)', 'no hosted / remote hint in the URL', 'database name lc_prodcopy_<tag>', 'server address loopback', 'no Supabase platform role on the server'], ...doc.guard }))
}
async function cmdDestroy(ctx) {
  return runStep(ctx, 'destroy', async () => {
    const existed = dbExists(ctx)
    if (existed) q(ctx.adminUrl, `drop database ${ctx.db} with (force)`)
    const gone = !dbExists(ctx)
    if (!gone) throw new Error(`${ctx.db} still exists`)
    return { existed, dropped: existed, database_gone: gone, note: 'evidence files are kept; delete any owner-only file separately' }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════════════════ CLI ═══
function parseArgs(argv) {
  const o = { _: [], excludeSchemas: [] }
  const flags = new Set(['--replace', '--force', '--fresh', '--include-text', '--no-default-excludes', '--strict-posttests', '--no-acl-pass'])
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (flags.has(a)) { o[a.slice(2)] = true; continue }
    if (a.startsWith('--')) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      if (a === '--exclude-schema') o.excludeSchemas.push(v)
      else o[a.slice(2)] = v
      i += 1
      continue
    }
    o._.push(a)
  }
  return o
}

export const USAGE = `usage: node scripts/db/prod-copy-rehearsal.mjs <guard|validate-backup|restore|prereqs|migrate|census|hidden-gold|report|destroy>
  --admin-url <postgres://…loopback…/postgres> --db lc_prodcopy_<tag> --out <evidence dir>
  [--file <backup>] [--pg-bin <dir>] [--jobs 2] [--replace] [--exclude-schema s]… [--no-default-excludes] [--no-acl-pass]
  [--strict-posttests] [--force] [--window-days 365] [--market "<market>"] [--top 200] [--min-cell 5] [--fresh]
  [--include-text  (OWNER-ONLY: writes seller text to hidden-gold.owner-only.jsonl, mode 0600; default off)] [--title "<report title>"]`

export async function main(argv = process.argv.slice(2)) {
  let o
  try { o = parseArgs(argv) } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2 }
  const cmd = o._[0]
  const cmds = { guard: cmdGuard, 'validate-backup': cmdValidateBackup, restore: cmdRestore, prereqs: cmdPrereqs, migrate: cmdMigrate, census: cmdCensus, 'hidden-gold': cmdHiddenGold, report: cmdReport, destroy: cmdDestroy }
  if (!cmds[cmd]) { console.error(USAGE); return 2 }
  if (o['pg-bin']) process.env.LC_PG_BIN = path.resolve(o['pg-bin'])
  if (!o['admin-url'] || !o.db || !o.out) { console.error(`--admin-url, --db and --out are required\n${USAGE}`); return 2 }
  try {
    guardTarget({ adminUrl: o['admin-url'], db: o.db })
  } catch (e) {
    console.error(`prod-copy-rehearsal: ${e.message}`)
    return 3
  }
  const ctx = new Ctx({
    adminUrl: o['admin-url'], db: o.db, out: path.resolve(o.out), prefix: PREFIX, file: o.file || null, jobs: Number(o.jobs || 2), replace: Boolean(o.replace), force: Boolean(o.force),
    fresh: Boolean(o.fresh), includeText: Boolean(o['include-text']), excludeSchemas: o.excludeSchemas, noDefaultExcludes: Boolean(o['no-default-excludes']), aclPass: !o['no-acl-pass'],
    strictPosttests: Boolean(o['strict-posttests']), windowDays: Number(o['window-days'] || 365), market: o.market || null, top: o.top ? Number(o.top) : 200, minCell: Number(o['min-cell'] || 5), title: o.title || null,
  })
  const r = await cmds[cmd](ctx)
  if (cmd === 'report') return 0
  return r.status === 'pass' ? 0 : r.status === 'stopped' ? 4 : r.status === 'refused' ? 3 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(`prod-copy-rehearsal: ${scrubText(e.message)}`); process.exitCode = 1 })
}
