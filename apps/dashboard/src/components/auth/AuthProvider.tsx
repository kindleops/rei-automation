import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { type Session, type User } from '@supabase/supabase-js'
import { getAuthClient } from '../../lib/auth/supabaseAuth'

interface AuthContextValue {
  session: Session | null
  user: User | null
  loading: boolean
  error: Error | null
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    // Clear stale auth tokens in dev
    if (import.meta.env.DEV) {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
          localStorage.removeItem(key)
        }
      }
    }

    try {
      const client = getAuthClient()

      client.auth.getSession().then(({ data, error: sessionError }) => {
        if (sessionError) {
          console.warn('Supabase Auth getSession error:', sessionError)
          setError(sessionError)
        }
        setSession(data?.session ?? null)
        setLoading(false)
      }).catch(err => {
        console.warn('Supabase Auth connection failed:', err)
        setError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
      })

      const { data: { subscription } } = client.auth.onAuthStateChange((_event, newSession) => {
        setSession(newSession)
        setLoading(false)
      })

      return () => subscription.unsubscribe()
    } catch (err) {
      console.warn('Supabase Auth init failed:', err)
      setError(err instanceof Error ? err : new Error(String(err)))
      setLoading(false)
    }
  }, [])

  const signOut = async () => {
    try {
      const client = getAuthClient()
      await client.auth.signOut()
    } catch (err) {
      console.error('Sign out failed', err)
    }
  }

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading, error, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}
