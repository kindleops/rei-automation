// The DISPOSABLE local stack of the Workforce × Agntei milestone E2E (docs/WORKFORCE-AGNTEI.md §6). Every process this
// module starts listens on 127.0.0.1 only and is stopped by stopAll(); every data directory lives under the run's own
// temporary folder. Nothing here can reach production: the database URL is checked by the repository's
// disposable-target guard, PostgREST connects to that database only, the Action MCP is given that PostgREST origin
// only, and Agntei runs with its own temporary data dir in isolated mode.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

import { assertDisposableTarget } from '../../../../../scripts/db/db-target-guard.mjs'

const procs = []
const servers = []
const cleanups = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A free loopback port (bound and released). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** Refuse anything that is not an http(s) loopback origin (every target this run talks to). */
export function assertLoopbackUrl(u, what = 'target') {
  const url = new URL(String(u))
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) throw new Error(`refusing non-loopback ${what}: ${url.host}`)
  return url
}

export function writeSecret(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, `${value}\n`, { mode: 0o600 })
  fs.chmodSync(p, 0o600)
  return p
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
/** An HS256 JWT (the PostgREST anon key of this disposable stack; the gateway token is minted by the owner script). */
export function hs256(secret, payload) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' })
  const body = b64url(payload)
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`
}

/** Spawn a long-running child; its output goes to a log file; it is killed by stopAll(). */
export function startProcess(name, cmd, args, { cwd, env, log }) {
  const out = fs.openSync(log, 'a')
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', out, out], detached: true })
  fs.closeSync(out)
  const rec = { name, child, log, exited: null }
  child.on('exit', (code, signal) => { rec.exited = { code, signal, at: Date.now() } })
  procs.push(rec)
  return rec
}

export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 250, what = 'condition' } = {}) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v } catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}

export async function httpOk(url, init = {}) {
  const r = await fetch(url, init)
  await r.arrayBuffer().catch(() => {})
  return r.status < 500
}

// ── PostgreSQL 17 (its own cluster) ──────────────────────────────────────────
export async function startPg({ bin, dir, log }) {
  const port = await freePort()
  const data = path.join(dir, 'pgdata')
  fs.mkdirSync(dir, { recursive: true })
  const init = spawnSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`initdb failed: ${(init.stderr || init.stdout || '').slice(-400)}`)
  const opts = `-c listen_addresses=127.0.0.1 -p ${port} -c unix_socket_directories=${dir} -c max_connections=120 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=64MB`
  const st = spawnSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', log, '-o', opts, '-w', '-t', '120', 'start'], { encoding: 'utf8' })
  if (st.status !== 0) throw new Error(`pg_ctl start failed: ${(st.stderr || st.stdout || '').slice(-400)}`)
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`
  assertDisposableTarget(adminUrl)
  cleanups.push(() => { spawnSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '60', 'stop'], { encoding: 'utf8' }) })
  return { port, adminUrl, data }
}

// ── PostgREST (the real binary) + the /rest/v1 path shim ──────────────────────
export async function startPostgrest({ bin, dbUrl, jwtSecret, dir, log }) {
  assertDisposableTarget(dbUrl)
  const port = await freePort()
  const conf = path.join(dir, 'postgrest.conf')
  fs.writeFileSync(conf, [
    `db-uri = "${dbUrl}"`, 'db-schemas = "public"', 'db-anon-role = "anon"', `jwt-secret = "${jwtSecret}"`, 'jwt-secret-is-base64 = false',
    'server-host = "127.0.0.1"', `server-port = ${port}`, 'db-pool = 4', 'db-channel-enabled = true', 'log-level = "warn"', 'db-plan-enabled = false',
  ].join('\n') + '\n', { mode: 0o600 })
  const rec = startProcess('postgrest', bin, [conf], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, log })
  const url = `http://127.0.0.1:${port}`
  await waitFor(() => httpOk(`${url}/`), { what: 'PostgREST', timeoutMs: 60_000 })
  return { port, url, rec }
}

/**
 * Supabase serves PostgREST under /rest/v1 behind its API gateway (Kong). This disposable stack has no Kong: a
 * loopback path-rewrite proxy stands in for exactly that one rule (/rest/v1/<x> → PostgREST /<x>, headers and body
 * untouched). SYNTHETIC infrastructure, labelled as such in the report. Everything else is a 404.
 */
export async function startRestShim({ upstream }) {
  const up = assertLoopbackUrl(upstream, 'PostgREST upstream')
  const port = await freePort()
  const hits = { rest: 0, refused: 0 }
  const srv = http.createServer((req, res) => {
    if (!req.url.startsWith('/rest/v1/')) { hits.refused += 1; res.writeHead(404); return res.end() }
    hits.rest += 1
    const target = new URL(req.url.slice('/rest/v1'.length), up)
    const headers = { ...req.headers, host: up.host }
    const p = http.request(target, { method: req.method, headers }, (u) => { res.writeHead(u.statusCode || 502, u.headers); u.pipe(res) })
    p.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(p)
  })
  await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  servers.push(srv)
  return { port, url: `http://127.0.0.1:${port}`, hits }
}

// ── The REAL Action MCP (bin/leadcommand-action-mcp.mjs), streamable-http on loopback ──────────────
export async function startActionMcp({ repo, node, files, orgId, dir, log, auditFile }) {
  const port = await freePort()
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR || '/tmp',
    LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: String(port),
    LEADCOMMAND_ACTION_MCP_ORG_ID: orgId, LEADCOMMAND_ACTION_MCP_SUPABASE_URL: files.supabaseUrl,
    LEADCOMMAND_ACTION_MCP_API_KEY_FILE: files.apiKey, LEADCOMMAND_ACTION_MCP_GATEWAY_JWT_FILE: files.gatewayJwt, LEADCOMMAND_ACTION_MCP_PEPPER_FILE: files.pepper,
    LEADCOMMAND_ACTION_MCP_WORKFORCE_ENABLED: 'true', LEADCOMMAND_ACTION_MCP_AUDIT_FILE: auditFile, LEADCOMMAND_ACTION_MCP_WORKER_ID: 'action-mcp-e2e',
    LEADCOMMAND_ACTION_MCP_RECOVERY_INTERVAL_MS: '20000',
  }
  const cwd = path.join(repo, 'mcp/leadcommand-action-mcp')
  const rec = startProcess('action-mcp', node, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'bin/leadcommand-action-mcp.mjs'], { cwd, env, log })
  const url = `http://127.0.0.1:${port}/mcp`
  await waitFor(async () => {
    if (rec.exited) throw new Error(`the Action MCP exited (${JSON.stringify(rec.exited)}): ${fs.readFileSync(log, 'utf8').slice(-600)}`)
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }).catch(() => null)
    if (r) await r.arrayBuffer().catch(() => {})
    return r && r.status === 401 // up, and refusing an unauthenticated request
  }, { what: 'the Action MCP', timeoutMs: 90_000 })
  return { port, url, rec }
}

// ── Agntei, headless (apps/server/src/main.ts), its own temporary data dir, isolated mode ──────────
/**
 * Agntei's real data folders (its packages/engine/src/core/data-guard.ts list): the installed app's ~/.agent-command,
 * the development build's ~/.agent-command-dev and the app's Application Support folders — for $HOME and for the
 * account's real home (a changed HOME does not move them).
 */
export function agnteiRealDataDirs() {
  const homes = [...new Set([process.env.HOME, os.homedir(), (() => { try { return os.userInfo().homedir } catch { return null } })()].filter((h) => h && path.isAbsolute(h)))]
  return homes.flatMap((h) => ['.agent-command', '.agent-command-dev', ...['agntei', 'agntei-dev', 'Agent Command', 'agent-command'].map((a) => path.join('Library', 'Application Support', a))].map((d) => path.join(h, d)))
}
/** The path with every existing leading part resolved through symlinks (macOS /var → /private/var, a link into a data folder). */
function canonical(p) {
  let head = path.resolve(p); const tail = []
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail.reverse()) } catch { /* not there yet */ }
    const up = path.dirname(head); if (up === head) return path.resolve(p)
    tail.push(path.basename(head)); head = up
  }
}
const inside = (child, parent) => { const c = canonical(child).toLowerCase(); const p = canonical(parent).toLowerCase(); return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep) }
/** Throws if `p` is inside one of Agntei's real data folders. */
export function refuseAgnteiRealData(p) {
  const hit = agnteiRealDataDirs().find((d) => inside(p, d))
  if (hit) throw new Error(`refusing to run Agntei on ${p}: ${hit} is real Agntei data`)
  return p
}
/** Cleanup is restricted to what the run made: `p` must be strictly inside `root` (e.g. the system temp dir for a mkdtemp run folder) and not real data. */
export function assertRunOwned(p, root) {
  if (!root || !path.isAbsolute(root) || canonical(p) === canonical(root) || !inside(p, root)) throw new Error(`refusing to remove ${p}: not strictly inside ${root}`)
  refuseAgnteiRealData(p)
  return p
}

export async function startAgntei({ agnteiDir, node, home, token, claudeBin, log, extraEnv = {} }) {
  const port = await freePort()
  // Agntei's own engine refuses real data in a test context too (AGNTEI_TEST_ENV=1 / AGNTAU_DISPOSABLE=1, Agntei 4.9.1);
  // this check runs first so nothing — not even the folder below — is created there.
  refuseAgnteiRealData(home)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const env = {
    PATH: `${path.dirname(node)}:${process.env.PATH}`, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8',
    AGENT_COMMAND_HOME: home, AGENT_COMMAND_TOKEN: token, AGNTEI_ISOLATED: '1', AGNTAU_DISPOSABLE: '1', AGNTEI_TEST_ENV: '1', AGENT_COMMAND_CLAUDE_BIN: claudeBin, PORT: String(port),
    // the live milestone: AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS=1 (Agntei's supported opt-in to the default Claude Code login)
    ...extraEnv,
  }
  const tsx = path.join(agnteiDir, 'node_modules/tsx/dist/cli.mjs')
  const rec = startProcess('agntei', node, [tsx, 'apps/server/src/main.ts'], { cwd: agnteiDir, env, log })
  const url = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    if (rec.exited) throw new Error(`Agntei exited (${JSON.stringify(rec.exited)}): ${fs.readFileSync(log, 'utf8').slice(-800)}`)
    const r = await fetch(`${url}/api/health`, { headers: { 'x-agentcmd-token': token } }).catch(() => null)
    if (r) await r.arrayBuffer().catch(() => {})
    return r && r.status === 200
  }, { what: 'the Agntei server', timeoutMs: 180_000, intervalMs: 500 })
  return { port, url, rec, token }
}

/** Kill one child (its process group): SIGTERM, then SIGKILL. */
export async function stopProcess(rec, { graceMs = 5000 } = {}) {
  if (!rec || rec.exited) return
  try { process.kill(-rec.child.pid, 'SIGTERM') } catch { try { rec.child.kill('SIGTERM') } catch { /* gone */ } }
  const t0 = Date.now()
  while (!rec.exited && Date.now() - t0 < graceMs) await sleep(100)
  if (!rec.exited) { try { process.kill(-rec.child.pid, 'SIGKILL') } catch { try { rec.child.kill('SIGKILL') } catch { /* gone */ } } }
  const t1 = Date.now()
  while (!rec.exited && Date.now() - t1 < 3000) await sleep(100)
}

export function onCleanup(fn) { cleanups.push(fn) }

/** Stop every process and server this module started, then the cluster (reverse order). */
export async function stopAll() {
  for (const rec of [...procs].reverse()) await stopProcess(rec).catch(() => {})
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r())).catch(() => {})
  for (const fn of cleanups.splice(0).reverse()) { try { await fn() } catch { /* best effort */ } }
  procs.length = 0
}
export const running = () => procs.filter((p) => !p.exited).map((p) => ({ name: p.name, pid: p.child.pid }))
