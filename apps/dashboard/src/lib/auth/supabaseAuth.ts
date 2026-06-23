import { type SupabaseClient, type Session } from '@supabase/supabase-js'
import { getSupabaseClient } from '../supabaseClient'

// Single client — avoids "Multiple GoTrueClient instances detected" warning.
// Re-uses the same singleton created by supabaseClient.ts instead of a second instance.
export const getAuthClient = (): SupabaseClient => getSupabaseClient()

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
