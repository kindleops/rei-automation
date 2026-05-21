import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { resolveInboxBucket, buildConversationDecision } from '../src/modules/inbox/inbox-decisioning'
import { normalizeInboxThread } from '../src/lib/data/inboxData'
import type { InboxWorkflowThread } from '../src/lib/data/inboxWorkflowData'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const { data, error } = await supabase
    .from('v_inbox_enriched')
    .select('*')
    .order('latest_message_at', { ascending: false, nullsFirst: false })
    .limit(20)

  if (error) {
    console.error('Error fetching data:', error)
    return
  }

  const threads = data.map((row: any, i: number) => normalizeInboxThread(row, 0, i)) as InboxWorkflowThread[]
  
  console.log(`Fetched ${threads.length} threads. Verifying chron sorting and categorization:`)
  let lastTime = Infinity
  let outOfOrderCount = 0

  for (const t of threads) {
    const time = new Date(t.lastMessageAt || (t as any).lastMessageIso || t.updatedAt || 0).getTime()
    if (time > lastTime) {
      outOfOrderCount++
      console.log(`❌ Sort violation: Thread ${t.id} time ${new Date(time).toISOString()} is newer than previous.`)
    }
    lastTime = time

    const decision = buildConversationDecision(t)
    const isOutboundOnly = t.inbound_count === 0 && t.outbound_count > 0
    
    console.log(`- ID: ${t.id} | Dir: ${t.latestDirection} | Date: ${new Date(time).toISOString()}`)
    console.log(`  Bucket: ${decision.inbox_bucket} | OutboundOnly: ${isOutboundOnly} | Status: ${decision.conversation_status}`)
    console.log(`  Preview: ${t.preview}`)
  }

  console.log(`\nSort violations: ${outOfOrderCount}`)
}

run()
