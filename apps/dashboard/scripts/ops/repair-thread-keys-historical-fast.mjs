import dotenv from 'dotenv'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceKey) throw new Error('Missing Supabase env')
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

function normalizeE164(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 11) return `+${digits}`
  return null
}

function expectedKey(row) {
  const d = String(row.direction || '').toLowerCase()
  return d === 'inbound' ? normalizeE164(row.from_phone_number) : d === 'outbound' ? normalizeE164(row.to_phone_number) : null
}

async function mapLimit(items, limit, fn) {
  const out = []
  let idx = 0
  const workers = Array.from({ length: limit }).map(async () => {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

async function main() {
  let from = 0
  const pageSize = 1000
  let scanned = 0
  let updated = 0

  while (true) {
    const to = from + pageSize - 1
    const { data, error } = await supabase
      .from('message_events')
      .select('id,direction,thread_key,from_phone_number,to_phone_number')
      .in('direction', ['inbound', 'outbound'])
      .or('thread_key.is.null,thread_key.eq.,thread_key.ilike.phone:%,thread_key.ilike.%|%,thread_key.ilike.%:%')
      .range(from, to)
    if (error) throw error
    const rows = data || []
    if (rows.length === 0) break
    scanned += rows.length

    const work = rows
      .map((row) => ({ id: row.id, expected: expectedKey(row), current: normalizeE164(row.thread_key) || String(row.thread_key || '') }))
      .filter((r) => r.expected && r.expected !== r.current)

    await mapLimit(work, 25, async (r) => {
      const { error: uErr } = await supabase.from('message_events').update({ thread_key: r.expected }).eq('id', r.id)
      if (uErr) throw uErr
      updated += 1
    })

    from += pageSize
  }

  console.log(JSON.stringify({ scanned_bad_pattern_rows: scanned, updated_rows: updated }, null, 2))
}

main().catch((e) => {
  console.error('[repair-thread-keys-historical-fast] error:', e)
  process.exit(1)
})

