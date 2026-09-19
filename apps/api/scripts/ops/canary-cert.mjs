#!/usr/bin/env node
/**
 * canary-cert.mjs — the governed driver for Campaign canary certification.
 *
 * WHY THIS EXISTS. The certification needs roughly a dozen consecutive calls to
 * two governed endpoints inside a 30-minute credential window. Granting the
 * agent raw `curl` against localhost to achieve that would be a far broader
 * permission than the task needs — it would authorise every localhost mutation
 * in the repo, forever, to finish one proof.
 *
 * So the surface is narrowed HERE instead of in the permission layer. This
 * script can reach exactly two URLs, both governed:
 *
 *   POST /api/internal/queue/run        the scoped-canary queue runner
 *   POST /api/cockpit/queue/reschedule  the canonical reschedule action
 *
 * It cannot call a provider, cannot take an arbitrary URL, and refuses any
 * destination outside the approved internal-canary registry. One narrow allow
 * rule for this command is therefore strictly smaller than one for `curl`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No TextGrid calls. No raw SQL for dispatch
 * state — the only writes are through the two governed endpoints above, plus
 * the sanctioned authorization/proof-session mint that the existing
 * internal-proof runbook already performs the same way.
 *
 * Usage (all ids explicit, nothing inferred):
 *   node scripts/ops/canary-cert.mjs state    --row <id>
 *   node scripts/ops/canary-cert.mjs mint     --campaign <id> --row <id> --to <e164> --from <e164> [--minutes 60]
 *   node scripts/ops/canary-cert.mjs due      --row <id> [--at <iso>]
 *   node scripts/ops/canary-cert.mjs probe    --campaign <id> --row <id> --run <id> --token <tok>
 *   node scripts/ops/canary-cert.mjs send     --campaign <id> --row <id> --run <id> --token <tok>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const HOST = "http://localhost:3000";

/** The ONLY paths this script may POST to. Anything else is refused. */
const GOVERNED_PATHS = Object.freeze([
  "/api/internal/queue/run",
  "/api/cockpit/queue/reschedule",
]);

// ── env ─────────────────────────────────────────────────────────────────────

function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
loadEnv();

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const supabase = () =>
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } },
  );

/**
 * The approved registry, read from the repository rather than passed in — a
 * destination this script has never heard of cannot be certified through it.
 */
function approvedRegistry() {
  const source = fs.readFileSync(path.join(ROOT, "src/lib/config/internal-phones.js"), "utf8");
  return new Set([...source.matchAll(/"(\+\d{10,15})"/g)].map((m) => m[1]));
}

function assertApproved(phone) {
  if (!approvedRegistry().has(String(phone || "").trim())) {
    throw new Error(`destination_not_in_approved_canary_registry: ${phone}`);
  }
}

async function post(pathname, headers, body) {
  if (!GOVERNED_PATHS.includes(pathname)) {
    throw new Error(`refused_ungoverned_path: ${pathname}`);
  }
  const response = await fetch(`${HOST}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 400) } }
  return { status: response.status, body: parsed };
}

const opsSecret = () => process.env.OPS_DASHBOARD_SECRET || "";
const canarySecret = () =>
  process.env.SCOPED_CANARY_EXECUTION_SECRET || process.env.QUEUE_ENGINE_SHARED_SECRET || "";

// ── commands ────────────────────────────────────────────────────────────────

async function cmdState() {
  const row_id = arg("row");
  const db = supabase();
  const { data: row } = await db
    .from("send_queue")
    .select("id,campaign_id,campaign_target_id,queue_status,scheduled_for,scheduled_for_utc,to_phone_number,from_phone_number,template_id,provider_message_id,sent_at,metadata")
    .eq("id", row_id)
    .maybeSingle();
  if (!row) return console.log(JSON.stringify({ ok: false, reason: "row_not_found" }));

  const { data: auths } = await db
    .from("queue_canary_authorizations")
    .select("id,canary_run_id,consumed_at,expires_at")
    .eq("campaign_id", row.campaign_id)
    .order("created_at", { ascending: false })
    .limit(3);
  const { data: session } = await db
    .from("system_control").select("value").eq("key", "internal_proof_session").maybeSingle();
  const { data: campaign } = await db
    .from("campaigns").select("status").eq("id", row.campaign_id).maybeSingle();

  const now = Date.now();
  console.log(JSON.stringify({
    ok: true,
    now: new Date().toISOString(),
    campaign_status: campaign?.status ?? null,
    queue_status: row.queue_status,
    scheduled_for: row.scheduled_for,
    scheduled_for_utc: row.scheduled_for_utc,
    dispatch_due: new Date(row.scheduled_for_utc || row.scheduled_for).getTime() <= now,
    to: row.to_phone_number,
    from: row.from_phone_number,
    template_id: row.template_id,
    provider_message_id: row.provider_message_id,
    sent_at: row.sent_at,
    internal_canary: row.metadata?.internal_canary ?? null,
    origin_surface: row.metadata?.origin_surface ?? null,
    exclude_from_kpis: row.metadata?.exclude_from_kpis ?? null,
    authorizations: (auths || []).map((a) => ({
      id: a.id, run: a.canary_run_id, consumed_at: a.consumed_at,
      valid: !a.consumed_at && new Date(a.expires_at).getTime() > now,
    })),
    proof_session: session?.value ? JSON.parse(session.value) : null,
  }, null, 2));
}

async function cmdMint() {
  const campaign_id = arg("campaign");
  const row_id = arg("row");
  const to = arg("to");
  const from = arg("from");
  const minutes = Number(arg("minutes", "60"));
  assertApproved(to);

  const db = supabase();
  const run_id = `cert_${crypto.randomBytes(8).toString("hex")}`;
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const now = new Date();

  const { data: auth, error } = await db.from("queue_canary_authorizations").insert({
    canary_run_id: run_id,
    campaign_id,
    queue_row_ids: [row_id],
    authorization_token_hash: hash,
    expires_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
    metadata: { internal_proof: true, target_row: row_id, purpose: "campaign_certification" },
  }).select("id,expires_at").single();
  if (error) throw error;

  // Session lifetime is clamped by the engine's own bound; keep it under it.
  const session = {
    session_id: `cert_${crypto.randomBytes(6).toString("hex")}`,
    campaign_id, queue_row_id: row_id, recipient: to, sender: from,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + Math.min(minutes, 29) * 60_000).toISOString(),
    allow_thread_auto_replies: false,
  };
  const { error: sErr } = await db.from("system_control")
    .upsert({ key: "internal_proof_session", value: JSON.stringify(session), updated_at: now.toISOString() }, { onConflict: "key" });
  if (sErr) throw sErr;

  console.log(JSON.stringify({
    ok: true, auth_id: auth.id, run_id, token,
    auth_expires: auth.expires_at,
    session_id: session.session_id, session_expires: session.expires_at,
  }, null, 2));
}

async function cmdDue() {
  const row_id = arg("row");
  const at = arg("at") || new Date(Date.now() - 60_000).toISOString();
  const result = await post("/api/cockpit/queue/reschedule",
    { "x-ops-dashboard-secret": opsSecret() },
    { queue_item_id: row_id, scheduled_for: at, dry_run: false, reason: "canary cert: governed reschedule" });
  console.log(JSON.stringify({ ok: result.body?.ok === true, at, ...result }, null, 2));
}

async function runner({ validate_only }) {
  const campaign_id = arg("campaign");
  const row_id = arg("row");
  const run_id = arg("run");
  const token = arg("token");
  const result = await post("/api/internal/queue/run",
    { "x-scoped-canary-secret": canarySecret(), "x-canary-authorization-token": token },
    { scoped_canary: true, campaign_id, canary_run_id: run_id, queue_row_ids: [row_id], max_rows: 1, validate_only });
  console.log(JSON.stringify(result, null, 2));
}

const COMMANDS = {
  state: cmdState,
  mint: cmdMint,
  due: cmdDue,
  probe: () => runner({ validate_only: true }),
  send: () => runner({ validate_only: false }),
};

const command = process.argv[2];
if (!COMMANDS[command]) {
  console.error(`unknown command: ${command}. one of: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(2);
}
COMMANDS[command]().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  process.exit(1);
});
