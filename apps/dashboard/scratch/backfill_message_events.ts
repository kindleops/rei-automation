import dotenv from 'dotenv'
dotenv.config()
dotenv.config({ path: '.env.local' })
import { getSupabaseAdminClient } from '../api/internal/_lib/supabaseAdmin'
import { asString } from '../src/lib/data/shared'

async function backfill() {
  const supabase = getSupabaseAdminClient()
  
  console.log('Starting backfill of message_events for sent queue items...')
  
  const { data: sentItems, error: fetchError } = await supabase
    .from('send_queue')
    .select('*')
    .eq('queue_status', 'sent')
    .order('sent_at', { ascending: false })
  
  if (fetchError) {
    console.error('Error fetching sent items:', fetchError)
    return
  }
  
  console.log(`Found ${sentItems.length} sent items in queue.`)
  
  let createdCount = 0
  let skippedCount = 0
  
  for (const item of sentItems) {
    const eventKey = `outbound:${item.id}`
    
    // Check if event already exists
    const { data: existing, error: checkError } = await supabase
      .from('message_events')
      .select('id')
      .eq('message_event_key', eventKey)
      .maybeSingle()
    
    if (checkError) {
      console.error(`Error checking event for queue_id ${item.id}:`, checkError)
      continue
    }
    
    if (existing) {
      skippedCount++
      continue
    }
    
    // Insert event
    const now = item.sent_at || item.updated_at || new Date().toISOString()
    const sellerDisplayName = asString(item.seller_display_name || item.seller_first_name) || null
    
    const { data: eventData, error: eventError } = await supabase.from('message_events').upsert({
      message_event_key: eventKey,
      direction: 'outbound',
      event_type: 'sms_sent',
      from_phone_number: item.from_phone_number,
      to_phone_number: item.to_phone_number,
      message_body: item.message_body || item.message_text,
      delivery_status: 'sent',
      provider_delivery_status: 'sent',
      provider_message_sid: item.provider_message_id || item.textgrid_message_id || null,
      sent_at: now,
      created_at: item.created_at,
      event_timestamp: now,
      master_owner_id: item.master_owner_id,
      property_id: item.property_id,
      prospect_id: item.prospect_id,
      queue_id: item.id,
      template_id: item.selected_template_id || item.template_id || null,
      thread_key: item.thread_key,
      seller_display_name: sellerDisplayName,
      market: item.market,
      market_id: item.market_id,
      property_address: item.property_address,
      metadata: {
        source: 'backfill_script',
        queue_id: item.id,
        provider_message_id: item.provider_message_id,
        textgrid_message_id: item.textgrid_message_id,
      },
    }, { onConflict: 'message_event_key' }).select('id').single()
    
    if (eventError) {
      console.error(`Error creating event for queue_id ${item.id}:`, eventError)
    } else {
      createdCount++
      
      // Update thread state
      if (item.thread_key) {
        await supabase.from('inbox_thread_state').upsert({
          thread_key: item.thread_key,
          latest_message_event_id: (eventData as any).id,
          latest_message_body: item.message_body || item.message_text,
          latest_message_at: now,
          latest_direction: 'outbound',
          latest_event_type: 'sms_sent',
          latest_delivery_status: 'sent',
          last_outbound_at: now,
          updated_at: new Date().toISOString(),
          master_owner_id: item.master_owner_id,
          property_id: item.property_id,
          prospect_id: item.prospect_id,
          seller_phone: item.to_phone_number,
          canonical_e164: item.to_phone_number,
          our_number: item.from_phone_number,
          market: item.market,
          seller_display_name: sellerDisplayName,
        }, { onConflict: 'thread_key' })
      }
    }
  }
  
  console.log(`Backfill complete. Created: ${createdCount}, Skipped: ${skippedCount}`)
}

backfill()
