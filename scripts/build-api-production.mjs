#!/usr/bin/env node

import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_DIR = path.join(ROOT, '.dev-all')
const BUILD_PAUSE_FILE = path.join(LOCK_DIR, 'build-pause.json')
const API_PORT = Number(process.env.DEV_ALL_API_PORT || 3000)
const API_ROOT = path.join(ROOT, 'apps/api')
const NEXT_DIR = path.join(API_ROOT, '.next')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function setBuildPause(active) {
  fs.mkdirSync(LOCK_DIR, { recursive: true })
  if (active) {
    fs.writeFileSync(BUILD_PAUSE_FILE, `${JSON.stringify({ since: new Date().toISOString(), pid: process.pid })}\n`)
  } else if (fs.existsSync(BUILD_PAUSE_FILE)) {
    fs.unlinkSync(BUILD_PAUSE_FILE)
  }
}

function listPortPids(port) {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return output.split(/\r?\n/).map((v) => Number(v.trim())).filter((pid) => Number.isFinite(pid) && pid > 0)
  } catch {
    return []
  }
}

async function stopApiListener() {
  const pids = listPortPids(API_PORT)
  if (!pids.length) return
  console.log(`[build:api] Stopping API listener(s) on :${API_PORT}: ${pids.join(', ')}`)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }
  await sleep(1200)
  for (const pid of listPortPids(API_PORT)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['--workspace', 'apps/api', 'run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`API build failed with exit code ${code}`))))
  })
}

async function main() {
  console.log('[build:api] Starting supervised production build')
  setBuildPause(true)
  try {
    await stopApiListener()
    if (fs.existsSync(NEXT_DIR)) {
      console.log('[build:api] Cleaning apps/api/.next')
      fs.rmSync(NEXT_DIR, { recursive: true, force: true })
    }
    await runBuild()
    console.log('[build:api] Production build complete')
  } finally {
    setBuildPause(false)
  }
}

main().catch((error) => {
  setBuildPause(false)
  console.error('[build:api] Failed:', error?.message || error)
  process.exit(1)
})