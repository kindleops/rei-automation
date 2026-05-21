import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const envLocal = fs.readFileSync('nexus-dashboard/.env.local', 'utf-8');
const env = {};
envLocal.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k.trim()] = v.trim();
});

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const { data, error } = await supabase.from('nexus_inbox_threads_v').select('*').limit(5);

console.log(JSON.stringify({ error, rows: data }, null, 2));
