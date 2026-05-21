# REI Automation Monorepo Migration Plan

## Objective
Create a single monorepo with strict boundaries:
- `apps/api` = backend source of truth
- `apps/dashboard` = frontend cockpit only
- `packages/shared` = shared types/constants/schemas only (no service-role clients, no TextGrid, no mutations)

Target structure:

```text
rei-automation/
  apps/api/
  apps/dashboard/
  packages/shared/
  scripts/ops/
  scripts/proof/
  supabase/migrations/
  docs/architecture/
  docs/incidents/
```

## Hard Boundary Rules
1. Business logic stays in `apps/api`; never in dashboard.
2. Dashboard must not directly mutate `send_queue`, `message_events`, `inbox_thread_state`, or seller-facing tables.
3. Backend owns Supabase schema, queue, TextGrid, classification, auto-replies, follow-ups, templates, seller identity, incident scripts.
4. Dashboard owns UI, display, filters, maps, inbox/list/queue/calendar/metrics views, and API consumption.
5. Root `supabase/migrations/` is canonical. `apps/dashboard` must not own migrations. Migration execution is owned by `apps/api`.

## Environment Variable Ownership

### apps/api
Allowed (examples):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `INTERNAL_API_SECRET`, `OPS_DASHBOARD_SECRET`, `CRON_SECRET`
- `TEXTGRID_*`
- `OPENAI_KEY` / model provider secrets
- integration/webhook secrets

### apps/dashboard
Allowed (browser-safe + backend URL only):
- `VITE_BACKEND_API_URL` (or equivalent backend base URL)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- UI/provider keys that are explicitly safe for browser exposure

Not allowed in dashboard:
- service-role secrets
- browser-exposed secrets (`VITE_*SECRET`)
- backend shared secrets exposed to browser

Protected actions must use server-side proxy/auth or backend-controlled auth.

## Endpoint Contract for Dashboard

### Read / Cockpit Endpoints
- `GET /api/internal/dashboard/nexus`
- `GET /api/internal/dashboard/inbox/live`
- `GET /api/internal/queue/status`
- `GET /api/internal/inbox/thread-context`
- `GET /api/internal/analytics/*` (read-only analytics)

### Protected Mutation / Action Endpoints
- `POST /api/internal/queue/run`
- `POST /api/internal/queue/retry`
- `POST /api/internal/queue/reconcile`
- `POST /api/internal/queue/reprocess-paused`
- `POST /api/internal/queue/cancel-stale-followups`
- `POST /api/internal/inbox/send-now`
- `PATCH /api/internal/dashboard/inbox/thread-state`
- `POST /api/internal/offers/underwrite` (if mutating/persisting side effects)

All mutation/action endpoints must be authenticated server-side and executed only in `apps/api`.

## Script Migration Policy
Do **not** promote dashboard `proof/repair/backfill/mutation` scripts blindly.

- Backend-owned ops/proof scripts move to root:
  - `apps/api/scripts/**` -> `scripts/ops/` and `scripts/proof/` (manual review required)
- Dashboard scripts default to quarantine until reviewed:
  - `apps/dashboard/scripts/repair/**`
  - `apps/dashboard/scripts/ops/**`
  - `apps/dashboard/scripts/proof/**` (only pure UI proof scripts may later be approved)

## Pre-Migration Gate (Must Pass Before Any Move)
Owner: Platform + App Owners  
Risk: Moving with red baseline hides migration regressions.

Done criteria:
- `real-estate-automation` builds cleanly.
- `nexus-dashboard` builds cleanly.
- Known baseline blocker fixed: `src/lib/data/inboxWorkflowData.ts` unused `supabase` declaration (previous TS6133).

Commands:
```bash
cd /Users/ryankindle/real-estate-automation && npm run build
cd /Users/ryankindle/nexus-dashboard && npm run build
```

Rollback:
- If either build fails, stop migration planning execution and fix baseline first.

## Phase Plan

### Phase 1: Monorepo Scaffold
Owner: Platform
Risk: Path/layout drift and broken references.

Done criteria:
- Monorepo directories created.
- Workspace root configured.
- Existing repos remain untouched.

Commands:
```bash
rm -f /Users/ryankindle/rei-automation
mkdir -p /Users/ryankindle/rei-automation/{apps,packages/shared,scripts/{ops,proof},supabase/migrations,docs/{architecture,incidents}}
cd /Users/ryankindle/rei-automation
cat > package.json <<'JSON'
{
  "name": "rei-automation",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
JSON
```

Rollback:
- Remove scaffold directory; no source repos modified.

---

### Phase 2: Import Repos Without Behavior Changes
Owner: Platform + App Owners
Risk: Hidden file omissions and accidental behavior changes.

Done criteria:
- `apps/api` and `apps/dashboard` copied in full (minus `.git`).
- No runtime edits yet.

Commands:
```bash
rsync -a --exclude .git /Users/ryankindle/real-estate-automation/ /Users/ryankindle/rei-automation/apps/api/
rsync -a --exclude .git /Users/ryankindle/nexus-dashboard/ /Users/ryankindle/rei-automation/apps/dashboard/
```

Rollback:
- Delete imported app folders and recopy.

---

### Phase 3: Canonicalize Migrations
Owner: Backend Owner
Risk: Split-brain schema history.

Done criteria:
- Root `supabase/migrations/` is canonical source.
- `apps/dashboard/supabase/migrations` removed or archived as non-authoritative.
- Migration runner docs point only to backend flow.

Commands:
```bash
rsync -a /Users/ryankindle/rei-automation/apps/api/supabase/migrations/ /Users/ryankindle/rei-automation/supabase/migrations/
# manual review and merge of dashboard-only migrations into canonical history if still needed
```

Rollback:
- Restore migration snapshot from git before merge.

---

### Phase 4: Route Dashboard Mutations to API
Owner: Dashboard + Backend
Risk: Production drift if any direct mutation path remains.

Done criteria:
- Dashboard uses backend client for all protected actions.
- No direct `.insert/.update/.upsert/.delete` against protected tables from dashboard code.
- Protected auth enforced server-side.

Commands:
```bash
# audit dashboard for forbidden mutation patterns
rg -n "from\('send_queue'\)|from\('message_events'\)|from\('inbox_thread_state'\)" apps/dashboard/src
rg -n "\.insert\(|\.update\(|\.upsert\(|\.delete\(" apps/dashboard/src
```

Rollback:
- Keep old dashboard code path behind feature flag until replacement endpoint parity is verified.

---

### Phase 5: Remove Dashboard Shadow Backend
Owner: Dashboard Owner
Risk: Deleting before parity causes broken actions.

Done criteria:
- API replacements exist and are validated.
- Dashboard `api/internal/queue/*`, reclassifier/rebuilder, and admin Supabase mutation utilities removed.
- Dashboard no longer owns mutation scripts.

Commands:
```bash
# remove only after parity verification
# (exact rm commands performed in migration PR with review)
```

Rollback:
- Revert PR restoring removed files; do not deploy switch.

---

### Phase 6: CI Boundary Gates
Owner: Platform
Risk: Future drift reintroduced.

Done criteria:
- CI fails dashboard build on forbidden patterns:
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `VITE_*SECRET`
  - direct `.insert/.update/.upsert/.delete` on `send_queue`, `message_events`, `inbox_thread_state`
  - TextGrid send logic
  - classification logic
  - template rendering logic

Commands (example guard script):
```bash
# secrets
rg -n "SUPABASE_SERVICE_ROLE_KEY|VITE_[A-Z0-9_]*SECRET" apps/dashboard && exit 1

# direct protected table mutations
rg -n "from\('(send_queue|message_events|inbox_thread_state)'\)[\s\S]{0,240}\.(insert|update|upsert|delete)\(" apps/dashboard/src apps/dashboard/api && exit 1

# backend logic leakage
rg -n "textgrid|classif(y|ication)|template[_-]?render|render-template|queue_message|send-now" apps/dashboard/src apps/dashboard/api && exit 1
```

Rollback:
- Keep CI gates in warning mode only temporarily; re-enable fail-fast before deploy cutover.

---

### Phase 7: Verification + Deploy Cutover
Owner: Platform + QA + App Owners
Risk: Production incident during switch.

Done criteria:
- Both apps build independently in monorepo.
- Boundary CI gates pass.
- No production mutation from dashboard.
- Vercel projects switched to monorepo roots only after verification.

Commands:
```bash
cd /Users/ryankindle/rei-automation/apps/api && npm run build
cd /Users/ryankindle/rei-automation/apps/dashboard && npm run build
```

Rollback:
- Keep old repos and deployments untouched until monorepo verified.
- Do not switch production deploy target until both apps pass.
- If post-switch issue occurs, repoint Vercel roots to prior repo deployments immediately.

## Vercel Deployment Strategy
- `rei-api` project -> root directory `apps/api`
- `rei-dashboard` project -> root directory `apps/dashboard`
- Switch project roots only after Phase 7 done criteria pass.

## Global Rollback Plan
1. Keep old repositories untouched and deployable during migration.
2. No production deploy switch until monorepo `apps/api` and `apps/dashboard` both pass builds/tests.
3. Switch Vercel projects to monorepo roots only after end-to-end verification.
4. If any regression appears, rollback by restoring prior Vercel root targets and previous deployment aliases.
