import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in environment.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log("1. Checking canonical_inbox_threads existence and rows...");
  const { data: threads, error: threadsErr } = await supabase.from('canonical_inbox_threads').select('*').limit(5);
  if (threadsErr) console.error("  ✗ Error:", threadsErr);
  else console.log(`  ✓ Success: Found ${threads.length} rows.`);

  console.log("2. Checking canonical_inbox_counts existence and exactly one row...");
  const { data: counts, error: countsErr } = await supabase.from('canonical_inbox_counts').select('*');
  if (countsErr) console.error("  ✗ Error:", countsErr);
  else {
    console.log(`  ✓ Success: Found ${counts.length} rows.`);
    if (counts.length === 1) console.log("  ✓ Details:", counts[0]);
    else console.error("  ✗ Expected exactly one row!");
  }

  console.log("4. Checking grouped counts from canonical_inbox_threads...");
  // Using RPC if needed, or we can just fetch all or use raw PostgREST?
  // Supabase JS doesn't have a direct GROUP BY for all without RPC, 
  // but we can just use `pg_catalog` via RPC or maybe there's a way.
  // Actually, we can just do a count with filters for each bucket.
  const buckets = ['all', 'new_replies', 'priority', 'needs_review', 'waiting', 'suppressed', 'dead'];
  
  for (const bucket of buckets) {
    let q = supabase.from('canonical_inbox_threads').select('*', { count: 'exact', head: true });
    if (bucket !== 'all') {
      q = q.eq('inbox_bucket', bucket);
    }
    const { count, error } = await q;
    if (error) console.error(`  ✗ Error for ${bucket}:`, error);
    else console.log(`  ✓ Group count for ${bucket}: ${count}`);
  }
}

run();
