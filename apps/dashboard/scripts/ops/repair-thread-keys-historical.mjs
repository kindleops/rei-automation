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

function expectedThreadKey(row) {
  const dir = String(row.direction || '').toLowerCase()
  if (dir === 'inbound') return normalizeE164(row.from_phone_number)
  if (dir === 'outbound') return normalizeE164(row.to_phone_number)
  return null
}

function isBadThreadKey(threadKey) {
  const tk = String(threadKey || '').trim()
  if (!tk) return true
  if (tk.startsWith('phone:')) return true
  if (tk.includes('|')) return true
  if (tk.includes(':')) return true
  return false
}

async function main() {
  const pageSize = 1000
  let from = 0
  let scanned = 0
  let repaired = 0
  const touchedPhones = new Set()

  while (true) {
    const to = from + pageSize - 1
    const { data, error } = await supabase
      .from('message_events')
      .select('id,direction,thread_key,from_phone_number,to_phone_number')
      .in('direction', ['inbound', 'outbound'])
      .range(from, to)
    if (error) throw error
    const rows = data || []
    if (rows.length === 0) break
    scanned += rows.length

    for (const row of rows) {
      const expected = expectedThreadKey(row)
      if (!expected) continue
      const actualNorm = normalizeE164(row.thread_key)
      if (actualNorm === expected && !isBadThreadKey(row.thread_key)) continue
      if (!isBadThreadKey(row.thread_key) && actualNorm !== expected) continue

      const { error: updateErr } = await supabase
        .from('message_events')
        .update({ thread_key: expected })
        .eq('id', row.id)
      if (updateErr) throw updateErr
      repaired += 1
      touchedPhones.add(expected)
    }

    from += pageSize
  }

  console.log(JSON.stringify({
    scanned_rows: scanned,
    repaired_rows: repaired,
    touched_seller_phones: touchedPhones.size,
  }, null, 2))
}

main().catch((err) => {
  console.error('[repair-thread-keys-historical] error:', err)
  process.exit(1)
})

