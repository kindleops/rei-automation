import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

const supabase = createClient(supabaseUrl, supabaseKey)

// Minimal standalone logic simulation for bucketing and sorting validation
function inferStatus(lastDir, inboxCat, unreadCount) {
  if (lastDir === 'inbound' && unreadCount > 0) return 'new_reply'
  if (inboxCat === 'needs_review') return 'needs_review'
  if (lastDir === 'outbound') return 'waiting_on_seller'
  return 'active'
}

function resolveBucket(lastDir, unreadCount, inboxCat, priorityScore) {
  if (inboxCat === 'dnc_opt_out') return 'dnc_suppressed'
  if (lastDir === 'inbound' && unreadCount > 0) return 'new_replies'
  if (inboxCat === 'needs_review') return 'needs_review'
  if (priorityScore >= 70 && unreadCount > 0) return 'priority'
  if (inboxCat === 'automated') return 'automated'
  
  if (lastDir === 'outbound' && unreadCount === 0) return 'waiting_on_seller'
  return 'all_conversations'
}

async function run() {
  const { data, error } = await supabase
    .from('v_inbox_enriched')
    .select('thread_key, latest_message_at, latest_direction, latest_message_body, inbox_category, inbound_count, outbound_count, priority_score, is_read')
    // Simulating exactly the DB fetch logic from getInboxRowsForView when 'all_sellers' view isn't active
    .order('latest_message_at', { ascending: false, nullsFirst: false })
    .order('final_acquisition_score', { ascending: false, nullsFirst: false })
    .limit(20)

  if (error) {
    console.error('Error fetching data:', error)
    return
  }

  console.log(`Fetched ${data.length} threads directly from DB (simulating canonical getInboxRowsForView sort).`)
  let lastTime = Infinity
  let outOfOrderCount = 0

  for (const t of data) {
    const time = new Date(t.latest_message_at || 0).getTime()
    if (time > lastTime) {
      outOfOrderCount++
      console.log(`❌ Sort violation: Thread ${t.thread_key} time ${new Date(time).toISOString()} is newer than previous.`)
    }
    lastTime = time

    const dir = t.latest_direction || 'unknown'
    const unread = (t.unread_count > 0 || (dir === 'inbound' && !t.is_read)) ? 1 : 0
    const bucket = resolveBucket(dir, unread, t.inbox_category, t.priority_score || 0)
    const status = inferStatus(dir, t.inbox_category, unread)
    const isOutboundOnly = t.inbound_count === 0 && t.outbound_count > 0
    
    console.log(`- Thread Key: ${t.thread_key} | Dir: ${dir} | Date: ${new Date(time).toISOString()}`)
    console.log(`  Bucket (derived): ${bucket} | OutboundOnly: ${isOutboundOnly} | Status (derived): ${status}`)
    console.log(`  Preview: ${t.latest_message_body}`)
  }

  console.log(`\nSort violations: ${outOfOrderCount}`)
}

run()
