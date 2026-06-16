import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const controller = new AbortController();
  setTimeout(() => {
    console.log("Aborting...");
    controller.abort();
  }, 100);

  try {
    const start = Date.now();
    console.log("Querying...");
    let query = supabase.from('v_universal_lead_command').select('*').limit(1);
    
    // Test if abortSignal exists
    if (typeof query.abortSignal === 'function') {
      console.log("abortSignal method exists!");
      query = query.abortSignal(controller.signal);
    } else {
      console.log("abortSignal method DOES NOT EXIST!");
    }
    
    await query.maybeSingle();
    console.log("Finished in", Date.now() - start, "ms");
  } catch (err) {
    console.error("Caught error:", err.message);
  }
}
run();
