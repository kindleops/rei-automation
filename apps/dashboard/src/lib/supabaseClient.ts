import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const getEnv = (key: string): string | undefined => {
  const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  try {
    return (import.meta.env?.[key] as string) || runtimeProcess?.env?.[key]
  } catch {
    return runtimeProcess?.env?.[key]
  }
}

const supabaseUrl = getEnv('VITE_SUPABASE_URL')
const supabaseAnonKey = getEnv('VITE_SUPABASE_ANON_KEY')

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey)
export const supabaseUrlPresent = Boolean(supabaseUrl)
export const supabaseAnonKeyPresent = Boolean(supabaseAnonKey)

let cachedClient: SupabaseClient | null = null

export const getSupabaseClient = (): SupabaseClient => {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing Supabase env vars: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable live data.',
    )
  }

  if (!cachedClient) {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
      },
    })
  }

  return cachedClient
}
