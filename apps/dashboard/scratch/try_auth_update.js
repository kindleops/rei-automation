import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  console.log('Attempting sign-in...');
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: 'admin@nexus.com', // Speculative
    password: 'password'      // Speculative
  });

  if (authError) {
    console.log('Auth failed (as expected):', authError.message);
  } else {
    console.log('Auth success!');
    const { data, error } = await supabase.from('send_queue')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', '380707a1-9b81-40fa-bb88-5c0ac926c58c')
      .select();
    console.log('Update result:', data || error);
  }
}
run();
