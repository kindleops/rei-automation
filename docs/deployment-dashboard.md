# Dashboard Deployment Guide — ops.leadcommand.ai

## Vercel Project Settings

| Setting | Value |
|---|---|
| **Root Directory** | `apps/dashboard` |
| **Framework Preset** | Vite |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Dev Command** | `vite --host 0.0.0.0 --port $PORT` |
| **Node Version** | 20.x or 22.x |

These match `apps/dashboard/vercel.json` exactly — do not override them in the Vercel UI.

## Custom Domain

Set **ops.leadcommand.ai** as the production domain in Vercel → Project → Settings → Domains.

## Required Environment Variables

Set these in Vercel → Project → Settings → Environment Variables.
All are required for **Production**. Development can use `.env.local`.

| Variable | Value | Notes |
|---|---|---|
| `VITE_BACKEND_API_URL` | `https://real-estate-automation-three.vercel.app` | Never localhost in production |
| `VITE_BACKEND_API_SECRET` | `<ops secret>` | Must match `OPS_DASHBOARD_SECRET` on the API |
| `VITE_SUPABASE_URL` | `https://lcppdrmrdfblstpcbgpf.supabase.co` | |
| `VITE_SUPABASE_ANON_KEY` | `<anon key from Supabase dashboard>` | Safe for browser — enforced by RLS |

**Never add:**
- `VITE_SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS, must never reach the browser or dashboard
- Any private API keys as `VITE_*` variables

## Supabase Configuration (Ryan must do this manually)

### 1. Create operator users

In Supabase → Authentication → Users → Invite user:
- Create each operator by email
- Set a strong password
- Do **not** enable public signups

### 2. Disable public signup

In Supabase → Authentication → Providers → Email:
- **Disable** "Enable email confirmations" if you want immediate access after invite
- In Supabase → Authentication → Settings:
  - Set **"Disable signup"** = ON (or enforce via RLS policies)

### 3. Add allowed redirect URLs

In Supabase → Authentication → URL Configuration → Redirect URLs, add:

```
https://ops.leadcommand.ai
https://ops.leadcommand.ai/*
https://nexus-dashboard.vercel.app
https://nexus-dashboard.vercel.app/*
http://localhost:5173
http://localhost:5173/*
```

### 4. Site URL

Set **Site URL** to `https://ops.leadcommand.ai` once the domain is live.

## Seller Autopilot Release (2026-06-30)

Canonical branch: `main` @ `32d1f22`.

| Target | URL |
|---|---|
| Dashboard production | `https://dashboard-azure-six-92.vercel.app` |
| API production | `https://api-steel-three-96.vercel.app` |
| Preview (branch deploy, SSO-protected) | `https://dashboard-30wke4ipi-real-estate-automation.vercel.app` |

### Focused verification commands

```bash
# Builds
npm run build:api
cd apps/dashboard && npm run build

# Seller-flow critical proofs (API)
cd apps/api && npm run proof:seller-inbound-orchestration

# Dashboard unit proofs (map/inbox/mobile dock)
cd apps/dashboard && npx vitest run tests/unit/map-selection-sync.test.ts tests/unit/universal-pin-system.test.ts
```

### Architecture entry points

- **Seller automation:** `apps/api/src/lib/seller-inbound/` orchestrator + `seller_automation_executions` timeline tables
- **Universal lead state:** `apps/api/supabase/migrations/20260627120000_universal_lead_state.sql` + dashboard `universal-sync.ts`
- **Mobile shell:** `PortableCommandShell.tsx` + `PinnedAppDock.tsx` (portrait); landscape uses desktop `CommandCenterApp`
- **Desktop Deal Desk:** 25/50/25 via `view-layout.ts` + `InboxPage.tsx`
- **Map seller pins:** `InboxCommandMap.tsx` + `universal-pin-system.ts` + `seller-card/`
- **Queue/send:** `apps/api/src/app/api/internal/queue/run` + `send_queue` atomic claim RPCs

## After Dashboard Domain Is Live

Lock `apps/api` CORS to the dashboard domain only:

In `apps/api`, update the `CORS_ALLOWED_ORIGINS` (or equivalent) environment variable:

```
https://ops.leadcommand.ai
```

Remove the wildcard or dev-only origins. This prevents any other origin from calling the cockpit API.

## Auth Flow Summary

1. User visits `https://ops.leadcommand.ai`
2. `AuthProvider` checks for an existing Supabase session (persisted in localStorage)
3. If no session → `LoginPage` is rendered (no signup UI)
4. Operator enters email + password → Supabase `signInWithPassword`
5. Session is stored in browser storage (survives page refreshes and iPhone PWA)
6. All backend API calls include both `x-ops-dashboard-secret` and `Authorization: Bearer <jwt>`

## Deployment Checklist

- [ ] Vercel project linked to `apps/dashboard` root
- [ ] Framework = Vite, output = `dist`
- [ ] All four env vars set in Vercel Production environment
- [ ] Custom domain `ops.leadcommand.ai` added and DNS pointed
- [ ] Supabase redirect URLs updated to include `ops.leadcommand.ai`
- [ ] At least one operator user created in Supabase Auth
- [ ] Public signup disabled in Supabase
- [ ] CORS on `apps/api` locked to `ops.leadcommand.ai` after domain is live
