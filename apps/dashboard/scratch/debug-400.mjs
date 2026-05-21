
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://lcppdrmrdfblstpcbgpf.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxjcHBkcm1yZGZibHN0cGNiZ3BmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0Nzc5OTMsImV4cCI6MjA5MjA1Mzk5M30.69iIHTSlhcKuBYNWuYA_Nv6O4s1IAQVcK4GkxtrO7Gc'
);

async function testUpdateNonExistent() {
  const { data, error } = await supabase
    .from('send_queue')
    .update({ queue_status: 'sending' })
    .eq('id', '00000000-0000-0000-0000-000000000000')
    .select();

  if (error) {
    console.error('Error:', JSON.stringify(error, null, 2));
  } else {
    console.log('Success (empty):', data);
  }
}

testUpdateNonExistent();
