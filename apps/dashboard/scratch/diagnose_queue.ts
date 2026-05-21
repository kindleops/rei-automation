import { getSupabaseClient } from '../src/lib/supabaseClient.ts'

async function diagnose() {
  const supabase = getSupabaseClient()
  
  console.log('--- SYSTEM_CONTROL ---')
  const { data: controls, error: controlError } = await supabase.from('system_control').select('*')
  if (controlError) {
    console.error('Error fetching system_control:', controlError)
  } else {
    console.table(controls)
  }

  console.log('\n--- SEND_QUEUE STATS ---')
  const { data: queueStats, error: queueError } = await supabase
    .from('send_queue')
    .select('queue_status', { count: 'exact' })
  
  if (queueError) {
    console.error('Error fetching send_queue stats:', queueError)
  } else {
    // Manually group by status if needed, or just show total for now
    console.log('Total queue items:', queueStats?.length)
    
    const statuses = ['queued', 'sent', 'failed', 'approval', 'held', 'retry']
    for (const status of statuses) {
      const { count } = await supabase
        .from('send_queue')
        .select('*', { count: 'exact', head: true })
        .eq('queue_status', status)
      console.log(`Status ${status}: ${count}`)
    }
  }

  console.log('\n--- RECENT QUEUE ERRORS ---')
  const { data: recentErrors } = await supabase
    .from('send_queue')
    .select('id, to_phone_number, error_message, failure_reason, updated_at')
    .not('error_message', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(5)
  console.table(recentErrors)
}

diagnose()
