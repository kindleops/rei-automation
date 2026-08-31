/**
 * Lead Command front door. SOURCE ONLY -- not deployed.
 *
 *   /        -> dashboard static assets (SPA fallback)
 *   /api/*   -> apps/api Container
 *   cron     -> scheduled() invokes the API over the SAME authenticated
 *               contract an external caller would use
 */

import { Container, getContainer } from "@cloudflare/containers";

export class ApiContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "10m";
}

interface Env {
  ASSETS: Fetcher;
  API_CONTAINER: DurableObjectNamespace<ApiContainer>;
  CRON_SECRET?: string;
  CRON_ENABLED?: string;
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
