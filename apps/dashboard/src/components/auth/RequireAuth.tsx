import { type ReactNode } from 'react'
import { useAuth } from './AuthProvider'
import { LoginPage } from '../../pages/LoginPage'

export const RequireAuth = ({ children }: { children: ReactNode }) => {
  /*
   * PRODUCTION DEFAULTS CLOSED.
   *
   * This used to read `VITE_REQUIRE_AUTH === 'true'` and bypass otherwise. The
   * production pipeline never set that variable, so the operator console --
   * real seller PII -- rendered for anyone who loaded the URL, with no sign-in.
   *
   * The default is now inverted: a production build always requires a session.
   * Only a DEV build can opt out, and only by saying so explicitly. There is
   * deliberately no production escape hatch; an env var that can unlock prod is
   * the same bug with a different name.
   */
  const requireAuth = import.meta.env.PROD
    ? true
    : import.meta.env.VITE_REQUIRE_AUTH === 'true'
  const { session, loading, error } = useAuth()

  if (!requireAuth) {
    return (
      <>
        {error && (
          <div style={{ background: '#f59e0b', color: '#000', padding: '0.5rem', textAlign: 'center', fontSize: '0.875rem' }}>
            Warning: Supabase Auth unavailable ({error.message}). Running in local bypass mode.
          </div>
        )}
        {children}
      </>
    )
  }

  if (loading) {
    return (
      <main className="app-state">
        <div className="app-state__panel">
          <span className="app-state__eyebrow">NEXUS</span>
          <h1>Authenticating</h1>
          <p>Verifying operator credentials…</p>
        </div>
      </main>
    )
  }

  if (!session) {
    return <LoginPage />
  }

  return <>{children}</>
}
