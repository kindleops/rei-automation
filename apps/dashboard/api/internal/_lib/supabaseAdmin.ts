import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const getEnv = (key: string): string | undefined => {
  // Use a different approach for server-side env to avoid import.meta.env which might be Vite-specific
  return process.env[key]
}

const supabaseUrl = getEnv('SUPABASE_URL') || getEnv('VITE_SUPABASE_URL')
const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')

export const hasSupabaseAdminEnv = Boolean(supabaseUrl && serviceRoleKey)

let cachedAdminClient: SupabaseClient | null = null

export const getSupabaseAdminClient = (): SupabaseClient => {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase Admin env vars: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for server-side mutations.',
    )
  }

  if (!cachedAdminClient) {
    cachedAdminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  }

  return cachedAdminClient
}
