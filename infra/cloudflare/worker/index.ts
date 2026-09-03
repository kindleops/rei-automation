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
    // Note: /api/internal/inbox/send-now NO LONGER bypasses the queue emergency
    // stop. It now goes through the same canonical runtime send authority as
    // normal queue execution (emergency stop + queue_processor_mode +
    // queue_execution_mode, fail-closed), so containment no longer rests solely
    // on withholding TEXTGRID_* and INTERNAL_API_SECRET. Those remain withheld
    // as defence in depth, not as the only guard.
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
      //
      // The one registered schedule does not weaken this. It maps to a single
      // delivery-outcome reconciler that cannot write a claimable queue row,
      // and no queue runner, campaign feed or autopilot job is registered for
      // any environment. See CRON_JOBS_BY_ENV.
      //
      // FORMER EXCEPTION, NOW CLOSED: /api/internal/inbox/send-now used to
      // evaluate the runtime brake with failClosed:false and proceed anyway,
      // recording the blocked verdict as metadata. It now goes through the same
      // canonical runtime send authority as normal queue execution. An internal
      // secret authenticates a caller; it does not confer send authority.
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

    // DEFAULT DENY, TWICE OVER. An unrecognised DEPLOYMENT_ENV resolves to an
    // EMPTY job table, and an expression absent from that table resolves to an
    // empty job list. A schedule can therefore only ever fire a job that was
    // written down for THAT environment by name.
    const table = CRON_JOBS_BY_ENV[String(env.DEPLOYMENT_ENV ?? "")] ?? {};
    const jobs = table[event.cron] ?? [];
    if (jobs.length === 0) {
      console.log(
        `cron.skipped cron=${event.cron} env=${env.DEPLOYMENT_ENV ?? "unset"} reason=no_job_registered`
      );
      return;
    }

    for (const job of jobs) {
      ctx.waitUntil(
        forwardToApi(
          new Request(`https://internal.invalid${job.path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.CRON_SECRET}`,
              // Provider-neutral provenance. NOT an authenticator.
              "x-internal-cron-source": "cloudflare",
              "user-agent": "cloudflare-cron/1.0",
              ...(job.body ? { "content-type": "application/json" } : {}),
            },
            ...(job.body ? { body: JSON.stringify(job.body) } : {}),
          }),
          env
        ).then(
          (r) => console.log(`cron.done cron=${event.cron} path=${job.path} status=${r.status}`),
          (e) => console.error(`cron.failed cron=${event.cron} path=${job.path} error=${e}`)
        )
      );
    }
  },
};

/**
 * CRON JOB TABLE -- scoped BY DEPLOYMENT ENVIRONMENT.
 *
 * Previously a single shared map keyed only by cron expression. That made the
 * schedule list the ONLY thing standing between production and 13 jobs,
 * including queue/run, campaign feed and campaign activation. Adding one
 * trigger expression to production would have fired every job sharing it.
 *
 * Now the environment selects the table first. Production physically cannot
 * reach a job that is not written in PRODUCTION_CRON_JOBS, whatever triggers a
 * wrangler config declares and whatever CRON_ENABLED is set to.
 *
 * DELIBERATELY ABSENT FROM EVERY TABLE (each can cause a seller-visible send,
 * or arm a row that a later processor would send):
 *   /api/internal/queue/run                      dispatches the send queue
 *   /api/internal/queue/retry                    re-arms failed sends
 *   /api/internal/queue/force-due                pulls schedules forward to now
 *   /api/internal/campaigns/feed                 builds outbound campaign work
 *   /api/internal/campaigns/activate-due         activates campaigns
 *   /api/internal/campaigns/recover-stale-expired  inserts live `scheduled` rows
 *   /api/internal/autopilot/run                  broad autopilot
 *   /api/internal/seller-flow/flush-inbound-bursts   unbraked follow-up leg
 *   /api/internal/seller-flow/recover-inbound        unbraked follow-up leg
 *   /api/internal/webhooks/recover-inbound       drives the auto-reply pipeline
 *   /api/internal/offers/recalculate             mutates monetary state
 */
type CronJob = { path: string; body?: Record<string, unknown> };

/**
 * THE reconciliation job. Chosen because it is send-incapable STRUCTURALLY,
 * not because a flag happens to be off:
 *
 *   - it filters to delivery/status/outbound webhook rows, so it never enters
 *     the seller inbound automation lane at all;
 *   - the only send_queue statuses it can write are delivered/sent/terminal.
 *     The processor claims queued/scheduled/pending/approved/ready -- disjoint
 *     sets, so it cannot produce a claimable row;
 *   - its status merge is monotonic (greatest(current, incoming) rank), so a
 *     row can only move toward terminal, never back toward sendable;
 *   - its setSystemValues call carries no operator authority, so every brake
 *     key is stripped before write. It cannot relax containment.
 *
 * include_polling_fallback:false disables its one outbound provider call (a
 * READ of already-sent message status). With it off the job is pure database
 * reconciliation and makes no external contact whatsoever.
 */
const RECONCILE_DELIVERY_OUTCOMES: CronJob = {
  path: "/api/internal/webhooks/recover-delivery",
  body: { include_polling_fallback: false },
};

const PRODUCTION_CRON_JOBS: Record<string, CronJob[]> = {
  "*/5 * * * *": [RECONCILE_DELIVERY_OUTCOMES],
};

/**
 * STAGING SHARES THE PRODUCTION DATABASE. Its cron surface is therefore held to
 * the same standard as production rather than to a "it is only staging" one.
 * It previously registered 6 expressions covering 13 jobs -- including the send
 * queue runner and the campaign feed -- restrained solely by CRON_ENABLED being
 * the string "false". A single var flip would have run all 13 against real
 * seller data. Staging now mirrors production exactly.
 */
const STAGING_CRON_JOBS: Record<string, CronJob[]> = {
  "*/5 * * * *": [RECONCILE_DELIVERY_OUTCOMES],
};

const CRON_JOBS_BY_ENV: Record<string, Record<string, CronJob[]>> = {
  production: PRODUCTION_CRON_JOBS,
  staging: STAGING_CRON_JOBS,
};
