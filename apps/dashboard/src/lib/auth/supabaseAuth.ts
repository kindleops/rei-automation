import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let authClient: SupabaseClient | null = null

export const getAuthClient = (): SupabaseClient => {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
  }
  if (!authClient) {
    authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  }
  return authClient
}

export async function signInWithEmail(
  email: string,
  password: string,
): Promise<{ error: string | null }> {
  const client = getAuthClient()
  const { error } = await client.auth.signInWithPassword({ email, password })
  return { error: error?.message ?? null }
}

export async function signOut(): Promise<void> {
  const client = getAuthClient()
  await client.auth.signOut()
}

export async function getSession(): Promise<Session | null> {
  const client = getAuthClient()
  const { data } = await client.auth.getSession()
  return data.session
}
