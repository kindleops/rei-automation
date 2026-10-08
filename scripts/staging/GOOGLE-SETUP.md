# Google Calendar — staging certification (owner steps + proof)

Google is the connected calendar and a busy-time source. The REI Automation
scheduling core owns bookings and routing; Google mirrors them.

## 1. Owner setup (≈10 minutes, no credentials in chat or git)
1. Use a **non-production** Google account created for this (e.g. a new Gmail).
2. https://console.cloud.google.com → signed in as that account → new project
   `rei-scheduling-staging`.
3. APIs & Services → Library → enable **Google Calendar API**.
4. OAuth consent screen → External → app name, support email →
   Scopes: `openid`, `email`, `https://www.googleapis.com/auth/calendar.events`,
   `https://www.googleapis.com/auth/calendar.freebusy` → Test users: the test
   account → leave in **Testing** (refresh tokens then expire after 7 days —
   fine for certification).
5. Credentials → Create OAuth client ID → **Web application** →
   Authorized redirect URI `http://localhost:3201/api/scheduling/google/callback`.
6. Put the client id and secret in `apps/api/.env.scheduling-staging.local`
   (gitignored, mode 600):
   `GOOGLE_CALENDAR_CLIENT_ID=…` and `GOOGLE_CALENDAR_CLIENT_SECRET=…`.
7. Optional, for push notifications: a public HTTPS tunnel to :3201
   (e.g. `cloudflared tunnel --url http://localhost:3201`) and
   `GOOGLE_CALENDAR_WEBHOOK_URL=https://<tunnel>/api/webhooks/google-calendar`.
   Without it the reconciliation tick polls (that is also what certifies
   missed-webhook recovery).

Production later uses a separate OAuth client (Published), redirect
`https://ops.leadcommand.ai/api/scheduling/google/callback`, webhook
`https://ops.leadcommand.ai/api/webhooks/google-calendar`.

## 2. Connect (owner clicks once)
`scripts/staging/run-api.sh`, `node scripts/staging/ops-gateway.mjs`, dashboard
preview on :5174 → sign in as `staging-admin@example.test` (password in the env
file) → Calendar → Appointments → My calendar → **Connect Google calendar** →
choose the test account → **Allow**. The dashboard returns with
`calendar_connection=connected`.

## 3. Proof (11 steps + failure modes)
`node --import ./apps/api/tests/register-live-proof.mjs scripts/proof/scheduling-google-proof.mjs`
with `SCHEDULING_PROOF_SUPABASE_URL` / `_SERVICE_ROLE_KEY` = the staging values
and `SCHEDULING_PROOF_RESOURCE_ID=aaaaaaaa-5eed-4000-8000-000000000001`.
It refuses the production project.

| # | Verifies |
|---|---|
| 1–2 | a busy block created directly in Google is excluded from availability |
| 3–5 | Prominent booking → Google event appears; the second brand cannot book the overlap |
| 6–8 | reschedule → the same Google event moves; the old slot returns |
| 9–11 | cancel → the Google event is removed (policy: delete); the slot returns |
| + | token refresh (every call mints an access token from the refresh token) |
| + | disconnect → credential destroyed; reconnect → new consent, sync resumes |
| + | missed webhook → `POST /api/internal/scheduling/tick` catches up |
| + | Google unavailable → booking still commits, `sync_status=failed` is shown ("Sync failed" + Re-sync in Calendar), never a false "synced"; the tick repairs it |

## Consistency guarantees (exact)
- **Atomic within our database:** no two live appointments overlap on one
  person across brands (exclusion constraint); reschedule is one transaction.
- **Google is checked, not locked:** at booking the chosen person's Google
  busy time is read live (freeBusy) immediately before the INSERT. An event
  someone creates directly in Google in the instant between that read and our
  commit can still overlap. That window cannot be closed — Google is outside
  our transaction — and is not claimed to be.
- **Edits made in Google to our events never change the appointment**: they
  are flagged as drift for a person to resolve; the customer keeps the time
  they were given.
- **Our changes reach Google eventually:** a failed create/move/delete leaves
  `sync_status=failed` and is retried by the tick; the seller-facing booking is
  never shown as calendar-synced unless it is.
