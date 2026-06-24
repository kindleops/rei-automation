#!/usr/bin/env node
/**
 * Nexus local dev supervisor — single API + Dashboard process tree with health gates.
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
const MAX_API_RESTARTS = Number(process.env.DEV_ALL_MAX_API_RESTARTS || 5)
const LOCK_DIR = path.join(ROOT, '.dev-all')
const LOCK_FILE = path.join(LOCK_DIR, 'supervisor.lock.json')
const BUILD_PAUSE_FILE = path.join(LOCK_DIR, 'build-pause.json')
const VITE_CACHE_DIR = path.join(ROOT, 'apps/dashboard/node_modules/.vite')

const children = []
let shuttingDown = false
let apiRestartCount = 0

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

async function stopPort(port, label) {
  const pids = listPortPids(port)
  if (!pids.length) return
  console.log(`[dev:all] Stopping stale ${label} listener(s) on port ${port}: ${pids.join(', ')}`)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
  }
  await sleep(STOP_WAIT_MS)
  for (const pid of listPortPids(port)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
}

function isBuildPauseActive() {
  return fs.existsSync(BUILD_PAUSE_FILE)
}

function readBuildPause() {
  if (!fs.existsSync(BUILD_PAUSE_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(BUILD_PAUSE_FILE, 'utf8'))
  } catch {
    return { since: null, pid: null }
  }
}

function acquireLock() {
  fs.mkdirSync(LOCK_DIR, { recursive: true })
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
      const ageMs = Date.now() - Number(existing.started_at_ms || 0)
      if (existing.pid && ageMs < 30_000) {
        try {
          process.kill(existing.pid, 0)
          console.error(`[dev:all] Another supervisor is running (pid=${existing.pid}). Stop it first.`)
          process.exit(1)
        } catch {
          // stale lock
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
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('json')) return false
  const json = await response.json()
  return json?.ok === true || json?.status === 'ok' || response.ok
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

async function verifyDashboardDevRuntime() {
  const base = `http://127.0.0.1:${DASHBOARD_PORT}`
  const htmlResponse = await fetch(base, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!htmlResponse.ok) return false
  const html = await htmlResponse.text()
  if (!html.includes('$RefreshSig$') || !html.includes('/@react-refresh')) return false
  if (!html.includes('/@vite/client')) return false

  const clientResponse = await fetch(`${base}/@vite/client`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!clientResponse.ok) return false

  const refreshResponse = await fetch(`${base}/@react-refresh`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!refreshResponse.ok) return false
  const refreshBody = await refreshResponse.text()
  if (!refreshBody.includes('injectIntoGlobalHook')) return false

  const moduleResponse = await fetch(`${base}/src/components/auth/AuthProvider.tsx`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
  if (!moduleResponse.ok) return false
  const moduleBody = await moduleResponse.text()
  return moduleBody.includes('$RefreshSig$')
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

function spawnWorkspace(name, workspace, script) {
  const child = spawn('npm', ['--workspace', workspace, 'run', script], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', FORCE_COLOR: '1' },
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return

    if (name === 'API' && isBuildPauseActive()) {
      const pause = readBuildPause()
      console.log(`[dev:all] API stopped for production build (build-pause pid=${pause?.pid || 'unknown'}) — waiting...`)
      void watchBuildPauseAndRestartApi()
      return
    }

    console.error(`[dev:all] ${name} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
    if (name === 'API' && apiRestartCount < MAX_API_RESTARTS) {
      apiRestartCount += 1
      console.log(`[dev:all] Restarting API (${apiRestartCount}/${MAX_API_RESTARTS})...`)
      spawnWorkspace('API', 'apps/api', 'dev')
      return
    }
    void shutdown(typeof code === 'number' ? code : 1)
  })

  children.push({ name, child, workspace, script })
  return child
}

async function watchBuildPauseAndRestartApi() {
  while (!shuttingDown && isBuildPauseActive()) {
    await sleep(1000)
  }
  if (shuttingDown) return
  apiRestartCount = 0
  console.log('[dev:all] Build pause cleared — restarting API once')
  await stopPort(API_PORT, 'API')
  spawnWorkspace('API', 'apps/api', 'dev')
  const healthy = await waitForApiHealth()
  console.log(healthy ? '[dev:all] API recovered after build pause' : '[dev:all] API failed to recover after build pause')
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[dev:all] Shutting down API and Dashboard...')
  for (const { name, child } of children) {
    if (!child.killed) {
      console.log(`[dev:all] Stopping ${name}...`)
      child.kill('SIGTERM')
    }
  }
  await sleep(STOP_WAIT_MS)
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGKILL')
  }
  await stopPort(API_PORT, 'API')
  await stopPort(DASHBOARD_PORT, 'Dashboard')
  releaseLock()
  process.exit(exitCode)
}

async function main() {
  process.on('SIGINT', () => { void shutdown(0) })
  process.on('SIGTERM', () => { void shutdown(0) })

  acquireLock()
  await stopPort(API_PORT, 'API')
  await stopPort(DASHBOARD_PORT, 'Dashboard')

  console.log(`[dev:all] Starting API and Dashboard (sha=${readGitSha()})...`)
  spawnWorkspace('API', 'apps/api', 'dev')

  console.log('[dev:all] Waiting for API health...')
  const apiReady = await waitForApiHealth()
  if (!apiReady) {
    console.error('[dev:all] API failed health gate')
    await shutdown(1)
  }
  console.log('[dev:all] API healthy')

  await sleep(DASHBOARD_START_DELAY_MS)
  spawnWorkspace('Dashboard', 'apps/dashboard', 'dev')

  console.log('[dev:all] Waiting for Dashboard React Refresh runtime...')
  const dashboardReady = await waitForDashboardDevRuntime()
  if (!dashboardReady) {
    console.error('[dev:all] Dashboard failed dev runtime gate')
    await shutdown(1)
  }

  console.log('[dev:all] Ready')
  console.log(`[dev:all] API -> http://localhost:${API_PORT}`)
  console.log(`[dev:all] Dashboard -> http://localhost:${DASHBOARD_PORT}`)
  console.log('[dev:all] Press Ctrl+C to stop both servers.')
}

main().catch(async (error) => {
  console.error('[dev:all] Failed to start development servers:', error?.message || error)
  await shutdown(1)
})