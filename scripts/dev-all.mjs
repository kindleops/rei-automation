#!/usr/bin/env node

import { execSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = Number(process.env.DEV_ALL_API_PORT || 3000)
const DASHBOARD_PORT = Number(process.env.DEV_ALL_DASHBOARD_PORT || 5173)
const STOP_WAIT_MS = Number(process.env.DEV_ALL_STOP_WAIT_MS || 800)
const DASHBOARD_START_DELAY_MS = Number(process.env.DEV_ALL_DASHBOARD_START_DELAY_MS || 1000)

const children = []
let shuttingDown = false

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already exited
    }
  }

  await sleep(STOP_WAIT_MS)

  for (const pid of listPortPids(port)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already exited
    }
  }
}

function spawnWorkspace(name, workspace, script) {
  const child = spawn('npm', ['--workspace', workspace, 'run', script], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[dev:all] ${name} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
    void shutdown(typeof code === 'number' ? code : 1)
  })

  children.push({ name, child, workspace, script })
  return child
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
    if (!child.killed) {
      child.kill('SIGKILL')
    }
  }

  await stopPort(API_PORT, 'API')
  await stopPort(DASHBOARD_PORT, 'Dashboard')
  process.exit(exitCode)
}

async function main() {
  process.on('SIGINT', () => {
    void shutdown(0)
  })
  process.on('SIGTERM', () => {
    void shutdown(0)
  })

  await stopPort(API_PORT, 'API')
  await stopPort(DASHBOARD_PORT, 'Dashboard')

  console.log('[dev:all] Starting API and Dashboard from the same repo...')
  spawnWorkspace('API', 'apps/api', 'dev')
  await sleep(DASHBOARD_START_DELAY_MS)
  spawnWorkspace('Dashboard', 'apps/dashboard', 'dev')
  console.log(`[dev:all] API -> http://localhost:${API_PORT}`)
  console.log(`[dev:all] Dashboard -> http://localhost:${DASHBOARD_PORT}`)
  console.log('[dev:all] Press Ctrl+C to stop both servers.')
}

main().catch((error) => {
  console.error('[dev:all] Failed to start development servers:', error?.message || error)
  process.exit(1)
})