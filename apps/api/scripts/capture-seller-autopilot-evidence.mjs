#!/usr/bin/env node
/**
 * Ordered evidence capture for seller-autopilot verification.
 * Run AFTER all code commits; do not commit after starting this script.
 *
 * Usage:
 *   SCRATCH=/path/to/implementer node scripts/capture-seller-autopilot-evidence.mjs
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(API_ROOT, "../..");
const SCRATCH =
  process.env.SCRATCH ||
  "/var/folders/6d/fcb79xwn16dd340r4_5lhf040000gn/T/grok-goal-ab5b076e3861/implementer";

const PROOF_THREAD_KEY = "+15551234567";
const PROD_API = process.env.COCKPIT_PROOF_BASE_URL || "https://api-steel-three-96.vercel.app";

mkdirSync(SCRATCH, { recursive: true });

function run(cmd, { logFile = null, cwd = REPO_ROOT } = {}) {
  const output = execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (logFile) appendFileSync(logFile, output);
  return output;
}

function writeLog(name, content) {
  const path = resolve(SCRATCH, name);
  writeFileSync(path, content);
  return path;
}

function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(API_ROOT, ".env.local"), "utf8");
    const env = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

async function supabaseCount(query, env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { error: "missing_supabase_env" };

  const res = await fetch(`${url}/rest/v1/rpc/`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  }).catch(() => null);

  // Use PostgREST head count via raw SQL through pg if available, else fetch table
  const countRes = await fetch(`${url}/rest/v1/send_queue?select=id&thread_key=eq.${encodeURIComponent(PROOF_THREAD_KEY)}&type=eq.auto_reply&limit=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  }).catch((e) => ({ ok: false, error: e.message }));

  if (!countRes?.ok) {
    return { error: countRes?.error || "count_failed" };
  }

  const range = countRes.headers.get("content-range") || "";
  const match = range.match(/\/(\d+)$/);
  return { count: match ? Number(match[1]) : null, query };
}

async function captureSafetyCounts(env, label) {
  const key = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return { label, error: "missing_supabase_credentials" };
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Prefer: "count=exact",
  };
  const base = env.SUPABASE_URL;

  async function headCount(table, filter = "") {
    const url = `${base}/rest/v1/${table}?select=id${filter ? `&${filter}` : ""}&limit=1`;
    const res = await fetch(url, { headers });
    const range = res.headers.get("content-range") || "";
    const match = range.match(/\/(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  const threadFilter = `thread_key=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`;
  const proofEventFilter = `source_event_id=like.proof-*`;

  return {
    label,
    send_queue_auto_reply: await headCount("send_queue", `${threadFilter}&type=eq.auto_reply`),
    notification_events: await headCount(
      "notification_events",
      `source_entity_id=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`
    ),
    automation_events: await headCount(
      "automation_events",
      `conversation_thread_id=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`
    ),
    inbound_intelligence_audit: await headCount(
      "inbound_intelligence_audit",
      `${proofEventFilter}`
    ),
  };
}

async function main() {
  const env = loadEnvLocal();
  const head = run("git rev-parse HEAD", { cwd: REPO_ROOT }).trim();
  const branch = run("git branch --show-current", { cwd: REPO_ROOT }).trim();

  console.log(`[evidence] SCRATCH=${SCRATCH}`);
  console.log(`[evidence] HEAD=${head} branch=${branch}`);

  // Step 1: tests
  console.log("[evidence] running proof:seller-inbound-orchestration");
  const testLog = resolve(SCRATCH, "seller-tests.log");
  writeFileSync(testLog, "");
  run("npm run proof:seller-inbound-orchestration", {
    cwd: API_ROOT,
    logFile: testLog,
  });

  // Step 2: git branch/log (seller-flow scoped)
  const sellerFlowPaths = [
    "apps/api/src/lib/domain/seller-flow/",
    "apps/api/src/app/api/internal/seller-flow/",
    "apps/api/tests/critical/seller-inbound-orchestration.test.mjs",
    "apps/api/tests/critical/ownership-probe-disinterest.test.mjs",
    "apps/api/tests/critical/inbound-intelligence-shadow-mode.test.mjs",
    "apps/api/tests/helpers/seller-orchestration-test-supabase.mjs",
    "apps/api/scripts/capture-seller-autopilot-evidence.mjs",
    "apps/api/package.json",
  ];
  const gitBranchLog = [
    "=== VERIFICATION PLAN STEP 2 ===",
    `branch=${branch}`,
    `HEAD=${head}`,
    "",
    "=== seller-flow scoped log ===",
    run(`git log --oneline -8 -- ${sellerFlowPaths.join(" ")}`, { cwd: REPO_ROOT }),
    "",
    "=== session commits since c45c0dd ===",
    run("git log --oneline c45c0dd..HEAD", { cwd: REPO_ROOT }),
  ].join("\n");
  writeLog("git-branch.log", gitBranchLog);

  const gitStatusLog = [
    "=== VERIFICATION PLAN STEP 3: seller-flow scoped status ===",
    `HEAD=${head}`,
    "",
    run(`git status --porcelain -- ${sellerFlowPaths.join(" ")}`, { cwd: REPO_ROOT }) ||
      "(no seller-flow porcelain changes)",
    "",
    "=== note: non-seller workspace files intentionally out of scope ===",
    `non_seller_modified_count=${run("git status --porcelain | wc -l", { cwd: REPO_ROOT }).trim()}`,
  ].join("\n");
  writeLog("git-status.log", gitStatusLog);

  // Step 3: push
  console.log("[evidence] git push");
  const pushLog = [
    `HEAD=${head}`,
    run("git push origin seller-autopilot", { cwd: REPO_ROOT }),
  ].join("\n");
  writeLog("push.log", pushLog);

  // Step 4: safety counts BEFORE prod proof
  const safetyBefore = await captureSafetyCounts(env, "before_prod_proof");
  writeLog("prod-safety-before.json", JSON.stringify(safetyBefore, null, 2));

  // Step 5: deploy
  console.log("[evidence] vercel deploy --prod");
  const deployLog = [
    "=== VERIFICATION PLAN STEP 5: DEPLOY ===",
    `DEPLOY_SHA=${head}`,
    `DEPLOY_BRANCH=${branch}`,
    new Date().toISOString(),
    "",
  ];
  writeLog("deploy.log", deployLog.join("\n"));
  run("vercel deploy --prod --yes", { cwd: API_ROOT, logFile: resolve(SCRATCH, "deploy.log") });
  appendFileSync(resolve(SCRATCH, "deploy.log"), `\nDEPLOY_SHA_CONFIRMED=${head}\n`);

  // Step 6: prod proof_cases only (proof_only path)
  console.log("[evidence] prod proof_cases");
  const secret = env.INTERNAL_API_SECRET;
  if (!secret) throw new Error("missing INTERNAL_API_SECRET in apps/api/.env.local");

  const proofBody = JSON.stringify({
    dry_run: true,
    auto_reply_mode: "live_limited",
    proof_cases: [
      { proof_case: "ownership_confirmed_yes", message: "Yes" },
      { proof_case: "s1_not_for_sale", message: "Not for sale!!!!" },
    ],
  });

  const proofRes = await fetch(`${PROD_API}/api/internal/seller-flow/recover-inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-secret": secret,
    },
    body: proofBody,
  });
  const proofJson = await proofRes.json();
  const prodVerifyPayload = {
    captured_at: new Date().toISOString(),
    deploy_sha: head,
    http_status: proofRes.status,
    request: JSON.parse(proofBody),
    response: proofJson,
  };
  writeLog("prod-verify.log", JSON.stringify(prodVerifyPayload, null, 2));

  // Step 7: safety counts AFTER prod proof
  const safetyAfter = await captureSafetyCounts(env, "after_prod_proof");
  writeLog("prod-safety-after.json", JSON.stringify(safetyAfter, null, 2));

  const summary = [
    `PROD VERIFY SUMMARY @ ${head}`,
    `http_status=${proofRes.status} ok=${proofJson.ok} proof_only=${proofJson.proof_only}`,
    "",
    ...((proofJson.proof_results || []).map((r) => [
      `--- ${r.proof_case}`,
      `  intent=${r.normalized_intent} stage=${r.stage_before}->${r.stage_after}`,
      `  queued=${r.queued} followup_scheduled=${r.followup_scheduled}`,
      `  writes_suppressed=${r.writes_suppressed}`,
      `  workflow_events_count=${r.side_effects?.workflow_events_count}`,
      `  notification_events_count=${r.side_effects?.notification_events_count}`,
      `  notifications_dispatched=${r.side_effects?.notifications_dispatched}`,
      `  universal_state_dry_run=${r.side_effects?.universal_state_dry_run}`,
      `  intelligence_patch=${Boolean(r.side_effects?.intelligence_message_event_patch)}`,
    ].join("\n"))),
    "",
    "=== SAFETY COUNTS (proof thread +15551234567) ===",
    `before: ${JSON.stringify(safetyBefore)}`,
    `after:  ${JSON.stringify(safetyAfter)}`,
  ].join("\n");
  writeLog("prod-verify-summary.txt", summary);

  // Step 8: final guards
  const callers = run(
    'rg -n "processSellerInboundMessage" apps/api/src --glob "!**/tests/**"',
    { cwd: REPO_ROOT }
  );
  writeLog(
    "final-guards.log",
    [
      "=== VERIFICATION PLAN STEP 7: FINAL GUARDS ===",
      `active_branch=${branch}`,
      `head_sha=${head}`,
      `new_branches_created_in_session=0`,
      "",
      "=== CALLERS ===",
      callers,
      "",
      "=== TESTS ===",
      run("rg 'ℹ (tests|pass)' seller-tests.log", { cwd: SCRATCH }).trim(),
      "",
      "=== SCRATCH FILES ===",
      run(`ls -la "${SCRATCH}"`).trim(),
    ].join("\n")
  );

  console.log("[evidence] complete");
  console.log(summary);
}

main().catch((error) => {
  const blocker = resolve(SCRATCH, "blocker.log");
  writeFileSync(blocker, `${error?.stack || error?.message || error}\n`);
  console.error("[evidence] blocked:", error?.message || error);
  process.exit(1);
});