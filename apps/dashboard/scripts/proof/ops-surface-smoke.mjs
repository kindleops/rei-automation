#!/usr/bin/env node

/**
 * Read-only ops surface smoke counts — Campaign / Pipeline / Workflow / send_queue.
 * No writes. No SMS.
 */

import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = {}
for (const f of ['.env.local', '.env']) {
  const p = path.join(__dirname, '../../', f)
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
}
const pick = (...keys) => keys.map((k) => env[k] || process.env[k]).find(Boolean)

const supabaseUrl = pick('SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
const supabaseKey = pick('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY')

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase env. No queries run.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

async function count(table, filter) {
  try {
    let q = supabase.from(table).select('*', { count: 'exact', head: true })
    if (filter) q = filter(q)
    const { count: n, error } = await q
    if (error) throw error
    return n ?? 0
  } catch (error) {
    return `ERR: ${error.message || error}`
  }
}

async function main() {
  console.log('🧪 Ops Surface Smoke (READ-ONLY) — 0 mutations\n')

  const rows = [
    ['campaigns', await count('campaigns')],
    ['campaign_targets', await count('campaign_targets')],
    ['acquisition_opportunities', await count('acquisition_opportunities')],
    ['workflow_enrollments', await count('workflow_enrollments')],
    ['workflow_scheduled_tasks', await count('workflow_scheduled_tasks')],
    ['send_queue_followup_rows', await count('send_queue', (q) => q.gt('touch_number', 1))],
  ]

  for (const [label, value] of rows) {
    console.log(`   ${label.padEnd(28)} ${value}`)
  }

  const secret = pick('VITE_BACKEND_API_SECRET', 'VITE_OPS_DASHBOARD_SECRET')
  console.log('\nAuth env present:')
  console.log(`   VITE_BACKEND_API_URL present: ${pick('VITE_BACKEND_API_URL') ? 'yes' : 'no'}`)
  console.log(`   VITE_BACKEND_API_SECRET present: ${secret ? 'yes' : 'no'}`)
  console.log(`   VITE_BACKEND_API_SECRET length: ${secret ? String(secret.length) : '0'}`)
  if (secret) {
    console.log(`   VITE_BACKEND_API_SECRET fingerprint: ${secret.slice(0, 6)}…${secret.slice(-4)}`)
  }

  console.log('\n✅ Read-only smoke complete. Production mutations: 0. SMS sent: 0.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})