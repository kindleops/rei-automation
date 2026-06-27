#!/usr/bin/env node
/**
 * Inbox performance benchmark — measures API payload and latency.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const env = {}
  for (const file of ['.env.local', '.env']) {
    const envPath = path.join(__dirname, '../../', file)
    if (!fs.existsSync(envPath)) continue
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1')
      if (!env[key]) env[key] = value
    }
  }
  return env
}

const env = loadEnv()
const base = (process.env.BENCHMARK_API_BASE || env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '')
const secret = process.env.BENCHMARK_API_SECRET || env.VITE_BACKEND_API_SECRET || env.VITE_OPS_DASHBOARD_SECRET || ''

async function timedFetch(path) {
  const started = performance.now()
  const res = await fetch(`${base}${path}`, {
    headers: {
      'x-ops-dashboard-secret': secret,
      'Content-Type': 'application/json',
    },
  })
  const text = await res.text()
  const ms = Math.round(performance.now() - started)
  return { status: res.status, bytes: Buffer.byteLength(text, 'utf8'), ms, text }
}

async function main() {
  const endpoints = [
    '/api/cockpit/inbox/live?filter=all_messages&limit=25&timeout_mode=initial_boot',
    '/api/cockpit/inbox/live?filter=new_replies&limit=100&timeout_mode=manual_bucket_switch',
    '/api/cockpit/inbox/counts',
  ]

  const results = {}
  for (const ep of endpoints) {
    const r = await timedFetch(ep)
    let threadCount = null
    try {
      const body = JSON.parse(r.text)
      threadCount = Array.isArray(body.threads) ? body.threads.length : null
    } catch {
      /* ignore */
    }
    results[ep] = { ...r, threadCount }
  }

  const outPath = path.join(__dirname, '../../proof/inbox/performance-benchmark.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), base, results }, null, 2))
  console.log(JSON.stringify(results, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})