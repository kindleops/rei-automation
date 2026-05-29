#!/usr/bin/env node
/**
 * Inbox production-hardening verification script.
 * Run: node scripts/verify-inbox.mjs
 * Requires API running on http://localhost:3000 with OPS_DASHBOARD_SECRET set.
 */

const BASE = process.env.API_URL || 'http://localhost:3000'
const SECRET = process.env.OPS_DASHBOARD_SECRET || 'cf19bd6d9bed109c1e77c6735ebf5d196a8f04f88d8274efbd2900defe134477'
const HEADERS = { 'x-ops-dashboard-secret': SECRET, 'Content-Type': 'application/json' }

let passed = 0
let failed = 0

function ok(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`)
    failed++
  }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { ok: false, _raw: text.slice(0, 200) } }
}

// ── A. Counts ────────────────────────────────────────────────────────────────
console.log('\nA. Counts endpoint')
const counts = await get('/api/cockpit/inbox/counts')
ok('ok:true', counts.ok === true)
ok('root counts exists', counts.counts && typeof counts.counts === 'object')
ok('data.counts exists', counts.data?.counts && typeof counts.data.counts === 'object')
ok('all > 1000', (counts.counts?.all ?? counts.data?.counts?.all ?? 0) > 1000,
  `got ${counts.counts?.all ?? counts.data?.counts?.all}`)

// ── B. Bucket contract ───────────────────────────────────────────────────────
const FILTERS = ['all', 'new_replies', 'priority', 'cold', 'dead', 'suppressed']
for (const filter of FILTERS) {
  console.log(`\nB. Bucket contract: filter=${filter}`)
  const res = await get(`/api/cockpit/inbox/live?filter=${filter}&limit=20`)
  ok('ok:true', res.ok === true)
  ok('threads array', Array.isArray(res.threads))

  if (filter !== 'all') {
    const threads = res.threads ?? []
    const mismatched = threads.filter(r => {
      const bucket = r.inbox_bucket || r.resolved_bucket
      if (filter === 'priority') return bucket !== 'priority'
      if (filter === 'new_replies') return bucket !== 'new_replies'
      if (filter === 'cold') return bucket !== 'cold'
      if (filter === 'dead') return bucket !== 'dead'
      if (filter === 'suppressed') return bucket !== 'suppressed'
      return false
    })
    ok(`all rows display inbox_bucket=${filter}`, mismatched.length === 0,
      `${mismatched.length}/${threads.length} mismatch: ${JSON.stringify(mismatched.slice(0, 2).map(r => ({ tk: r.thread_key, bucket: r.inbox_bucket })))}`)

    if (filter === 'priority') {
      const wrongBucket = threads.filter(r => r.inbox_bucket === 'new_replies')
      ok('no priority row displays as new_replies', wrongBucket.length === 0,
        `${wrongBucket.length} wrong rows`)
    }

    if (filter === 'cold') {
      const terminal = threads.filter(r => r.inbox_bucket === 'dead' || r.inbox_bucket === 'suppressed' || r.opt_out || r.wrong_number || r.not_interested)
      ok('cold excludes dead/suppressed/opt_out/wrong_number', terminal.length === 0,
        `${terminal.length} terminal rows found`)
    }
  }

  ok('requested_filter on rows', (res.threads ?? []).every(r => r.requested_filter === filter || res.threads?.length === 0))
}

// ── C. Phone identity ────────────────────────────────────────────────────────
console.log('\nC. Phone identity')
const allRes = await get('/api/cockpit/inbox/live?filter=all&limit=25')
const rows = allRes.threads ?? []
ok('rows returned', rows.length > 0)

const e164Re = /^\+\d{7,15}$/
for (const r of rows) {
  const tk = r.thread_key
  const sp = r.seller_phone
  const ph = r.phone
  const bp = r.best_phone
  const dp = r.display_phone
  const our = r.our_number

  if (e164Re.test(tk)) {
    ok(`[${tk}] seller_phone===thread_key`, sp === tk, `seller_phone=${sp}`)
    ok(`[${tk}] phone===thread_key`, ph === tk, `phone=${ph}`)
    ok(`[${tk}] best_phone===thread_key`, bp === tk, `best_phone=${bp}`)
    ok(`[${tk}] display_phone===thread_key`, dp === tk, `display_phone=${dp}`)
    if (our) {
      ok(`[${tk}] our_number!==seller_phone`, our !== sp, `our_number=${our}`)
    }
  }

  // Direction-specific checks
  const dir = r.latest_message_direction || r.latest_direction || r.direction
  if (dir === 'outbound' && r.queue_data?.to_phone_number) {
    ok(`[${tk}] outbound: seller_phone===queue.to`, sp === r.queue_data.to_phone_number,
      `sp=${sp} to=${r.queue_data.to_phone_number}`)
  }
}

// ── D. Pagination ────────────────────────────────────────────────────────────
console.log('\nD. Pagination')
const p1 = await get('/api/cockpit/inbox/live?filter=all&limit=5')
ok('page1 ok', p1.ok === true)
ok('page1 has 5 rows', (p1.threads ?? []).length === 5)
ok('has_more true', p1.pagination?.has_more === true)
const cursor = p1.pagination?.next_cursor
ok('next_cursor is string', typeof cursor === 'string' && cursor.length > 0, `cursor=${cursor}`)
ok('next_cursor is not numeric', isNaN(Number(cursor)), `cursor=${cursor}`)

if (cursor) {
  const p2 = await get(`/api/cockpit/inbox/live?filter=all&limit=5&cursor=${encodeURIComponent(cursor)}`)
  ok('page2 ok', p2.ok === true)
  ok('page2 has rows', (p2.threads ?? []).length > 0)
  const p1keys = new Set((p1.threads ?? []).map(r => r.thread_key))
  const dupes = (p2.threads ?? []).filter(r => p1keys.has(r.thread_key))
  ok('no duplicates between page1 and page2', dupes.length === 0,
    `dupes: ${JSON.stringify(dupes.map(r => r.thread_key))}`)
}

// ── E. Messages endpoint ─────────────────────────────────────────────────────
console.log('\nE. Messages endpoint')
const sampleKey = rows[0]?.thread_key
if (sampleKey) {
  const msgs = await get(`/api/cockpit/inbox/threads/${encodeURIComponent(sampleKey)}/messages?limit=50`)
  ok('ok:true', msgs.ok === true)
  ok('root messages exists', Array.isArray(msgs.messages), `type=${typeof msgs.messages}`)
  ok('root pagination exists', msgs.pagination && typeof msgs.pagination === 'object')
  ok('diagnostics.messages exists', Array.isArray(msgs.diagnostics?.messages))
  ok('messages belong to thread_key', (msgs.messages ?? []).every(m => !m.thread_key || m.thread_key === sampleKey))
} else {
  console.log('  (skipped — no rows returned)')
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
