#!/usr/bin/env node

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BUILD_PAUSE_FILE = path.join(ROOT, '.dev-all/build-pause.json')
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

const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  ''

let failures = 0

function fail(label, detail = '') {
  failures += 1
  console.error(`FAIL ${label}${detail ? ` ${detail}` : ''}`)
}

function pass(label, detail = '') {
  console.log(`PASS ${label}${detail ? ` ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function countListeners(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' })
    return [...new Set(out.split(/\r?\n/).map((v) => Number(v.trim())).filter((n) => n > 0))]
  } catch {
    return []
  }
}

async function waitFor(fn, timeoutMs = 180_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true
    } catch { /* retry */ }
    await sleep(intervalMs)
  }
  return false
}

async function apiHealthy() {
  const headers = { accept: 'application/json' }
  if (OPS_SECRET) headers['x-ops-dashboard-secret'] = OPS_SECRET
  const response = await fetch('http://127.0.0.1:3000/api/cockpit/health', { headers, signal: AbortSignal.timeout(5000) })
  if (!response.ok) return false
  const json = await response.json()
  return json?.ok === true || json?.status === 'ok'
}

async function dashboardHealthy() {
  const html = await (await fetch('http://127.0.0.1:5173/', { cache: 'no-store' })).text()
  return html.includes('$RefreshSig$') && html.includes('/@react-refresh')
}

async function main() {
  const apiPidsBefore = countListeners(3000)
  const dashPidsBefore = countListeners(5173)
  pass('precondition API listener', `pids=${apiPidsBefore.join(',') || 'none'}`)
  pass('precondition Dashboard listener', `pids=${dashPidsBefore.join(',') || 'none'}`)

  if (apiPidsBefore.length === 0) fail('dev:all must already be running on :3000')
  if (dashPidsBefore.length === 0) fail('dev:all must already be running on :5173')
  if (dashPidsBefore.length > 1) fail('duplicate Vite listeners', dashPidsBefore.join(','))

  const buildStarted = Date.now()
  const build = spawn('node', ['scripts/build-api-production.mjs'], { cwd: ROOT, stdio: 'inherit' })
  await new Promise((resolve, reject) => {
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))))
  })

  const buildMs = Date.now() - buildStarted
  pass('production API build completed', `${buildMs}ms`)

  if (fs.existsSync(BUILD_PAUSE_FILE)) fail('build-pause file should be cleared after build')
  else pass('build-pause cleared')

  const apiRecovered = await waitFor(apiHealthy, 180_000)
  if (!apiRecovered) fail('API health after build')
  else pass('API health after build')

  const dashRecovered = await waitFor(dashboardHealthy, 30_000)
  if (!dashRecovered) fail('Dashboard React Refresh after build')
  else pass('Dashboard React Refresh after build')

  const apiPidsAfter = countListeners(3000)
  const dashPidsAfter = countListeners(5173)
  if (dashPidsAfter.length > 1) fail('duplicate Vite after build', dashPidsAfter.join(','))
  else pass('single Vite listener after build', dashPidsAfter.join(',') || 'none')

  const nextCount = apiPidsAfter.length
  if (nextCount > 2) fail('too many API listeners after build', apiPidsAfter.join(','))
  else pass('API listener count stable', `pids=${apiPidsAfter.join(',')}`)

  if (failures > 0) {
    console.error(`FAIL build-while-dev-proof failures=${failures}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ build_ms: buildMs, api_pids_after: apiPidsAfter, dash_pids_after: dashPidsAfter }, null, 2))
  console.log('PASS build-while-dev-proof')
}

main().catch((error) => {
  console.error('FAIL build-while-dev-proof crashed', error?.message || error)
  process.exit(1)
})