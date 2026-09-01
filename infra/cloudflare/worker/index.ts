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

      // Belt-and-braces alongside credential absence.
      ENABLE_LIVE_SENDING: "false",
      AUTOMATION_LIVE_SENDS_ENABLED: "false",
      WORKFLOW_LIVE_SENDS_ENABLED: "false",

      ...(env.DEPLOYMENT_ID ? { DEPLOYMENT_ID: env.DEPLOYMENT_ID } : {}),
      ...(env.DEPLOY_GIT_SHA ? { DEPLOY_GIT_SHA: env.DEPLOY_GIT_SHA } : {}),
      ...(env.SUPABASE_URL ? { SUPABASE_URL: env.SUPABASE_URL } : {}),
      ...(env.SUPABASE_SERVICE_ROLE_KEY
        ? { SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY }
        : {}),
      ...(env.APP_BASE_URL ? { APP_BASE_URL: env.APP_BASE_URL } : {}),
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
  APP_BASE_URL?: string;
  DEPLOYMENT_ENV?: string;
  DEPLOYMENT_ID?: string;
  DEPLOY_GIT_SHA?: string;
}

/**
 * PWA / caching contract. These headers are the reason the installed iOS PWA
 * updates correctly; a stale sw.js or manifest silently serves an old build.
 */
function applyAssetHeaders(request: Request, response: Response): Response {
  const path = new URL(request.url).pathname;
  const headers = new Headers(response.headers);

  if (path === "/sw.js" || path.endsWith("/sw.js")) {
    // NEVER cache the service worker: a cached sw.js pins users to an old build.
    headers.set("Cache-Control", "no-store, must-revalidate");
  } else if (path === "/manifest.webmanifest") {
    // Must be same-origin readable with credentials for the installed PWA.
    headers.set("Cache-Control", "no-cache");
    headers.set("Content-Type", "application/manifest+json");
  } else if (path.startsWith("/assets/")) {
    // Vite emits content-hashed filenames, so these are safe to pin forever.
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (path === "/" || path.endsWith(".html")) {
    // The HTML shell must revalidate or a new deploy is never picked up.
    headers.set("Cache-Control", "no-cache");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

    return applyAssetHeaders(request, await env.ASSETS.fetch(request));
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
