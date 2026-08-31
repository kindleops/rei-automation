# Remote Container Build + Staging Deploy - DESIGN ONLY

**Nothing here has been executed.** Docker is never started on the development
Mac. This document is the plan; the workflow file and image definition are
written only after the local correctness gates are green.

---

## C. Remote CI architecture

```
push to  release/cloudflare-staging
        |
        v
GitHub-hosted ubuntu-latest runner        <-- all heavy work happens here
        |
        +-- npm ci
        +-- correctness gates
        |     - apps/api  : npm run test:critical
        |     - apps/api  : durable-state concurrency proof vs ephemeral Postgres
        |                   (GitHub `services: postgres` container - remote, not the Mac)
        |     - dashboard : tsc --noEmit -p tsconfig.app.json
        |     - dashboard : npm run assert:fullscreen
        +-- next build (apps/api, output: 'standalone')
        +-- docker build            <-- Docker runs ONLY on the runner
        +-- wrangler containers push  -> registry.cloudflare.com
        +-- wrangler deploy         <-- STAGING worker, registry image reference
```

The Mac only ever does: source edits, focused tests, `vite build`, `next build`,
`tsc --noEmit`, and native Postgres proofs.

**Why this split works:** `wrangler deploy` requires a local Docker engine *only*
when `image` is a path to a Dockerfile. When `image` is a **registry reference**,
no Docker is needed at deploy time. So even a later deploy triggered from the Mac
would not need Docker - though the plan is to deploy from CI anyway.

---

## D. GitHub Actions workflow design

Two jobs, gated in sequence. The build job never runs if the gates fail.

### Job 1 - `gates` (no Docker)

| Step | Command |
| --- | --- |
| checkout | `actions/checkout@v4` |
| node | `actions/setup-node@v4` (node 20) |
| install | `npm ci` |
| api tests | `npm --prefix apps/api run test:critical` |
| durable proof | apply migration to the `services: postgres` instance, then run `scripts/proof/durable-state-concurrency-proof.mjs` with `DURABLE_STATE_PROOF_DB_URL=postgres://...@127.0.0.1:5432/...` |
| dashboard typecheck | `npx tsc --noEmit -p apps/dashboard/tsconfig.app.json` |
| dashboard build | `npm --prefix apps/dashboard run build` |
| fullscreen guard | `npm --prefix apps/dashboard run assert:fullscreen` |

The proof's fail-closed host allowlist already permits only loopback, and the
GitHub `services:` Postgres is reached on `127.0.0.1`, so the guard passes
without weakening it.

### Job 2 - `image` (needs: gates, Docker allowed)

| Step | Command |
| --- | --- |
| checkout / node / install | as above |
| build api | `npm --prefix apps/api run build` (with `output: 'standalone'`) |
| build + push image | `npx wrangler containers build -p -t rei-api:${{ github.sha }} .` |
| deploy staging | `npx wrangler deploy --env staging` |

`wrangler containers build -p` builds and pushes in one step. Alternatively
`docker build` + `npx wrangler containers push rei-api:<tag>`.

### Concurrency / safety

- `concurrency: { group: cloudflare-staging, cancel-in-progress: false }`
- Triggered by push to the staging branch **only**; never on `main`.
- No production deploy step exists in this workflow at all.

---

## E. Proposed image registry - Cloudflare managed registry

**Recommendation: `registry.cloudflare.com` (the Cloudflare managed registry).**

| Option | Verdict |
| --- | --- |
| **Cloudflare Registry** | **CHOSEN.** Account-integrated, backed by R2, auth handled automatically by Cloudflare on both push and pull. Private by default. No egress charges. Layer-diff pushes on subsequent deploys. |
| Docker Hub (private) | Works, but adds pull limits / fair-use exposure and a second credential to manage. |
| Amazon ECR | Works, but pulls incur AWS egress charges - reintroduces a cloud bill we are trying to remove. |
| Google Artifact Registry | Same egress-charge objection as ECR. |

Cloudflare Registry keeps the image **private** without any public exposure,
which satisfies "do not expose a private production image publicly merely for
convenience."

Image reference in Wrangler config:

```
registry.cloudflare.com/<ACCOUNT_ID>/rei-api:<TAG>
```

CI push path is explicitly documented by Cloudflare: install `wrangler`, then
`wrangler containers build --push` or `wrangler containers push`.

---

## F. Secret / variable NAMES required

**NAMES ONLY. No values are recorded here, and none were printed.**

### GitHub Actions repository secrets

| Name | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | wrangler auth for push + deploy |
| `CLOUDFLARE_ACCOUNT_ID` | registry path and deploy target |

The gates job needs no production credentials: it runs against an ephemeral
Postgres service container and never contacts Supabase, TextGrid or SMTP.

### Cloudflare Container environment (staging)

Core:
`NODE_ENV`, `APP_BASE_URL`, `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `LOG_LEVEL`

New in this change:
`RUNTIME_STATE_BACKEND` (must be `postgres`; `memory` is refused when
`NODE_ENV=production`)

Auth / shared secrets:
`INTERNAL_API_SECRET`, `CRON_SECRET`, `OPS_DASHBOARD_SECRET`,
`TEXTGRID_WEBHOOK_SECRET`, `BUYER_WEBHOOK_SECRET`, `TITLE_WEBHOOK_SECRET`,
`CLOSINGS_WEBHOOK_SECRET`, `DOCUSIGN_WEBHOOK_SECRET`

Providers:
`TEXTGRID_ACCOUNT_SID`, `TEXTGRID_AUTH_TOKEN`, `TEXTGRID_API_BASE_URL`,
`OPENAI_KEY`, `DOCUSIGN_API_KEY`, `DOCUSIGN_BASE_URL`

SMTP (connectivity proof only, no AUTH, no sends):
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`,
`SMTP_FROM_NAME`

Storage - note the real prefix is `STORAGE_S3_*`, not `S3_*`:
`STORAGE_PROVIDER`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_LOCAL_ROOT`,
`STORAGE_SIGNING_SECRET`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_ACCESS_KEY_ID`,
`STORAGE_S3_SECRET_ACCESS_KEY`, `STORAGE_S3_FORCE_PATH_STYLE`

Containment (must be set to keep staging inert):
`ENABLE_LIVE_SENDING`, `AUTOMATION_LIVE_SENDS_ENABLED`,
`WORKFLOW_LIVE_SENDS_ENABLED`, `ROLLOUT_MODE`

---

## BLOCKER FOUND DURING THIS PASS - `VERCEL_ENV` is load-bearing

`VERCEL_ENV` will be **unset** on Cloudflare. Most call sites are written
`NODE_ENV === "production" || VERCEL_ENV === "production"` and therefore still
behave correctly once `NODE_ENV=production` is set.

**One is not.** `src/lib/security/cron-auth.js:28` uses `VERCEL_ENV` as its
**sole** production detector:

```js
const is_vercel_production = clean(process.env.VERCEL_ENV).toLowerCase() === "production";
// ...
if (!cron_secret) {
  if (is_vercel_production) return { ok: false, status: 500, reason: "missing_cron_secret" };
  return { ok: true, authenticated: false, required: false, reason: "cron_secret_not_configured" };
}
```

On Cloudflare this evaluates false, so a **missing `CRON_SECRET` fails OPEN**
instead of returning 500.

Two mitigations, both wanted:
1. **Compensating control (mandatory):** `CRON_SECRET` must be set in the
   container environment. With it set, the fail-open branch is unreachable.
2. **Fix before cutover:** make the detector `NODE_ENV === "production" ||
   VERCEL_ENV === "production"`. Not done in this change because it is a
   behavioural edit outside the approved durability scope.

Also affected, lower severity:
- `is_vercel_cron` matches user-agent `vercel-cron/1.0`; Cloudflare Cron
  Triggers will not send it. Needs review of downstream use.
- `/api/version` will report `env: "development"` and `deployment_id: null`,
  making provenance misleading.

---

## G. Staging deployment sequence

1. Apply migration `20260831000000_durable_run_locks_and_idempotency_ledger.sql`
   to the target database. **Additive only** - creates two new tables and their
   functions, touches nothing existing.
2. Set the staging container environment, including
   `RUNTIME_STATE_BACKEND=postgres` and `CRON_SECRET`.
3. Push the staging branch; let CI run the gates.
4. CI builds and pushes the image to `registry.cloudflare.com`.
5. CI deploys the **staging** Worker with `max_instances = 1`.
6. Run the staging proof list from `topology-contract.md` section 4
   (boot, read routes, Postgres TCP, restart, lock survival, ledger survival,
   SMTP connect-and-QUIT only).
7. Soak. Only then consider DNS - which is a separate, explicitly approved step.

**Not in this sequence:** DNS changes, `ops.leadcommand.ai`, production sends,
unpausing the queue, raising instance count.
