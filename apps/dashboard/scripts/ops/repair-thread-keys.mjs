import dotenv from 'dotenv'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE URL or SUPABASE_SERVICE_ROLE_KEY in env.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

function normalizeE164(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 11) return `+${digits}`
  return null
}

function startOfTodayLocalIso() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function expectedThreadKey(row) {
  const dir = String(row.direction || '').toLowerCase()
  if (dir === 'inbound') return normalizeE164(row.from_phone_number)
  if (dir === 'outbound') return normalizeE164(row.to_phone_number)
  return null
}

function mismatchPattern(thread_key) {
  const tk = String(thread_key || '')
  if (!tk) return 'null_or_blank'
  if (tk.startsWith('phone:')) return 'phone_prefix'
  if (tk.includes('|')) return 'pipe_composite'
  if (tk.includes(':')) return 'colon_composite'
  if (tk.startsWith('SM')) return 'provider_sid'
  return 'other'
}

async function rebuildThreadStateForPhone(phone) {
  const { data: events, error } = await supabase
    .from('message_events')
    .select('id,direction,from_phone_number,to_phone_number,message_body,created_at,event_timestamp,delivery_status,detected_intent,priority,master_owner_id,prospect_id,property_id,market,thread_key')
    .eq('thread_key', phone)
    .order('event_timestamp', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  const rows = events || []
  if (rows.length === 0) return { phone, skipped: true, reason: 'no_events' }

  const inboundCount = rows.filter((r) => String(r.direction || '').toLowerCase() === 'inbound').length
  const outboundCount = rows.filter((r) => String(r.direction || '').toLowerCase() === 'outbound').length
  const latest = rows[rows.length - 1]
  const latestInbound = [...rows].reverse().find((r) => String(r.direction || '').toLowerCase() === 'inbound')
  const latestOutbound = [...rows].reverse().find((r) => String(r.direction || '').toLowerCase() === 'outbound')

  const payload = {
    thread_key: phone,
    seller_phone: phone,
    canonical_e164: phone,
    our_number: normalizeE164(latestOutbound?.from_phone_number || latestInbound?.to_phone_number || null),
    master_owner_id: latest.master_owner_id || null,
    prospect_id: latest.prospect_id || null,
    property_id: latest.property_id || null,
    market: latest.market || null,
    status: 'active',
    priority: latest.priority || 'normal',
    last_intent: latest.detected_intent || null,
    latest_message_body: latest.message_body || null,
    latest_message_at: latest.event_timestamp || latest.created_at || null,
    latest_direction: latest.direction || null,
    latest_delivery_status: latest.delivery_status || null,
    last_inbound_at: latestInbound?.event_timestamp || latestInbound?.created_at || null,
    last_outbound_at: latestOutbound?.event_timestamp || latestOutbound?.created_at || null,
    inbound_count: inboundCount,
    outbound_count: outboundCount,
    updated_at: new Date().toISOString(),
    metadata: { repaired_by: 'repair-thread-keys', repaired_at: new Date().toISOString() },
  }

  const { error: upsertErr } = await supabase.from('inbox_thread_state').upsert(payload, { onConflict: 'thread_key' })
  if (upsertErr) throw upsertErr
  return { phone, skipped: false, inboundCount, outboundCount }
}

async function main() {
  const since = startOfTodayLocalIso()

  const { data: todayRows, error: todayErr } = await supabase
    .from('message_events')
    .select('id,direction,thread_key,from_phone_number,to_phone_number,provider_message_sid,delivery_status,created_at,event_timestamp,message_body')
    .gte('created_at', since)
    .in('direction', ['inbound', 'outbound'])
    .order('created_at', { ascending: true })
  if (todayErr) throw todayErr

  const mismatches = []
  const patterns = {}
  const sellerPhonesToday = new Set()
  for (const row of todayRows || []) {
    const expected = expectedThreadKey(row)
    if (expected) sellerPhonesToday.add(expected)
    const actual = normalizeE164(row.thread_key) || String(row.thread_key || '')
    if (!expected) continue
    if (actual !== expected) {
      mismatches.push({ id: row.id, expected, actual_raw: row.thread_key, direction: row.direction })
      const p = mismatchPattern(row.thread_key)
      patterns[p] = (patterns[p] || 0) + 1
    }
  }

  let repairedEventCount = 0
  for (const m of mismatches) {
    const { error } = await supabase.from('message_events').update({ thread_key: m.expected }).eq('id', m.id)
    if (error) throw error
    repairedEventCount += 1
  }

  const repairPhones = new Set([...sellerPhonesToday, ...mismatches.map((m) => m.expected)])
  const stateRepairs = []
  for (const phone of repairPhones) {
    const result = await rebuildThreadStateForPhone(phone)
    stateRepairs.push(result)
  }

  const proof = []
  for (const phone of repairPhones) {
    const { data: events, error } = await supabase
      .from('message_events')
      .select('id,direction,thread_key,from_phone_number,to_phone_number,event_timestamp,created_at,message_body')
      .eq('thread_key', phone)
      .in('direction', ['inbound', 'outbound'])
      .order('event_timestamp', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) throw error

    const outbound = (events || []).filter((e) => e.direction === 'outbound')
    const inbound = (events || []).filter((e) => e.direction === 'inbound')
    const outboundAllGood = outbound.every((e) => normalizeE164(e.to_phone_number) === phone)
    const inboundAllGood = inbound.every((e) => normalizeE164(e.from_phone_number) === phone)
    const hasChronological = (events || []).length <= 1
      ? true
      : (events || []).every((e, idx, arr) => idx === 0 || new Date(arr[idx - 1].event_timestamp || arr[idx - 1].created_at).getTime() <= new Date(e.event_timestamp || e.created_at).getTime())

    const { data: stateRow, error: stateErr } = await supabase
      .from('inbox_thread_state')
      .select('thread_key,inbound_count,outbound_count,latest_direction,latest_message_at')
      .eq('thread_key', phone)
      .limit(1)
      .maybeSingle()
    if (stateErr) throw stateErr

    proof.push({
      seller_phone: phone,
      outbound_count: outbound.length,
      inbound_count: inbound.length,
      outbound_thread_key_matches_seller_phone: outboundAllGood,
      inbound_thread_key_matches_seller_phone: inboundAllGood,
      inbox_thread_state_exists: Boolean(stateRow),
      chronological: hasChronological,
    })
  }

  console.log(JSON.stringify({
    since_local_midnight_utc: since,
    today_rows_scanned: (todayRows || []).length,
    mismatch_count_before_repair: mismatches.length,
    mismatch_patterns: patterns,
    repaired_message_event_rows: repairedEventCount,
    repaired_inbox_thread_state_rows: stateRepairs.filter((r) => !r.skipped).length,
    proof,
  }, null, 2))
}

main().catch((err) => {
  console.error('[repair-thread-keys] error:', err)
  process.exit(1)
})

