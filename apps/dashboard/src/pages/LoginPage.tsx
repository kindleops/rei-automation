import { type FormEvent, useState } from 'react'
import { signInWithEmail } from '../lib/auth/supabaseAuth'
import '../styles/login.css'

// Acquisition targeting reticle — command-center mark
const AcquisitionMark = () => (
  <svg
    viewBox="0 0 40 40"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    width={44}
    height={44}
    aria-hidden="true"
  >
    {/* Corner bracket — top left */}
    <path d="M4 14V4h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    {/* Corner bracket — top right */}
    <path d="M36 14V4H26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    {/* Corner bracket — bottom left */}
    <path d="M4 26v10h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    {/* Corner bracket — bottom right */}
    <path d="M36 26v10H26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    {/* Outer ring */}
    <circle cx="20" cy="20" r="7" stroke="currentColor" strokeWidth="1.25" opacity="0.4" />
    {/* Center dot */}
    <circle cx="20" cy="20" r="2.5" fill="currentColor" />
  </svg>
)

const TRUST_ITEMS = [
  'Live acquisition engine',
  'Protected operator access',
  'Supabase-secured session',
  'Production command center',
]

export const LoginPage = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error: authError } = await signInWithEmail(email.trim(), password)
    if (authError) {
      setError(authError)
      setLoading(false)
    }
    // On success, AuthProvider's onAuthStateChange fires and RequireAuth unmounts this page.
  }

  return (
    <div className="lc-root">
      {/* Background — gradient + dot grid + ambient orbs */}
      <div className="lc-bg" aria-hidden="true" />
      <div className="lc-grid-overlay" aria-hidden="true" />
      <div className="lc-orb lc-orb--1" aria-hidden="true" />
      <div className="lc-orb lc-orb--2" aria-hidden="true" />

      <main className="lc-main">
        {/* ── Login card ─────────────────────────────────────────────── */}
        <div className="lc-card" role="main">

          {/* Brand lockup */}
          <div className="lc-brand">
            <div className="lc-mark">
              <AcquisitionMark />
            </div>
            <div className="lc-brand-text">
              <div className="lc-brand-heading">
                LeadCommand <span className="lc-accent">Ops</span>
              </div>
              <div className="lc-brand-tagline">
                Private Real Estate Acquisition Command Center
              </div>
            </div>
          </div>

          {/* Private access badge */}
          <div className="lc-badge-row">
            <span className="lc-badge">
              <span className="lc-badge-dot" aria-hidden="true" />
              Private Access
            </span>
          </div>

          {/* Divider */}
          <div className="lc-sep" />

          {/* Sign-in form */}
          <form onSubmit={handleSubmit} className="lc-form" autoComplete="on" noValidate>
            <div className="lc-field">
              <label className="lc-label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="lc-input"
                placeholder="operator@domain.com"
                disabled={loading}
                spellCheck={false}
                autoCapitalize="none"
              />
            </div>

            <div className="lc-field">
              <label className="lc-label" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="lc-input"
                placeholder="••••••••••••"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="lc-error" role="alert" aria-live="polite">
                <span className="lc-error-icon" aria-hidden="true">⚠</span>
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="lc-btn" disabled={loading}>
              {loading ? (
                <>
                  <span className="lc-spinner" aria-hidden="true" />
                  Authenticating…
                </>
              ) : (
                'Enter Command Center'
              )}
            </button>
          </form>

          {/* Footer microcopy */}
          <p className="lc-footer">
            Authorized operators only — access is invitation-only.
          </p>
        </div>

        {/* ── Trust panel (desktop only, decorative) ──────────────────── */}
        <div className="lc-trust" aria-hidden="true">
          {TRUST_ITEMS.map((label) => (
            <div key={label} className="lc-trust-item">
              <span className="lc-trust-dot" />
              {label}
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
