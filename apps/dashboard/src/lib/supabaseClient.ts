import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/*
 * STATIC KEYS ONLY -- THIS IS A SECURITY CONSTRAINT, NOT A STYLE CHOICE.
 *
 * This used to read `import.meta.env?.[key]` with a dynamic key. Vite can only
 * substitute `import.meta.env.SOME_NAME` when the name is a literal it can see
 * at build time; a computed lookup forces it to emit the ENTIRE env object
 * into the bundle instead. That is how privileged secrets kept reaching the
 * public JS even after every by-name reference to them had been deleted.
 *
 * Read each variable by its literal name, and only variables that are public
 * by design. Do not reintroduce a dynamic `import.meta.env[...]` lookup.
 */
const viteUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const viteAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

const getRuntimeEnv = (key: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[key]

const supabaseUrl = viteUrl || getRuntimeEnv('VITE_SUPABASE_URL')
const supabaseAnonKey = viteAnonKey || getRuntimeEnv('VITE_SUPABASE_ANON_KEY')

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
        /*
         * THE SESSION IS NOW THE ONLY CREDENTIAL, SO IT HAS TO SURVIVE.
         *
         * These were all false. That was invisible while the dashboard
         * authenticated with a shipped secret and the auth gate was bypassed:
         * nothing depended on the session, so nothing noticed it evaporating.
         * With the gate enforced, `persistSession: false` means getSession()
         * returns null on every load -- the operator would be bounced to the
         * sign-in screen on each refresh, and autoRefreshToken: false would
         * expire them mid-session.
         *
         * detectSessionInUrl matters because Google sign-in is enabled: the
         * provider returns the session in the URL fragment, and without this
         * the redirect lands back on the login screen having discarded it.
         */
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  }

  return cachedClient
}
