/**
 * Lead Command front door. SOURCE ONLY -- not deployed.
 *
 *   /        -> dashboard static assets (SPA fallback)
 *   /api/*   -> apps/api Container
 *   cron     -> scheduled() invokes the API over the SAME authenticated
 *               contract an external caller would use
 */

import { Container, getContainer } from "@cloudflare/containers";

export class ApiContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "10m";

  // Needs outbound internet for Postgres/Supabase.
  enableInternet = true;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // EXPLICIT ALLOWLIST. Never spread `...env` here.
    //
    // Absence of credentials IS the staging containment boundary, so the
    // container must only ever receive variables named here. A blanket spread
    // would silently forward any future Worker secret -- TextGrid, SMTP,
    // CRON_SECRET -- and quietly make staging send-capable.
    //
    // Specifically NOT forwarded, and not to be added without an explicit
    // decision: TEXTGRID_*, SMTP_*, BREVO_*, INTERNAL_API_SECRET, CRON_SECRET,
    // *_WEBHOOK_SECRET, QUEUE_ENGINE_SHARED_SECRET, OPENAI_KEY.
    //
    // Note: the live-send flags below do NOT govern /api/internal/inbox/send-now,
    // which bypasses the queue emergency stop by design. That path is contained
    // solely by the absence of TEXTGRID_* and INTERNAL_API_SECRET.
    this.envVars = {
      NODE_ENV: "production",
      // Must be postgres. The durability layer throws rather than falling back
      // to in-process state under NODE_ENV=production.
      RUNTIME_STATE_BACKEND: "postgres",
      DEPLOYMENT_ENV: env.DEPLOYMENT_ENV ?? "staging",
      DEPLOYMENT_PROVIDER: "cloudflare",
      DEPLOYMENT_PROJECT: "rei-automation-api",

      // Default-deny. Only an explicit "true" in Worker vars enables these, so
      // a missing/typo'd value fails closed rather than open.
      ENABLE_LIVE_SENDING: env.ENABLE_LIVE_SENDING === "true" ? "true" : "false",
      AUTOMATION_LIVE_SENDS_ENABLED:
        env.AUTOMATION_LIVE_SENDS_ENABLED === "true" ? "true" : "false",
      WORKFLOW_LIVE_SENDS_ENABLED:
        env.WORKFLOW_LIVE_SENDS_ENABLED === "true" ? "true" : "false",

      ...(env.DEPLOYMENT_ID ? { DEPLOYMENT_ID: env.DEPLOYMENT_ID } : {}),
      ...(env.DEPLOY_GIT_SHA ? { DEPLOY_GIT_SHA: env.DEPLOY_GIT_SHA } : {}),
      ...(env.SUPABASE_URL ? { SUPABASE_URL: env.SUPABASE_URL } : {}),
      ...(env.SUPABASE_SERVICE_ROLE_KEY
        ? { SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY }
        : {}),
      ...(env.APP_BASE_URL ? { APP_BASE_URL: env.APP_BASE_URL } : {}),

      // Core commissioning additions. Non-provider: none of these can emit
      // outbound traffic on their own.
      //   SUPABASE_DB_URL     - direct pg pool, used only by the map-filter modules
      //   OPS_DASHBOARD_SECRET- gates cockpit READ routes
      //   INTERNAL_API_SECRET - gates /api/internal/* authentication
      //
      // STILL WITHHELD, deliberately: TEXTGRID_* (SMS transport), CRON_SECRET,
      // QUEUE_ENGINE_SHARED_SECRET, SCOPED_CANARY_EXECUTION_SECRET.
      // Note INTERNAL_API_SECRET alone does NOT make the box send-capable:
      // inbox/send-now still needs TEXTGRID_* to reach a transport, and
      // sendTextgridSMS throws without credentials before any network call.
      ...(env.SUPABASE_DB_URL ? { SUPABASE_DB_URL: env.SUPABASE_DB_URL } : {}),
      ...(env.OPS_DASHBOARD_SECRET
        ? { OPS_DASHBOARD_SECRET: env.OPS_DASHBOARD_SECRET }
        : {}),
      ...(env.INTERNAL_API_SECRET
        ? { INTERNAL_API_SECRET: env.INTERNAL_API_SECRET }
        : {}),

      // Inbound webhook SIGNATURE VERIFICATION only. This is a verifier, not a
      // transport: it lets the container reject forged inbound callbacks. It
      // cannot originate anything. TEXTGRID_ACCOUNT_SID / TEXTGRID_AUTH_TOKEN
      // remain withheld, so sendTextgridSMS still throws before any network
      // call and SMS stays physically impossible.
      ...(env.TEXTGRID_WEBHOOK_SECRET
        ? { TEXTGRID_WEBHOOK_SECRET: env.TEXTGRID_WEBHOOK_SECRET }
        : {}),

      // OUTBOUND SMS TRANSPORT. From here the container CAN send.
      //
      // Automated sending stays blocked by four independent controls:
      //   1. queue_emergency_stop_active = true   (DB)
      //   2. queue_processor_mode        = off    (DB)
      //   3. queue_execution_mode        = scoped_canary_only (DB)
      //   4. ENABLE_LIVE_SENDING/AUTOMATION_/WORKFLOW_ = false (env, default-deny)
      // plus cron is unregistered, so nothing invokes a runner.
      //
      // KNOWN EXCEPTION: /api/internal/inbox/send-now evaluates the runtime
      // brake with failClosed:false and proceeds anyway, recording
      // bypassed_queue_emergency_stop. It is guarded only by
      // INTERNAL_API_SECRET and its own compliance/suppression checks. That is
      // existing product behaviour, deliberately unchanged here.
      ...(env.TEXTGRID_ACCOUNT_SID
        ? { TEXTGRID_ACCOUNT_SID: env.TEXTGRID_ACCOUNT_SID }
        : {}),
      ...(env.TEXTGRID_AUTH_TOKEN
        ? { TEXTGRID_AUTH_TOKEN: env.TEXTGRID_AUTH_TOKEN }
        : {}),
    };
  }
}

interface Env {
  ASSETS: Fetcher;
  API_CONTAINER: DurableObjectNamespace<ApiContainer>;
  CRON_SECRET?: string;
  CRON_ENABLED?: string;
  // Commissioning credentials. Deliberately a SHORT list -- see ApiContainer.
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_DB_URL?: string;
  OPS_DASHBOARD_SECRET?: string;
  INTERNAL_API_SECRET?: string;
  TEXTGRID_WEBHOOK_SECRET?: string;
  TEXTGRID_ACCOUNT_SID?: string;
  TEXTGRID_AUTH_TOKEN?: string;
  APP_BASE_URL?: string;
  DEPLOYMENT_ENV?: string;
  DEPLOYMENT_ID?: string;
  DEPLOY_GIT_SHA?: string;
  // Outbound enablement. Absent => "false". Flipping these is a deliberate
  // commissioning act performed in the dashboard, never a code change.
  ENABLE_LIVE_SENDING?: string;
  AUTOMATION_LIVE_SENDS_ENABLED?: string;
  WORKFLOW_LIVE_SENDS_ENABLED?: string;
}

async function forwardToApi(request: Request, env: Env): Promise<Response> {
  // Single named instance: the conservative first topology. Raising instance
  // count is gated on docs/cloudflare/topology-contract.md.
  return getContainer(env.API_CONTAINER, "api-singleton").fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return forwardToApi(request, env);
    }

    // Static assets are served directly. Their cache/Content-Type contract
    // lives in apps/dashboard/static/_headers, which Cloudflare applies to
    // asset responses -- one source of truth, not two.
    return env.ASSETS.fetch(request);
  },

  /**
   * Cloudflare Cron Trigger entrypoint.
   *
   * Authentication is CRON_SECRET, exactly as before -- the provenance header
   * is metadata only and never authenticates. See lib/security/cron-auth.js.
   *
   * INERT BY DEFAULT: staging sets CRON_ENABLED=false so deploying this Worker
   * does not start firing real work against production data.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (String(env.CRON_ENABLED ?? "false").toLowerCase() !== "true") {
      console.log(`cron.skipped cron=${event.cron} reason=CRON_ENABLED_false`);
      return;
    }

    if (!env.CRON_SECRET) {
      // Fail closed and loudly. The API would reject us anyway (missing secret
      // in a production runtime is a 500 there), but do not even send it.
      console.error(`cron.skipped cron=${event.cron} reason=CRON_SECRET_missing`);
      return;
    }

    const routes = CRON_ROUTES[event.cron] ?? [];
    for (const path of routes) {
      ctx.waitUntil(
        forwardToApi(
          new Request(`https://internal.invalid${path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.CRON_SECRET}`,
              // Provider-neutral provenance. NOT an authenticator.
              "x-internal-cron-source": "cloudflare",
              "user-agent": "cloudflare-cron/1.0",
            },
          }),
          env
        ).then(
          (r) => console.log(`cron.done cron=${event.cron} path=${path} status=${r.status}`),
          (e) => console.error(`cron.failed cron=${event.cron} path=${path} error=${e}`)
        )
      );
    }
  },
};

/**
 * Expressions preserved verbatim from apps/api/vercel.json. Cloudflare fires
 * one scheduled() per distinct expression, so routes sharing a schedule are
 * grouped here rather than duplicated as separate triggers.
 */
const CRON_ROUTES: Record<string, string[]> = {
  "* * * * *": [
    "/api/internal/queue/run",
    "/api/internal/seller-flow/flush-inbound-bursts",
  ],
  "*/2 * * * *": [
    "/api/internal/webhooks/recover-delivery",
    "/api/internal/webhooks/recover-inbound",
  ],
  "*/5 * * * *": [
    "/api/internal/autopilot/run",
    "/api/internal/campaigns/activate-due",
    "/api/internal/campaigns/feed",
    "/api/internal/seller-flow/recover-inbound",
    "/api/internal/inbound/disposition-slo-scan",
  ],
  "*/10 * * * *": [
    "/api/internal/queue/retry",
    "/api/internal/outbound/feed-master-owners",
    "/api/internal/maintenance/reap-graph-runs",
  ],
  "*/15 * * * *": ["/api/internal/queue/reconcile"],
  "30 8 * * *": ["/api/internal/inbound/ledger-retention-purge"],
};
