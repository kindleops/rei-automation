# Shared scheduling core

One company-wide availability and appointment layer. Brands are context on an
appointment, not infrastructure. Prominent Cash Offer is client #1; Reivesti,
Everline and SignPro plug in the same way.

```
                  SHARED SCHEDULING CORE  (apps/api/src/lib/domain/scheduling)
     resources ─ connected calendars ─ availability ─ event types ─ routing
                 appointments (system of record) ─ reminders ─ calendar sync
                                     │
        ┌────────────────────────────┼─────────────────────────────┐
   PROMINENT adapter            (REIVESTI adapter)            (SIGNPRO adapter)
   seller portal, contact page   product UI                    product UI
                                     │
                       Google Calendar (per team member, below the brand layer)
```

## Data (supabase/migrations/20261003120000_scheduling_core.sql)
| Table | Purpose |
|---|---|
| `scheduling_resources` | A bookable person (or shared resource): time zone, weekly hours, `ops_user_id` (the Supabase user the ops worker forwards as `x-ops-user-id`), `operator_keys` (values canonical tables use in `assigned_operator`). No second user table. |
| `scheduling_time_off` | PTO, holidays, blocks not on a calendar. |
| `scheduling_pools` / `_pool_members` | Brand-owned qualified pools. Created empty — nobody is assigned by migration. |
| `scheduling_event_types` | Brand-owned appointment types: duration, interval, buffers, notice, horizon, routing, reminder offsets, `environment` (test types are refused in production). |
| `scheduling_appointments` | **The record.** Brand, type, resource, status, times, held block (buffers), customer (name/email/phone), `related_refs` (`opportunity:<id>`, `closing_case:<id>`, `account:<id>` …), source, Google ids, sync status, version, idempotency key. |
| `scheduling_appointment_events` | Ledger and outbox: booked, rescheduled, cancelled, completed, no_show, assigned, drift_detected … |
| `scheduling_calendar_connections` | One Google connection per person: AES-256-GCM refresh-token ciphertext, scopes, health, incremental sync token, push channel. |
| `scheduling_external_busy` | Busy times mirrored from Google — start/end only, no titles. |
| `scheduling_oauth_states` | Single-use OAuth state + PKCE verifier (hashed / encrypted), 10-minute expiry. |

Statuses reuse `scheduled` / `completed` / `cancelled` exactly as Calendar
Nexus (`calendar_manual_events`) uses them, adding `confirmed`, `rescheduled`,
`no_show`. Every table is service-role only (RLS on, no policies, grants revoked).

**`calendar_events` does not exist** in this codebase. `calendar_manual_events`
(Calendar Nexus) is defined in `apps/api/supabase/migrations/20260621130000_calendar_nexus.sql`
but is **not present in production** (verified 2026-10-03); that is a
pre-existing Nexus gap, unrelated to this work. Appointments are shown in the
existing Calendar as a timeline source (`buildAppointmentEvents` in
`calendar-timeline-service.js`), not in a second calendar.

## Conflict prevention — one availability truth
`scheduling_appointments_no_overlap` is an exclusion constraint:
`EXCLUDE USING gist (resource_id WITH =, tstzrange(block_start_at, block_end_at) WITH &&) WHERE status IN ('scheduled','confirmed')`.
Two live appointments can never hold overlapping time on one person, whatever
their brands. Concurrent inserts serialize on the index; the loser gets
`23P01`, which the service turns into the next eligible person or a clean
`409 slot_unavailable` with refreshed availability. Reschedule is the
`scheduling_reschedule_appointment` function: release-and-hold in one
transaction, version-checked.

## Availability
A start is offered only when all hold: inside the person's working hours (in
their zone) with the meeting ending inside the same interval; after
`min_notice`; within `horizon`; and the held block (start − buffer_before →
end + buffer_after) overlaps none of: live appointments of **any brand**, time
off, Google busy. Grid = `slot_interval` from each working interval's start in
local wall time. Wall-time conversion goes through IANA rules (DST gaps don't
exist, overlaps take the first instant) and is memoized.

Google busy comes from the mirror (`scheduling_external_busy`, kept current by
push notifications + the reconciliation tick). If a person's mirror is older
than `SCHEDULING_BUSY_MAX_AGE_MINUTES` (15), a live `freeBusy` is fetched for
them in parallel. **At booking time the chosen person is always checked live**
(cache bypassed); if Google cannot be reached for them, they are skipped, never
booked blind. Public responses contain times only (`start_at`, `end_at`, zone
label) — never people, calendars, titles or reasons.

## Routing (configuration on the event type)
| Strategy | Behaviour |
|---|---|
| `specific_owner` | Owner resolved by the brand adapter (`owner` role). `owner_unavailable: next_available_owner` → only the owner's times; `route_to_pool` → owner preferred, pool when the owner isn't free at that time. No owner + no pool → no availability. |
| `round_robin` | Pool; the free member assigned least recently. |
| `qualified_pool` | Pool; the free member with the fewest upcoming appointments. |
| `fallback_pool` | Any strategy; used only when the primary tier has no time in the window. |

## Google Calendar
* **Ownership.** Our database owns appointments; Google mirrors them. Events are
  `visibility: private`, carry `extendedProperties.private.scheduling_appointment_id`,
  contain no customer phone/email and no deal terms, and are created with
  `sendUpdates=none` (the customer is never a Google attendee, so Google never
  emails or reminds them).
* **Ours → Google.** Book: insert. Reschedule (same person): patch the same
  event. Reschedule to another person: delete there, insert on theirs. Cancel:
  delete (Google keeps it as cancelled). Failures leave `sync_status=failed`;
  the tick retries.
* **Google → ours.** Other events → busy times only (transparent and cancelled
  events are free). Edits to *our* events (moved or deleted in Google) do **not**
  change the appointment — the customer was promised a time. The appointment is
  flagged `drift`, a `drift_detected` event is written, and it appears in
  Calendar → Needs assignment; ops re-asserts (`resync`) or reschedules
  properly. Events carrying our marker without a live appointment are orphans
  and are deleted.
* **OAuth.** Per team member, offline access, PKCE, single-use state bound to
  that person; a person can only connect their own calendar. Scopes: `openid`,
  `email`, `calendar.events`, `calendar.freebusy`. Refresh tokens are encrypted
  with `SCHEDULING_TOKEN_KEYS[SCHEDULING_TOKEN_ACTIVE_KEY]` (AES-256-GCM, key
  id in the ciphertext, rotation without downtime), never logged, never
  returned. `invalid_grant` → connection `needs_reauth` (visible as health).
  Disconnect stops the channel, revokes, and destroys the ciphertext.
* **Sync.** Push channels (`events.watch`, token verified by hash) trigger
  incremental sync (`syncToken`; 410 → full resync). The tick
  (`/api/internal/scheduling/tick`, every 5 min, `CRON_SCHEDULING_ENABLED`)
  catches missed webhooks, renews channels inside 24 h of expiry, retries
  failed syncs, prunes OAuth state.

## Reminders
The core decides when (event type `reminder_offsets_minutes`, default 24 h and
1 h); the brand adapter supplies the template; delivery is the existing email
plane: `email_queue` rows, `source='scheduling'`, sent by email dispatch with
suppression, sender and kill-switch checks. The `scheduling` revalidator drops a
reminder at send time if the appointment was cancelled, rescheduled or moved.
Requires an `email_senders` row for each brand (see the seller-portal deployment
order).

## APIs
* **Client brands:** `POST /api/internal/scheduling/{availability|book|reschedule|cancel}`
  with `x-scheduling-client: <brand_key>` + `x-scheduling-secret`
  (`SCHEDULING_CLIENT_SECRETS` JSON, ≥32 chars each). A brand sees only its own
  appointments.
* **Prominent** calls the core in-process from the seller-portal service
  (`prominent-scheduling-adapter.js`).
* **Ops:** `GET|POST /api/cockpit/scheduling/{appointments|appointment|team|me|connect|disconnect|me|time-off|pool-member|outcome|assign|reschedule|cancel|resync}`.
* **Google:** `GET /api/scheduling/google/callback`, `POST /api/webhooks/google-calendar`.

## Adding a brand
1. Write an adapter: `resolveOwner`, `describe` (calendar title/description,
   no sensitive data), `onChange` (domain exposure + customer messages),
   `reminder` (template). Register it in `scheduling-runtime.js`.
2. Insert its event types and pools as data (a migration like
   `20261003121000_scheduling_prominent_types.sql`).
3. Issue it a client secret in `SCHEDULING_CLIENT_SECRETS`.
Nothing in the core changes.

## Observability
Structured logs (no message bodies, no document data, no tokens):
`scheduling.availability_failed`, `scheduling.google_auth_expired`,
`scheduling.sync_failed`, `scheduling.booking_conflict`,
`scheduling.notification_failed`, `scheduling.webhook_rejected`,
`scheduling.orphan_calendar_event`, `scheduling.drift_detected`,
`scheduling.reconcile` (with counts and timings); Google calls report
`{op, ms, status}` through the `google_api` metric hook.

## Environment
| Variable | Purpose |
|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` | OAuth client (Google Cloud, "Web application"); redirect = `<api>/api/scheduling/google/callback` |
| `GOOGLE_CALENDAR_WEBHOOK_URL` | `<public api>/api/webhooks/google-calendar` (HTTPS; without it, the tick polls) |
| `SCHEDULING_TOKEN_KEYS` / `SCHEDULING_TOKEN_ACTIVE_KEY` | `{"k1":"<base64 32 bytes>"}` / `k1` |
| `SCHEDULING_CLIENT_SECRETS` | `{"<brand>":"<secret>"}` for non-Prominent clients |
| `SCHEDULING_OPS_APP_URL` | dashboard origin for OAuth return and calendar links |
| `SCHEDULING_BUSY_MAX_AGE_MINUTES` | default 15 |
| `SCHEDULING_ALLOW_TEST_TYPES` | `1` only on staging, to serve `environment='test'` types |
| `CRON_SCHEDULING_ENABLED` | Cloudflare worker flag for the tick |

## Proofs
* `apps/api/tests/critical/scheduling-core.test.mjs` — DST, rules, routing,
  cross-brand blocking, concurrent last-slot race (exactly one wins), 25-way
  cross-brand race, Google create/move/cancel, drift, orphans, webhook auth,
  OAuth single-use + encryption, reminders, brand isolation.
* `scripts/proof/scheduling-db-proof.mjs` — the real migrations on Postgres 17
  (PGlite, in-process): exclusion constraint, adjacency, release, atomic
  reschedule, version check, anon/authenticated lockout.
* `scripts/proof/scheduling-staging-race.mjs` — N simultaneous sessions on a
  staging database (refuses production).
* `scripts/proof/scheduling-google-proof.mjs` — the 11-step Google sequence on
  a test calendar (refuses production).
