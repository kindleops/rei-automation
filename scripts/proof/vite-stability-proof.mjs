#!/usr/bin/env node
/**
 * Proves Vite stays alive through API production build + forced API restart.
 * Default duration: 15 minutes (override with VITE_STABILITY_MINUTES).
 */

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MINUTES = Number(process.env.VITE_STABILITY_MINUTES || 15)
const DASHBOARD_PORT = Number(process.env.DEV_ALL_DASHBOARD_PORT || 5173)
const API_PORT = Number(process.env.DEV_ALL_API_PORT || 3000)
const timeline = []
let failures = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function vitePid() {
  try {
    const out = execSync(`lsof -nP -iTCP:${DASHBOARD_PORT} -sTCP:LISTEN -t`, { encoding: 'utf8' })
    return Number(out.trim().split(/\r?\n/)[0]) || null
  } catch {
    return null
  }
}

function apiPid() {
  try {
    const out = execSync(`lsof -nP -iTCP:${API_PORT} -sTCP:LISTEN -t`, { encoding: 'utf8' })
    return Number(out.trim().split(/\r?\n/)[0]) || null
  } catch {
    return null
  }
}

async function dashboardUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

function log(event, extra = {}) {
  const entry = { at: new Date().toISOString(), event, vitePid: vitePid(), apiPid: apiPid(), ...extra }
  timeline.push(entry)
  console.log(`[vite-stability] ${event}`, JSON.stringify(entry))
}

function fail(label) {
  failures += 1
  log('FAIL', { label })
}

async function loadEnvSecret() {
  const file = path.join(ROOT, 'apps/dashboard/.env.local')
  if (!fs.existsSync(file)) return ''
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('VITE_OPS_DASHBOARD_SECRET=')) {
      return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
    }
  }
  return ''
}

async function apiHealthy() {
  const secret = await loadEnvSecret()
  const headers = { accept: 'application/json' }
  if (secret) headers['x-ops-dashboard-secret'] = secret
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/cockpit/health`, { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return false
    const json = await res.json()
    return json?.ok === true || json?.status === 'ok'
  } catch {
    return false
  }
}

async function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/build-api-production.mjs'], { cwd: ROOT, stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))))
  })
}

async function forceApiRestart() {
  const pid = apiPid()
  if (!pid) return
  log('force_api_restart', { targetPid: pid })
  try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  await sleep(2000)
}

async function main() {
  const initialVite = vitePid()
  if (!initialVite) {
    fail('vite_not_listening')
    process.exit(1)
  }
  log('start', { minutes: MINUTES, initialVite })

  const buildAt = Date.now() + 30_000
  const restartAt = Date.now() + 120_000
  const endAt = Date.now() + MINUTES * 60_000
  let buildDone = false
  let restartDone = false

  while (Date.now() < endAt) {
    if (!buildDone && Date.now() >= buildAt) {
      buildDone = true
      log('api_build_begin')
      try {
        await runBuild()
        log('api_build_complete')
      } catch (error) {
        fail(`api_build_failed:${error?.message || error}`)
      }
    }
    if (!restartDone && Date.now() >= restartAt) {
      restartDone = true
      await forceApiRestart()
    }

    const up = await dashboardUp()
    const pid = vitePid()
    if (!up || !pid) {
      fail('vite_died')
      break
    }
    if (pid !== initialVite) {
      log('vite_pid_changed', { initialVite, current: pid })
    }

    await sleep(5000)
  }

  let apiOk = false
  const apiDeadline = Date.now() + 120_000
  while (Date.now() < apiDeadline) {
    if (await apiHealthy()) {
      apiOk = true
      break
    }
    await sleep(2000)
  }
  const dashOk = await dashboardUp()
  if (!dashOk) fail('dashboard_down_at_end')
  if (!apiOk) fail('api_down_at_end')

  const outPath = path.join(ROOT, '.dev-all/vite-stability-timeline.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify({ initialVite, finalVite: vitePid(), timeline, failures }, null, 2)}\n`)

  if (failures > 0) {
    console.error(`FAIL vite-stability-proof failures=${failures}`)
    process.exit(1)
  }
  console.log('PASS vite-stability-proof', JSON.stringify({ initialVite, finalVite: vitePid(), minutes: MINUTES, events: timeline.length }))
}

main().catch((error) => {
  console.error('FAIL vite-stability-proof crashed', error?.message || error)
  process.exit(1)
})