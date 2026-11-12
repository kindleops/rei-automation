# Send-authorization fix (2026-11-11)

Founder authorization 2026-11-11: fix the send-authorization defects found in
Forge's read-only audit (task_fb80ed8096744ed6). Sentry reviews independently.
Deploy to LeadCommand production only after both pass, with a tested rollback.
This change sends nothing, changes no production switch, releases no hold and
reactivates no campaign.

Base: `b9da3ff5` (lc-production-review). The defects are confirmed in code at
both `b9da3ff5` and `c5a7104f` (the `origin/release/cloudflare-production` ref).
The core files are byte-identical between the two.

## What changed

### 1. The internal send routes now require authentication

`/api/internal/outbound/send-now`, `/api/internal/outbound/direct-send`,
`/api/internal/queue/seed-test` and also `/api/internal/outbound/queue-message`
had no credential check. queue-message was not on the audit list, but it queues
a seller SMS the runner will send, and nothing in the repo calls it.
`middleware.js` adds only CORS. The production Worker
(`infra/cloudflare/worker/index.ts`, `fetch`) forwards every non-browser
`/api/*` path straight to the container, so the routes themselves were the only
place a check could happen.

- New `src/lib/security/internal-send-route-auth.js`. It accepts only
  `INTERNAL_API_SECRET`, presented as `x-internal-api-secret` or
  `Authorization: Bearer`. The compare is constant-time. Query strings and
  bodies are never read. It fails closed in **every** environment: if the secret
  is unset it returns 503. CRON_SECRET and the queue-engine secret are **not**
  accepted.
- The check runs before the request body is read and before any lookup, queue
  write or send. In send-now and direct-send it is in the domain handler, so
  the tests exercise it. In seed-test and queue-message it is in the route.

### 2. The kill switches are fresh and fail closed (`src/lib/system-control.js`)

- **Stale.** Every key was cached for 30s, and a write invalidated the cache
  only in the lambda that made it. Kill-switch keys (`queue_emergency_stop_at`,
  `global_send_shutdown_at`, `queue_processor_mode`, `queue_execution_mode`,
  `manual_send_mode`, `outbound_sms_enabled`) are now **never cached**, through
  getSystemValue, getSystemValueFresh, getSystemFlag and getSystemFlags. Tuning
  keys keep the 30s cache.
- **Fail open.** A read error returned null and cached it, and for a brake null
  means "clear". Now a failed read of a STOP key (`queue_emergency_stop_at`,
  `global_send_shutdown_at`) returns `control_plane_unreadable`. That is a
  non-clear marker, which `isEmergencyStopActive` treats as **active**. Failed
  mode reads return null, which each consumer already normalizes to closed. In
  production with no Supabase config, a stop key reads as unreadable rather
  than clear. A failed read is never cached, so recovery is immediate.
- send-now and direct-send used `failClosed: false` and never read
  `global_send_shutdown_at`. They, and seed-test, now share
  `src/lib/domain/outbound/internal-send-preflight.js`. It reads the global
  shutdown, the emergency stop and campaign_mode, uses `failClosed: true`, and
  treats a throwing reader as `control_plane_unreadable`. Every refusal is 423.

### 3. WITHDRAWN: manual sends keep the c5a7104f rule

The earlier draft of this candidate made authenticated manual (Inbox) sends
honour `queue_emergency_stop_at`. **The founder rejected that change, and it
has been withdrawn.** Manual operator sends are intentionally a separate
pathway, and they keep crossing `queue_emergency_stop_at` exactly as
production `c5a7104f` does today.

- `manual-send-authority.js`, `dispatch-manual-operator-send.js`,
  `textgrid.js` and the tests `manual-send-authority-hotfix.test.mjs` and
  `manual-inbox-emergency-stop-enforced.test.mjs` are byte-identical to
  `c5a7104f`.
- The manual rule, unchanged from `c5a7104f`: an authenticated manual send is
  NOT blocked by `queue_emergency_stop_at`. It IS blocked by an active
  `global_send_shutdown_at`, by `manual_send_mode` being anything but exactly
  `enabled`, and by an unreadable control plane. Opt-outs, suppression and
  contact restrictions are evaluated elsewhere and still apply.
- With change 2, a failed read of `global_send_shutdown_at` returns the
  `control_plane_unreadable` marker (active), and a failed read of
  `manual_send_mode` returns null (not enabled). Both deny a manual send, so an
  unreadable control plane still denies it.
- The owner's Inbox send is `POST /api/cockpit/inbox/send-now`
  (`runInboxAction` -> `executeManualInboxSendNow` with the server-side
  operator principal -> `dispatchManualOperatorSend` -> `sendTextgridSMS`). It
  does not go through `/api/internal/outbound/send-now` or `direct-send`, so the
  423 those internal routes return under the emergency stop (as they already
  did at `c5a7104f`) does not touch it.
- Automation is unchanged by this withdrawal: AI, campaign and internal-route
  sends still stop dead on the emergency stop.

### 4. Quiet hours: an automated first message never assumes Chicago

`evaluateCandidateEligibility` in `supabase-candidate-feeder.js` passed
`candidate.timezone || "America/Chicago"` to `evaluateContactWindow`, and
`normalizeCandidateRow` had already stamped Chicago on a blank zone. A lead
with no zone was judged on Central hours.

- The check now uses the zone the lead row actually carried
  (`stored_timezone`, set by `normalizeCandidateRow` before its Chicago
  default). Without a valid one, the shared recipient-zone resolver
  (`recipient-timezone.js`, the same D10 logic the send-time gate uses) places
  the lead from the property's state/ZIP. With neither, the lead is held with
  reason code `TIMEZONE_UNRESOLVED` (reason `recipient_timezone_unresolved`)
  and is not queued, whatever `within_contact_window_now` says.
- A lead with a valid stored zone is evaluated exactly as before.
- The manual path (`send-now-service.js`) is not changed.

## How it was verified

- `node --check` passes on every changed source and test file.
- Tests added or updated (in `apps/api/tests/critical/`):
  - `kill-switch-fail-closed-fresh.test.mjs` (new). Covers: fresh reads across
    writers, an unreadable stop as active through all three authorities, mode
    keys failing closed, no caching of failures, production with no config, and
    tuning keys still cached.
  - `send-now-route.test.mjs` and `direct-send-route.test.mjs`. Cover: missing,
    wrong, query-string, cron and dashboard credentials all get 401 with zero
    dependency calls; an unset secret gets 503 in every environment; absent
    campaign_mode, stop, unreadable stop, global shutdown and a throwing reader
    all get 423 with zero queue or send.
  - `manual-send-authority-hotfix.test.mjs` and
    `manual-inbox-emergency-stop-enforced.test.mjs`. Restored to `c5a7104f`
    (change 3 withdrawn): they assert an authenticated manual send crosses the
    emergency stop and is still denied by the global shutdown,
    `manual_send_mode`, and an unreadable control plane.
  - `feed-candidates.test.mjs`. New quiet-hours test: a lead with no zone is
    held with `TIMEZONE_UNRESOLVED`; a lead with a zone evaluates normally.
  - `scoped-canary-fresh-execution-mode.test.mjs`. Test 1 asserted the stale
    cache, which is the defect, so it now asserts freshness.
- **NOT YET RUN:** `npm --prefix apps/api run test:critical` and `run lint`.
  Running them needed human approval in this session. The worktree also has no
  `node_modules`, so `npm ci` must run first. **Do not treat this as verified
  until both pass.**

## Deploy (a person runs this; agents do not deploy)

Production is the Cloudflare Worker `lead-command-production`
(`infra/cloudflare/wrangler.production.jsonc`, custom domain
`ops.leadcommand.ai`) fronting the API container image
`registry.cloudflare.com/<account>/rei-api:<git sha>`. Vercel is **not**
production for apps/api: `apps/api/vercel.json` carries no crons, and the
commissioning note there says so. No push triggers a production deploy. The
only path is a manual dispatch of `.github/workflows/cloudflare-staging.yml`
with `target=production`. That runs the gates, then
`wrangler containers build apps/api -t rei-api:$GITHUB_SHA --push`, pins the
tag into the production config, and runs `wrangler deploy`.

**Scope warning.** This branch sits on `b9da3ff5`, which is **343 commits
(~169k inserted lines) ahead** of `origin/release/cloudflare-production`
(`c5a7104f`). Deploying this branch ships all of that, which goes far beyond the
authorization. Recommended: apply this diff as a hotfix on `c5a7104f`.

1. Record what production runs now (read-only):
   `curl -s https://ops.leadcommand.ai/api/version`. Note `build_sha` and
   `deployment_id`. Expected: `build_sha` = `c5a7104f…`. If it differs, that
   SHA is the rollback target instead.
   `npx wrangler deployments list --config infra/cloudflare/wrangler.production.jsonc`
   records the current Worker version id.
2. Branch from production and apply this change:
   `git switch -c hotfix/send-authorization c5a7104f`, then
   `git cherry-pick <orchestrator commit of this branch>`. Expect a small
   conflict only in `apps/api/src/lib/providers/textgrid.js` and possibly
   `tests/helpers/critical-test-environment.mjs`.
3. Gate locally: `npm ci && npm --prefix apps/api run test && npm --prefix apps/api run test:critical`.
4. Push the hotfix branch and get Sentry's independent review. Then a person
   runs:
   `gh workflow run cloudflare-staging.yml --ref hotfix/send-authorization -f target=staging`
   to deploy to staging first, and verify there (step 6).
5. Production:
   `gh workflow run cloudflare-staging.yml --ref hotfix/send-authorization -f target=production`
   Do **not** pass `skip_gates`.
6. Verify (no message is sent by any of these):
   - `curl -s https://ops.leadcommand.ai/api/version` should show `build_sha` =
     the hotfix SHA and `build_sha_matches_env: true`.
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://ops.leadcommand.ai/api/internal/outbound/send-now -H 'content-type: application/json' -d '{}'`
     should return **401**. Repeat for `/outbound/direct-send`,
     `/outbound/queue-message` and `/queue/seed-test`. All must be 401.
     Before the fix send-now would have run the brake and returned 423 or 400.
     Never send a request with a valid secret and a real phone number.
   - Read-only: confirm `/api/cockpit/queue/control` (GET) still reports the
     same switch values as before the deploy. Nothing in the deploy writes them.

## Rollback (tested path = redeploy the previous known-good SHA)

- Primary: `gh workflow run cloudflare-staging.yml --ref <previous build_sha from step 1, expected c5a7104f> -f target=production`.
  This rebuilds and redeploys that exact tree and image tag. Then verify
  `/api/version` shows the old `build_sha`. The send routes go back to
  pre-fix behaviour, so treat rollback as re-opening the unauthenticated routes.
- Faster, but not verified for container-backed Workers in this repo:
  `npx wrangler rollback <previous version id from step 1> --config infra/cloudflare/wrangler.production.jsonc`.
  Confirm with `/api/version` afterwards. If `build_sha` did not change, use
  the primary path.
- Rehearse the rollback on staging first: deploy the hotfix to staging, then
  run the primary rollback with `-f target=staging` and confirm `/api/version`
  flips back. That is the "tested rollback" the authorization requires. It has
  **not** been run yet.
