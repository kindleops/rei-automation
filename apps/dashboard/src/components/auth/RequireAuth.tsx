import { type ReactNode } from 'react'
import { useAuth } from './AuthProvider'
import { LoginPage } from '../../pages/LoginPage'

export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { session, loading } = useAuth()

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
