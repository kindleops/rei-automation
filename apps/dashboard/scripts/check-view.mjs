import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const envLocal = fs.readFileSync('nexus-dashboard/.env.local', 'utf-8');
const env = {};
envLocal.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k.trim()] = v.trim();
});

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
const { data, error } = await supabase.from('nexus_thread_intelligence_v').select('*').limit(1);

console.log(JSON.stringify({ error, row: data?.[0] }, null, 2));
