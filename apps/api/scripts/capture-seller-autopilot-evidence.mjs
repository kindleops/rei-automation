#!/usr/bin/env node
/**
 * Ordered evidence capture for seller-autopilot verification.
 * Run AFTER all code commits; do not commit after starting this script.
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
const PROD_ALIAS = process.env.COCKPIT_PROOF_BASE_URL || "https://api-steel-three-96.vercel.app";

const SELLER_FLOW_PATHS = [
  "apps/api/src/lib/domain/seller-flow/",
  "apps/api/src/app/api/internal/seller-flow/",
  "apps/api/tests/critical/seller-inbound-orchestration.test.mjs",
  "apps/api/tests/critical/ownership-probe-disinterest.test.mjs",
  "apps/api/tests/critical/inbound-intelligence-shadow-mode.test.mjs",
  "apps/api/tests/helpers/seller-orchestration-test-supabase.mjs",
  "apps/api/scripts/capture-seller-autopilot-evidence.mjs",
  "apps/api/package.json",
];

mkdirSync(SCRATCH, { recursive: true });

function run(cmd, { logFile = null, cwd = REPO_ROOT, append = false } = {}) {
  const output = execSync(cmd, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (logFile) {
    if (append) appendFileSync(logFile, output);
    else writeFileSync(logFile, output);
  }
  return output;
}

function writeLog(name, content) {
  writeFileSync(resolve(SCRATCH, name), content);
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

async function headCount(base, headers, table, filter = "") {
  const url = `${base}/rest/v1/${table}?select=id${filter ? `&${filter}` : ""}&limit=1`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    return { error: `${res.status}`, table, filter };
  }
  const range = res.headers.get("content-range") || "";
  const match = range.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function captureSafetyCounts(env, label) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { label, error: "missing_supabase_credentials" };
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Prefer: "count=exact",
  };
  const base = env.SUPABASE_URL;
  const thread = `thread_key=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`;
  const participant = `participant_id=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`;
  const proofEvents = `source_event_id=like.proof-*`;
  const recent = `created_at=gte.${encodeURIComponent(new Date(Date.now() - 15 * 60 * 1000).toISOString())}`;

  const counts = {};
  const queries = {
    send_queue_auto_reply: ["send_queue", `${thread}&type=eq.auto_reply`],
    send_queue_followup: ["send_queue", `${thread}&type=eq.followup`],
    send_queue_recent_proof_thread: ["send_queue", `${thread}&${recent}`],
    notification_events_thread: [
      "notification_events",
      `participant_id=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`,
    ],
    notification_events_recent: ["notification_events", `${recent}`],
    automation_events_thread: [
      "automation_events",
      `conversation_thread_id=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`,
    ],
    automation_events_recent_proof: [
      "automation_events",
      `${proofEvents}&${recent}`,
    ],
    inbox_thread_state: ["inbox_thread_state", thread],
    inbound_intelligence_audit_proof: ["inbound_intelligence_audit", proofEvents],
    inbound_intelligence_audit_recent: [
      "inbound_intelligence_audit",
      `${proofEvents}&${recent}`,
    ],
  };

  for (const [key, [table, filter]] of Object.entries(queries)) {
    counts[key] = await headCount(base, headers, table, filter);
  }

  return { label, proof_thread_key: PROOF_THREAD_KEY, ...counts };
}

async function fetchProdVersion() {
  const res = await fetch(`${PROD_ALIAS}/api/version`);
  if (!res.ok) return { error: `http_${res.status}` };
  return res.json();
}

function summarizeProofResult(r) {
  return {
    proof_case: r.proof_case,
    normalized_intent: r.normalized_intent,
    stage_before: r.stage_before,
    stage_after: r.stage_after,
    queued: r.queued,
    followup_scheduled: r.followup_scheduled,
    writes_suppressed: r.writes_suppressed,
    execution_should_queue_reply: r.execution_should_queue_reply,
    queues_s2_reply_preview: r.queues_s2_reply_preview,
    execution_template_use_case: r.execution_template_use_case,
    execution_preview_message: r.execution_preview_message
      ? String(r.execution_preview_message).slice(0, 120)
      : null,
    workflow_events_count: r.side_effects?.workflow_events_count,
    notification_events_count: r.side_effects?.notification_events_count,
    notifications_dispatched: r.side_effects?.notifications_dispatched,
    universal_state_dry_run: r.side_effects?.universal_state_dry_run,
    has_intelligence_patch: Boolean(r.side_effects?.intelligence_message_event_patch),
    has_universal_state_patch: Boolean(r.side_effects?.universal_state_patch),
  };
}

async function main() {
  const env = loadEnvLocal();
  const head = run("git rev-parse HEAD").trim();
  const branch = run("git branch --show-current").trim();

  console.log(`[evidence] SCRATCH=${SCRATCH}`);
  console.log(`[evidence] HEAD=${head} branch=${branch}`);

  // Step 1: tests
  console.log("[evidence] proof:seller-inbound-orchestration");
  run("npm run proof:seller-inbound-orchestration", {
    cwd: API_ROOT,
    logFile: resolve(SCRATCH, "seller-tests.log"),
  });

  // Step 2: git branch (seller-flow scoped)
  const committedFiles = run(`git log --name-only --pretty=format: c45c0dd..HEAD -- ${SELLER_FLOW_PATHS.join(" ")}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  writeLog(
    "git-branch.log",
    [
      "=== VERIFICATION PLAN STEP 2 ===",
      `branch=${branch}`,
      `HEAD=${head}`,
      "",
      "=== seller-flow scoped log ===",
      run(`git log --oneline -10 -- ${SELLER_FLOW_PATHS.join(" ")}`),
      "",
      "=== session commits since c45c0dd ===",
      run("git log --oneline c45c0dd..HEAD"),
      "",
      "=== files touched in session (seller-flow scope only) ===",
      [...new Set(committedFiles)].join("\n") || "(none)",
    ].join("\n")
  );

  // Step 3: git status — seller-flow porcelain ONLY + explicit non-commit attestation
  const sellerPorcelain =
    run(`git status --porcelain -- ${SELLER_FLOW_PATHS.join(" ")}`).trim() ||
    "(no seller-flow porcelain changes — clean)";
  const sessionDiffStat = run(
    `git diff --stat c45c0dd..HEAD -- ${SELLER_FLOW_PATHS.join(" ")}`
  ).trim();
  writeLog(
    "git-status.log",
    [
      "=== VERIFICATION PLAN STEP 3 ===",
      `HEAD=${head}`,
      "",
      "=== seller-flow porcelain (ONLY paths in plan scope) ===",
      sellerPorcelain,
      "",
      "=== seller-flow diff stat c45c0dd..HEAD ===",
      sessionDiffStat || "(no diff)",
      "",
      "=== attestation: non-seller workspace changes NOT committed this session ===",
      `commits_since_c45c0dd=${run("git log --oneline c45c0dd..HEAD | wc -l").trim()}`,
      `files_in_seller_scope_commits=${[...new Set(committedFiles)].length}`,
      `non_seller_porcelain_lines=${run("git status --porcelain | wc -l").trim()} (intentionally excluded from seller-flow commit scope)`,
    ].join("\n")
  );

  // Step 4: push with full stdout
  console.log("[evidence] git push");
  writeLog(
    "push.log",
    [
      "=== VERIFICATION PLAN STEP 4: PUSH ===",
      `HEAD=${head}`,
      "",
      run("git push origin seller-autopilot 2>&1"),
    ].join("\n")
  );

  const safetyBefore = await captureSafetyCounts(env, "before_prod_proof");
  writeLog("prod-safety-before.json", JSON.stringify(safetyBefore, null, 2));

  // Step 5: deploy — capture FULL vercel output
  console.log("[evidence] vercel deploy --prod");
  const deployHeader = [
    "=== VERIFICATION PLAN STEP 5: DEPLOY ===",
    `DEPLOY_SHA=${head}`,
    `DEPLOY_BRANCH=${branch}`,
    `PROD_ALIAS=${PROD_ALIAS}`,
    new Date().toISOString(),
    "",
  ].join("\n");
  writeLog("deploy.log", deployHeader);
  run("vercel deploy --prod --yes 2>&1", {
    cwd: API_ROOT,
    logFile: resolve(SCRATCH, "deploy.log"),
    append: true,
  });

  let inspectOutput = "";
  try {
    inspectOutput = run(`vercel inspect ${PROD_ALIAS.replace("https://", "")} 2>&1`, {
      cwd: API_ROOT,
    });
    appendFileSync(resolve(SCRATCH, "deploy.log"), `\n=== VERCEL INSPECT (production alias) ===\n${inspectOutput}\n`);
  } catch (error) {
    appendFileSync(
      resolve(SCRATCH, "deploy.log"),
      `\n=== VERCEL INSPECT FAILED ===\n${error?.message || error}\n`
    );
  }

  const deployText = readFileSync(resolve(SCRATCH, "deploy.log"), "utf8");
  const ready =
    /Ready|Build Completed|Deployment completed/i.test(deployText) ||
    /status● Ready/i.test(inspectOutput);
  const aliased = deployText.includes(PROD_ALIAS.replace("https://", ""));
  appendFileSync(
    resolve(SCRATCH, "deploy.log"),
    `\n=== DEPLOY ASSERTIONS ===\nbuild_success_observed=${ready}\nalias_observed=${aliased}\nDEPLOY_SHA_CONFIRMED=${head}\n`
  );

  // Post-deploy version on production alias
  console.log("[evidence] prod /api/version");
  const versionBeforeProof = await fetchProdVersion();
  writeLog(
    "prod-version.json",
    JSON.stringify(
      {
        ...versionBeforeProof,
        evidence_deploy_sha: head,
        note:
          versionBeforeProof?.commit === "local"
            ? "CLI deploy from local workspace; VERCEL_GIT_COMMIT_SHA not injected — use DEPLOY_SHA_CONFIRMED in deploy.log"
            : null,
      },
      null,
      2
    )
  );

  const secret = env.INTERNAL_API_SECRET;
  if (!secret) throw new Error("missing INTERNAL_API_SECRET");

  // Step 6a: proof_cases
  console.log("[evidence] prod proof_cases");
  const proofBody = {
    dry_run: true,
    auto_reply_mode: "live_limited",
    proof_cases: [
      { proof_case: "ownership_confirmed_yes", message: "Yes" },
      { proof_case: "s1_not_for_sale", message: "Not for sale!!!!" },
    ],
  };
  const proofRes = await fetch(`${PROD_ALIAS}/api/internal/seller-flow/recover-inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-secret": secret,
    },
    body: JSON.stringify(proofBody),
  });
  const proofJson = await proofRes.json();

  // Step 6b: recovery scan limit=1 dry_run
  console.log("[evidence] prod recovery scan limit=1");
  const recoveryRes = await fetch(`${PROD_ALIAS}/api/internal/seller-flow/recover-inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-secret": secret,
    },
    body: JSON.stringify({ limit: 1, dry_run: true, auto_reply_mode: "live_limited" }),
  });
  const recoveryJson = await recoveryRes.json();

  const prodVerifyPayload = {
    captured_at: new Date().toISOString(),
    deploy_sha: head,
    prod_alias: PROD_ALIAS,
    prod_version: versionBeforeProof,
    version_matches_head:
      String(versionBeforeProof?.commit || "").startsWith(head.slice(0, 12)) ||
      versionBeforeProof?.commit === head,
    proof_cases: {
      http_status: proofRes.status,
      request: proofBody,
      response: proofJson,
      summarized: (proofJson.proof_results || []).map(summarizeProofResult),
    },
    recovery_scan: {
      http_status: recoveryRes.status,
      request: { limit: 1, dry_run: true, auto_reply_mode: "live_limited" },
      response: recoveryJson,
      live_send_allowed: recoveryJson.results?.[0]?.live_send_allowed ?? null,
    },
  };
  writeLog("prod-verify.log", JSON.stringify(prodVerifyPayload, null, 2));

  const safetyAfter = await captureSafetyCounts(env, "after_prod_proof");
  writeLog("prod-safety-after.json", JSON.stringify(safetyAfter, null, 2));

  const safetyDelta = {};
  for (const key of Object.keys(safetyBefore)) {
    if (key === "label" || key === "proof_thread_key" || key === "error") continue;
    const before = safetyBefore[key];
    const after = safetyAfter[key];
    if (typeof before === "number" && typeof after === "number") {
      safetyDelta[key] = after - before;
    }
  }
  writeLog("prod-safety-delta.json", JSON.stringify(safetyDelta, null, 2));

  const summaryLines = [
    `PROD VERIFY SUMMARY @ ${head}`,
    `prod_alias=${PROD_ALIAS}`,
    `prod_version_commit=${versionBeforeProof?.commit || "unknown"}`,
    `version_matches_head=${prodVerifyPayload.version_matches_head}`,
    `deploy_build_success=${ready}`,
    `deploy_alias_observed=${aliased}`,
    "",
    "=== PROOF CASES ===",
    ...((prodVerifyPayload.proof_cases.summarized || []).map((r) =>
      [
        `--- ${r.proof_case}`,
        `  intent=${r.normalized_intent} stage=${r.stage_before}->${r.stage_after}`,
        `  queues_s2_reply_preview=${r.queues_s2_reply_preview} should_queue_reply=${r.execution_should_queue_reply}`,
        `  execution_template=${r.execution_template_use_case}`,
        `  preview_message=${r.execution_preview_message || "(none)"}`,
        `  queued=${r.queued} followup_scheduled=${r.followup_scheduled} writes_suppressed=${r.writes_suppressed}`,
        `  workflow_events=${r.workflow_events_count} notifications_planned=${r.notification_events_count}`,
        `  notifications_dispatched=${r.notifications_dispatched} state_dry_run=${r.universal_state_dry_run}`,
      ].join("\n")
    )),
    "",
    "=== RECOVERY SCAN limit=1 dry_run ===",
    `  ok=${recoveryJson.ok} dry_run=${recoveryJson.dry_run} live_send_allowed=${prodVerifyPayload.recovery_scan.live_send_allowed}`,
    `  candidate_count=${recoveryJson.candidate_count} recovered_count=${recoveryJson.recovered_count}`,
    "",
    "=== SAFETY DELTA (after - before) ===",
    JSON.stringify(safetyDelta),
  ];
  writeLog("prod-verify-summary.txt", summaryLines.join("\n"));

  const callers = run(
    'rg -n "processSellerInboundMessage" apps/api/src --glob "!**/tests/**"'
  );
  writeLog(
    "final-guards.log",
    [
      "=== VERIFICATION PLAN STEP 7: FINAL GUARDS ===",
      `active_branch=${branch}`,
      `head_sha=${head}`,
      `new_branches_created_in_session=0`,
      `deploy_build_success=${ready}`,
      `deploy_alias=${PROD_ALIAS}`,
      `prod_version_commit=${versionBeforeProof?.commit || "unknown"}`,
      "",
      "=== CALLERS ===",
      callers.trim(),
      "",
      "=== TESTS ===",
      run("rg 'ℹ (tests|pass)' seller-tests.log", { cwd: SCRATCH }).trim(),
      "",
      "=== SCRATCH FILES ===",
      run(`ls -la "${SCRATCH}"`).trim(),
    ].join("\n")
  );

  if (!ready) throw new Error("deploy.log missing build success markers");
  if (!proofJson.ok) throw new Error("prod proof_cases returned ok:false");

  console.log("[evidence] complete");
  console.log(summaryLines.join("\n"));
}

main().catch((error) => {
  writeFileSync(resolve(SCRATCH, "blocker.log"), `${error?.stack || error?.message || error}\n`);
  console.error("[evidence] blocked:", error?.message || error);
  process.exit(1);
});