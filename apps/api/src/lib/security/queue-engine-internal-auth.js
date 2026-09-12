/**
 * THE CANONICAL QUEUE-ENGINE OPERATIONAL CREDENTIAL.
 *
 * INTERNAL-AUTH DRIFT, and what it cost.
 *
 * Two internal routes on the same operational path resolved their credential
 * from different places:
 *
 *   /api/internal/queue/run              requireScopedCanaryExecutionAuth
 *                                        env, falling back to
 *                                        system_control.queue_engine_shared_secret
 *
 *   /api/internal/campaigns/enqueue-target-one
 *                                        requireInternalSecret
 *                                        Worker env ONLY
 *
 * In production the Worker has INTERNAL_API_SECRET / CRON_SECRET set but NOT
 * QUEUE_ENGINE_SHARED_SECRET, so the canonical control-plane credential
 * authenticated the DISPATCH half of a scoped canary and was rejected by the
 * ENQUEUE half. The queue engine could be told to send a row it was not
 * allowed to create - which made the single-row live proof unrunnable through
 * production paths, and would have pushed any operator toward hand-writing
 * send_queue rows that bypass suppression, DNC, the 24h guard, contact window,
 * sender selection and template fencing.
 *
 * THIS IS AUTHENTICATION ONLY. It answers "is this caller the queue engine?"
 * and nothing else. Every authorization decision downstream is untouched:
 * enqueue still runs its own eligibility stack, and queue/run still requires
 * queue_execution_mode, a proof session, a canary_run_id and an exact
 * single-row allowlist. A valid credential buys entry to the check, never past
 * it.
 *
 * ROTATION IS DELIBERATE. Every configured source is accepted concurrently so
 * a rotation can land in the Worker and the control plane at different times
 * without a window where the engine cannot talk to itself. Comparison is
 * constant-time against each candidate.
 *
 * LEAST PRIVILEGE. This helper is for queue-engine EXECUTION routes only. The
 * other seventeen requireInternalSecret routes - acquisition scoring, the AI
 * router, automation rules, Discord, inbound purges, ops scans - keep
 * env-only auth. The control-plane credential must not become a skeleton key
 * for every internal endpoint.
 */

import { getSystemValue } from "@/lib/system-control.js";
import { timingSafeSecretEqual } from "@/lib/security/shared-secret.js";

function clean(value) {
  return String(value ?? "").trim();
}

/** Header names a queue-engine caller may present. */
const CREDENTIAL_HEADERS = Object.freeze([
  "x-queue-engine-secret",
  "x-internal-api-secret",
  "x-cron-secret",
]);

function readProvidedCredential(request) {
  for (const header of CREDENTIAL_HEADERS) {
    const value = clean(request?.headers?.get?.(header));
    if (value) return value;
  }
  const authorization = clean(request?.headers?.get?.("authorization"));
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return clean(authorization.slice(7));
  }
  return "";
}

/**
 * Every credential currently valid for the queue engine.
 *
 * Order is irrelevant - all are accepted - which is the whole point of
 * supporting a rotation window. Returns [] when nothing is configured, and the
 * caller MUST treat that as a denial rather than as "no opinion".
 */
export async function resolveQueueEngineOperationalSecrets() {
  const env_secrets = [
    process.env.SCOPED_CANARY_EXECUTION_SECRET,
    process.env.QUEUE_ENGINE_SHARED_SECRET,
    process.env.INTERNAL_API_SECRET,
    process.env.CRON_SECRET,
  ].map(clean).filter(Boolean);

  let control_plane_secret = "";
  try {
    control_plane_secret = clean(await getSystemValue("queue_engine_shared_secret"));
  } catch {
    // An unreadable control plane is not a licence to authenticate; it simply
    // contributes no candidate. If env supplies none either, this denies.
    control_plane_secret = "";
  }

  return [...new Set([...env_secrets, ...(control_plane_secret ? [control_plane_secret] : [])])];
}

/**
 * Authenticate a queue-engine internal request.
 *
 * Never logs, returns or echoes a secret value - only the verdict.
 */
export async function requireQueueEngineInternalAuth(request) {
  const allowed = await resolveQueueEngineOperationalSecrets();
  if (!allowed.length) {
    return { ok: false, error: "internal_secret_not_configured", status: 500 };
  }

  const provided = readProvidedCredential(request);
  if (!provided) return { ok: false, error: "unauthorized", status: 401 };

  // Constant-time against every candidate; no early return on first mismatch.
  let matched = false;
  for (const candidate of allowed) {
    if (timingSafeSecretEqual(provided, candidate)) matched = true;
  }
  if (!matched) return { ok: false, error: "unauthorized", status: 401 };

  return { ok: true };
}

export default requireQueueEngineInternalAuth;
