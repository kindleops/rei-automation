#!/usr/bin/env node
/**
 * Nexus dev supervisor — API and Dashboard are independent lifecycles.
 * API restarts (build-pause, crash) must never terminate Vite on :5173.
 */

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILES = [
  path.join(ROOT, 'apps/api/.env.local'),
  path.join(ROOT, 'apps/dashboard/.env.local'),
  path.join(ROOT, '.env.local'),
]

for (const file of ENV_FILES) {
  if (!fs.existsSync(file)) continue
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = normalized.indexOf('=')
    if (eq <= 0) continue
    const key = normalized.slice(0, eq).trim()
    let value = normalized.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

const API_PORT = Number(process.env.DEV_ALL_API_PORT || 3000)
const DASHBOARD_PORT = Number(process.env.DEV_ALL_DASHBOARD_PORT || 5173)
const STOP_WAIT_MS = Number(process.env.DEV_ALL_STOP_WAIT_MS || 800)
const DASHBOARD_START_DELAY_MS = Number(process.env.DEV_ALL_DASHBOARD_START_DELAY_MS || 1500)
const API_HEALTH_TIMEOUT_MS = Number(process.env.DEV_ALL_API_HEALTH_TIMEOUT_MS || 120_000)
const API_HEALTH_INTERVAL_MS = Number(process.env.DEV_ALL_API_HEALTH_INTERVAL_MS || 500)
const DASHBOARD_HEALTH_TIMEOUT_MS = Number(process.env.DEV_ALL_DASHBOARD_HEALTH_TIMEOUT_MS || 120_000)
const DASHBOARD_HEALTH_INTERVAL_MS = Number(process.env.DEV_ALL_DASHBOARD_HEALTH_INTERVAL_MS || 500)
const MAX_API_RESTARTS = Number(process.env.DEV_ALL_MAX_API_RESTARTS || 8)
const LOCK_DIR = path.join(ROOT, '.dev-all')
const LOCK_FILE = path.join(LOCK_DIR, 'supervisor.lock.json')
const BUILD_PAUSE_FILE = path.join(LOCK_DIR, 'build-pause.json')
const EXIT_LOG_FILE = path.join(LOCK_DIR, 'child-exit.log.jsonl')
const VITE_CACHE_DIR = path.join(ROOT, 'apps/dashboard/node_modules/.vite')
const DASHBOARD_ROOT = path.join(ROOT, 'apps/dashboard')
const VITE_BIN = path.join(ROOT, 'node_modules/.bin/vite')

const children = new Map()
let shuttingDown = false
let apiRestartCount = 0
let dashboardRestartCount = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readGitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function listPortPids(port) {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return [...new Set(
      output
        .split(/\r?\n/)
        .map((value) => Number(value.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid),
    )]
  } catch {
    return []
  }
}

function readProcessDiagnostics(pid) {
  if (!pid) return {}
  try {
    const ps = execSync(`ps -o pid=,ppid=,pgid=,rss=,vsz=,etime=,command= -p ${pid}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return { ps }
  } catch {
    return {}
  }
}

function logChildExit(name, child, code, signal) {
  const entry = {
    at: new Date().toISOString(),
    name,
    pid: child?.pid ?? null,
    exitCode: code,
    signal: signal ?? null,
    supervisorPid: process.pid,
    buildPauseActive: isBuildPauseActive(),
    ...readProcessDiagnostics(child?.pid),
  }
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true })
    fs.appendFileSync(EXIT_LOG_FILE, `${JSON.stringify(entry)}\n`)
  } catch {
    // ignore
  }
  console.error(`[dev:all] ${name} child exit diagnostics:`, JSON.stringify(entry))
}

async function stopStrayApiPorts() {
  for (const port of [3001, 3002]) {
    const pids = listPortPids(port)
    if (!pids.length) continue
    console.log(`[dev:all] Stopping stray API listener(s) on port ${port}: ${pids.join(', ')}`)
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
    }
  }
}

async function stopApiPortOnly() {
  const pids = listPortPids(API_PORT)
  if (!pids.length) return
  console.log(`[dev:all] Stopping API listener(s) on port ${API_PORT}: ${pids.join(', ')}`)
  for (const pid of pids) {
    if (listPortPids(DASHBOARD_PORT).includes(pid)) {
      console.warn(`[dev:all] Skipping pid ${pid} — also owns Dashboard port ${DASHBOARD_PORT}`)
      continue
    }
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }
  await sleep(STOP_WAIT_MS)
  for (const pid of listPortPids(API_PORT)) {
    if (listPortPids(DASHBOARD_PORT).includes(pid)) continue
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
}

async function stopDashboardPortOnly() {
  const pids = listPortPids(DASHBOARD_PORT)
  if (!pids.length) return
  console.log(`[dev:all] Stopping Dashboard listener(s) on port ${DASHBOARD_PORT}: ${pids.join(', ')}`)
  for (const pid of pids) {
    if (listPortPids(API_PORT).includes(pid) && !listPortPids(DASHBOARD_PORT).includes(pid)) continue
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }
  await sleep(STOP_WAIT_MS)
  for (const pid of listPortPids(DASHBOARD_PORT)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
}

function isBuildPauseActive() {
  return fs.existsSync(BUILD_PAUSE_FILE)
}

function acquireLock() {
  fs.mkdirSync(LOCK_DIR, { recursive: true })
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
      if (existing.pid) {
        try {
          process.kill(existing.pid, 0)
          const ageMs = Date.now() - Number(existing.started_at_ms || 0)
          if (ageMs < 60_000) {
            console.error(`[dev:all] Another supervisor is running (pid=${existing.pid}). Stop it first.`)
            process.exit(1)
          }
        } catch {
          // stale
        }
      }
    } catch {
      // corrupt lock
    }
  }
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify({
    pid: process.pid,
    started_at_ms: Date.now(),
    commit_sha: readGitSha(),
  })}\n`)
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE) } catch { /* ignore */ }
}

function clearViteCache() {
  if (!fs.existsSync(VITE_CACHE_DIR)) return
  try {
    fs.rmSync(VITE_CACHE_DIR, { recursive: true, force: true })
    console.log('[dev:all] Cleared Vite dependency cache')
  } catch (error) {
    console.warn(`[dev:all] Failed to clear Vite cache: ${error?.message || error}`)
  }
}

async function verifyApiHealth() {
  const headers = { accept: 'application/json' }
  const opsSecret =
    process.env.OPS_DASHBOARD_SECRET ||
    process.env.VITE_OPS_DASHBOARD_SECRET ||
    process.env.VITE_BACKEND_API_SECRET ||
    ''
  if (opsSecret) headers['x-ops-dashboard-secret'] = opsSecret
  const response = await fetch(`http://127.0.0.1:${API_PORT}/api/cockpit/health`, {
    headers,
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) return false
  const json = await response.json()
  return json?.ok === true || json?.status === 'ok'
}

async function waitForApiHealth() {
  const deadline = Date.now() + API_HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (await verifyApiHealth()) return true
    } catch { /* retry */ }
    await sleep(API_HEALTH_INTERVAL_MS)
  }
  return false
}

function buildOpsAuthHeaders() {
  const headers = { accept: 'application/json' }
  const opsSecret =
    process.env.OPS_DASHBOARD_SECRET ||
    process.env.VITE_OPS_DASHBOARD_SECRET ||
    process.env.VITE_BACKEND_API_SECRET ||
    ''
  if (opsSecret) headers['x-ops-dashboard-secret'] = opsSecret
  return headers
}

async function warmupApiRoutes() {
  const headers = buildOpsAuthHeaders()
  const warmups = [
    `/api/cockpit/inbox/live?filter=all&direction=all&cursor=0&limit=25&map=0&timeout_mode=initial_boot&refresh_reason=dev_warmup`,
    `/api/cockpit/inbox/counts`,
    `/api/cockpit/dev/runtime-identity`,
  ]
  for (const routePath of warmups) {
    const url = `http://127.0.0.1:${API_PORT}${routePath}`
    try {
      const response = await fetch(url, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(90_000),
      })
      console.log(`[dev:all] Warmed ${routePath} -> ${response.status}`)
    } catch (error) {
      console.warn(`[dev:all] Warmup failed for ${routePath}:`, error?.message || error)
    }
  }
}

async function verifyDashboardDevRuntime() {
  const base = `http://127.0.0.1:${DASHBOARD_PORT}`
  const htmlResponse = await fetch(base, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!htmlResponse.ok) return false
  const html = await htmlResponse.text()
  if (!html.includes('$RefreshSig$') || !html.includes('/@react-refresh') || !html.includes('/@vite/client')) {
    return false
  }
  const clientResponse = await fetch(`${base}/@vite/client`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!clientResponse.ok) return false
  const refreshResponse = await fetch(`${base}/@react-refresh`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!refreshResponse.ok) return false
  const moduleResponse = await fetch(`${base}/src/components/auth/AuthProvider.tsx`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
  if (!moduleResponse.ok) return false
  return (await moduleResponse.text()).includes('$RefreshSig$')
}

async function waitForDashboardDevRuntime() {
  const deadline = Date.now() + DASHBOARD_HEALTH_TIMEOUT_MS
  let consecutive = 0
  while (Date.now() < deadline) {
    try {
      if (await verifyDashboardDevRuntime()) {
        consecutive += 1
        if (consecutive >= 2) return true
      } else {
        consecutive = 0
      }
    } catch {
      consecutive = 0
    }
    await sleep(DASHBOARD_HEALTH_INTERVAL_MS)
  }
  return false
}

function isDashboardPortListening() {
  return listPortPids(DASHBOARD_PORT).length > 0
}

function spawnWorkspace(name, workspace, script, { detached = false } = {}) {
  const childEnv = { ...process.env, NODE_ENV: 'development', FORCE_COLOR: '1' }
  if (name === 'API') {
    childEnv.PORT = String(API_PORT)
  }
  const child = spawn('npm', ['--workspace', workspace, 'run', script], {
    cwd: ROOT,
    stdio: 'inherit',
    detached,
    env: childEnv,
  })

  if (detached && child.pid) {
    child.unref()
  }

  child.on('exit', (code, signal) => {
    logChildExit(name, child, code, signal)
    if (shuttingDown) return
    void handleChildExit(name, code, signal)
  })

  children.set(name, child)
  return child
}

function spawnDashboardVite() {
  const child = spawn(process.execPath, [VITE_BIN], {
    cwd: DASHBOARD_ROOT,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, NODE_ENV: 'development', FORCE_COLOR: '1' },
  })

  if (child.pid && process.platform !== 'win32') {
    // New session — Vite cannot receive signals sent to the supervisor/API npm group.
    try { process.kill(-child.pid, 0) } catch {
      try { process.kill(child.pid, 0) } catch { /* ignore */ }
    }
    child.unref()
  }

  child.on('exit', (code, signal) => {
    logChildExit('Dashboard', child, code, signal)
    if (shuttingDown) return
    void handleChildExit('Dashboard', code, signal)
  })

  children.set('Dashboard', child)
  return child
}

async function handleChildExit(name, code, signal) {
  if (name === 'API') {
    if (isBuildPauseActive()) {
      console.log('[dev:all] API stopped for production build — Dashboard stays alive; waiting for build-pause clear...')
      void watchBuildPauseAndRestartApi()
      return
    }
    if (apiRestartCount < MAX_API_RESTARTS) {
      apiRestartCount += 1
      console.log(`[dev:all] Restarting API only (${apiRestartCount}/${MAX_API_RESTARTS}); Dashboard untouched`)
      await restartApiOnly()
      return
    }
    console.error('[dev:all] API exceeded restart budget; Dashboard continues running')
    return
  }

  if (name === 'Dashboard') {
    if (isBuildPauseActive() && isDashboardPortListening()) {
      console.log('[dev:all] Dashboard wrapper exited during API build but Vite still listening — no restart')
      return
    }
    if (dashboardRestartCount < 3) {
      dashboardRestartCount += 1
      console.log(`[dev:all] Restarting Dashboard only (${dashboardRestartCount}/3); API untouched`)
      await restartDashboardOnly()
      return
    }
    console.error('[dev:all] Dashboard exceeded restart budget')
  }
}

async function restartApiOnly() {
  await stopApiPortOnly()
  spawnWorkspace('API', 'apps/api', 'dev')
  const healthy = await waitForApiHealth()
  console.log(healthy ? '[dev:all] API recovered' : '[dev:all] API failed health gate after restart')
  if (healthy) apiRestartCount = 0
}

async function watchBuildPauseAndRestartApi() {
  while (!shuttingDown && isBuildPauseActive()) {
    await sleep(1000)
  }
  if (shuttingDown) return
  apiRestartCount = 0
  console.log('[dev:all] Build pause cleared — restarting API once (Dashboard unchanged)')
  await restartApiOnly()
}

async function restartDashboardOnly() {
  const apiPids = listPortPids(API_PORT)
  await stopDashboardPortOnly()
  clearViteCache()
  await sleep(DASHBOARD_START_DELAY_MS)
  spawnDashboardVite()
  const ready = await waitForDashboardDevRuntime()
  console.log(ready ? '[dev:all] Dashboard dev runtime recovered' : '[dev:all] Dashboard failed dev runtime gate')
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[dev:all] Shutting down API and Dashboard...')
  for (const [name, child] of children.entries()) {
    if (!child.killed) {
      console.log(`[dev:all] Stopping ${name}...`)
      child.kill('SIGTERM')
    }
  }
  await sleep(STOP_WAIT_MS)
  await stopApiPortOnly()
  await stopDashboardPortOnly()
  releaseLock()
  process.exit(exitCode)
}

async function main() {
  process.on('SIGINT', () => { void shutdown(0) })
  process.on('SIGTERM', () => { void shutdown(0) })

  acquireLock()
  await stopApiPortOnly()
  await stopStrayApiPorts()
  await stopDashboardPortOnly()

  console.log(`[dev:all] Starting API and Dashboard (sha=${readGitSha()})...`)
  spawnWorkspace('API', 'apps/api', 'dev')

  console.log('[dev:all] Waiting for API health...')
  if (!(await waitForApiHealth())) {
    console.error('[dev:all] API failed health gate')
    await shutdown(1)
  }
  console.log('[dev:all] API healthy')
  console.log('[dev:all] Pre-warming inbox and cockpit routes...')
  await warmupApiRoutes()

  await sleep(DASHBOARD_START_DELAY_MS)
  spawnDashboardVite()

  console.log('[dev:all] Waiting for Dashboard React Refresh runtime...')
  if (!(await waitForDashboardDevRuntime())) {
    console.error('[dev:all] Dashboard failed dev runtime gate')
    await shutdown(1)
  }

  const dashPid = listPortPids(DASHBOARD_PORT)[0] ?? null
  console.log('[dev:all] Ready')
  console.log(`[dev:all] API -> http://localhost:${API_PORT}`)
  console.log(`[dev:all] Dashboard -> http://localhost:${DASHBOARD_PORT} (vite pid=${dashPid ?? 'unknown'})`)
  console.log('[dev:all] Press Ctrl+C to stop both servers.')
}

main().catch(async (error) => {
  console.error('[dev:all] Failed to start development servers:', error?.message || error)
  await shutdown(1)
})