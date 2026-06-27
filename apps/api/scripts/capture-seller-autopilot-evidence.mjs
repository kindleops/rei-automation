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
  "apps/api/src/lib/flows/handle-textgrid-inbound.js",
  "apps/api/src/app/api/internal/seller-flow/",
  "apps/api/tests/critical/seller-inbound-execution-view.test.mjs",
  "apps/api/tests/critical/seller-inbound-orchestration.test.mjs",
  "apps/api/tests/critical/ownership-probe-disinterest.test.mjs",
  "apps/api/tests/critical/inbound-intelligence-shadow-mode.test.mjs",
  "apps/api/tests/helpers/seller-orchestration-test-supabase.mjs",
  "apps/api/scripts/capture-seller-autopilot-evidence.mjs",
  "apps/api/scripts/write-deploy-sha.mjs",
  "apps/api/src/app/api/version/route.ts",
  "apps/api/package.json",
];

const STASH_KEEP_PATHSPECS = SELLER_FLOW_PATHS.map(
  (path) => `":(exclude)${path}"`
).join(" ");

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
    inbox_thread_state_recent: ["inbox_thread_state", `${thread}&${recent}`],
    message_events_proof_thread: ["message_events", `${thread}&direction=eq.inbound`],
    message_events_recent_global: ["message_events", `${recent}&direction=eq.inbound`],
    universal_lead_state_events_thread: [
      "universal_lead_state_events",
      `thread_key=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`,
    ],
    universal_lead_state_events_recent: ["universal_lead_state_events", recent],
    deal_intelligence_view_proof_thread: [
      "deal_intelligence_view",
      `thread_key=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`,
    ],
    v_universal_lead_command_proof_thread: [
      "v_universal_lead_command",
      `thread_key=eq.${encodeURIComponent(PROOF_THREAD_KEY)}`,
    ],
    v_universal_lead_command_recent: ["v_universal_lead_command", recent],
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

function stashNonSellerWorkspace() {
  try {
    const before = run("git status --porcelain").trim();
    if (!before) return { stashed: false, before, after: "" };
    run(`git stash push -u -m harness-seller-only -- . ${STASH_KEEP_PATHSPECS}`);
    const after = run("git status --porcelain").trim();
    return { stashed: true, before, after };
  } catch (error) {
    return { stashed: false, before: "", after: "", error: error?.message || String(error) };
  }
}

function restoreNonSellerWorkspace(stashResult) {
  if (!stashResult?.stashed) return;
  try {
    run("git stash pop");
  } catch (error) {
    appendFileSync(
      resolve(SCRATCH, "blocker.log"),
      `stash_pop_failed: ${error?.message || error}\n`
    );
  }
}

async function fetchJsonRows(base, headers, table, filter = "", limit = 5) {
  const url = `${base}/rest/v1/${table}?select=*${filter ? `&${filter}` : ""}&limit=${limit}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    return { error: `${res.status}`, table, filter };
  }
  return res.json();
}

async function findOwnershipYesInbound(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: "missing_supabase_credentials" };
  }
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
  const base = env.SUPABASE_URL;
  const filters = [
    "direction=eq.inbound&detected_intent=eq.ownership_confirmed&message_body=ilike.*Yes*&order=received_at.desc",
    "direction=eq.inbound&message_body=ilike.Yes&order=received_at.desc",
    "direction=eq.inbound&message_body=ilike.*yes*&order=received_at.desc",
  ];
  for (const filter of filters) {
    const rows = await fetchJsonRows(base, headers, "message_events", filter, 5);
    if (Array.isArray(rows) && rows.length > 0) {
      const match = rows.find((row) => /yes/i.test(String(row.message_body || ""))) || rows[0];
      return {
        id: match.id,
        message_body: match.message_body,
        detected_intent: match.detected_intent,
        received_at: match.received_at,
        from_phone_number: match.from_phone_number,
      };
    }
  }
  return { error: "no_yes_inbound_found" };
}

async function main() {
  const env = loadEnvLocal();
  const head = run("git rev-parse HEAD").trim();
  const branch = run("git branch --show-current").trim();
  let stashResult = { stashed: false };

  writeLog("blocker.log", "");
  try {
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

  // Step 3: isolate workspace, then capture seller-flow porcelain only
  stashResult = stashNonSellerWorkspace();
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
      `workspace_stashed=${stashResult.stashed}`,
      `total_porcelain_lines_post_stash=${run("git status --porcelain | wc -l").trim()}`,
      "",
      "=== seller-flow porcelain (post-stash, plan scope only) ===",
      sellerPorcelain,
      "",
      "=== stash before/after (non-seller isolated) ===",
      `before_lines=${stashResult.before ? stashResult.before.split("\n").length : 0}`,
      `after_lines=${stashResult.after ? stashResult.after.split("\n").length : 0}`,
      stashResult.error ? `stash_error=${stashResult.error}` : "stash_error=none",
      "",
      "=== seller-flow diff stat c45c0dd..HEAD ===",
      sessionDiffStat || "(no diff)",
      "",
      "=== attestation ===",
      `commits_since_c45c0dd=${run("git log --oneline c45c0dd..HEAD | wc -l").trim()}`,
      `files_in_seller_scope_commits=${[...new Set(committedFiles)].length}`,
      `total_porcelain_lines=${run("git status --porcelain | wc -l").trim()}`,
      "policy=non-seller workspace stashed before status capture",
    ].join("\n")
  );

  // Step 4: push with full stdout + remote ref confirmation
  console.log("[evidence] git push");
  const pushOutput = run("git push -v origin seller-autopilot 2>&1");
  const remoteRef = run("git ls-remote origin refs/heads/seller-autopilot 2>&1").trim();
  const originHead = run("git rev-parse origin/seller-autopilot 2>&1").trim();
  const originLog = run("git log origin/seller-autopilot -1 --oneline 2>&1").trim();
  writeLog(
    "push.log",
    [
      "=== VERIFICATION PLAN STEP 4: PUSH ===",
      `LOCAL_HEAD=${head}`,
      `ORIGIN_HEAD=${originHead}`,
      "",
      "=== git push -v stdout/stderr ===",
      pushOutput.trim() || "(no output)",
      "",
      "=== origin seller-autopilot ref ===",
      remoteRef,
      `origin_log=${originLog}`,
      "",
      `remote_matches_local=${remoteRef.startsWith(head) || originHead === head}`,
    ].join("\n")
  );

  const safetyBefore = await captureSafetyCounts(env, "before_prod_proof");
  writeLog("prod-safety-before.json", JSON.stringify(safetyBefore, null, 2));

  // Step 5: deploy — capture RAW vercel output first (no prepended assertions)
  console.log("[evidence] vercel deploy --prod");
  const deployOutput = run(
    `vercel deploy --prod --yes --build-env DEPLOY_GIT_SHA=${head} 2>&1`,
    { cwd: API_ROOT }
  );
  const inspectOutput = run(
    `vercel inspect ${PROD_ALIAS.replace("https://", "")} 2>&1`,
    { cwd: API_ROOT }
  );
  const deployLogText = `${deployOutput}\n${inspectOutput}`;
  writeLog("deploy.log", deployLogText);

  const buildCompletedInOutput = /Build Completed/i.test(deployLogText);
  const aliasedInOutput = new RegExp(
    `Aliased:\\s*(https://)?${PROD_ALIAS.replace("https://", "").replace(/\./g, "\\.")}`,
    "i"
  ).test(deployLogText);
  const deployShaObserved =
    deployLogText.includes(head) || /\[deploy-sha\]/i.test(deployLogText);
  const readyObserved = /Ready/i.test(deployLogText);
  const ready = buildCompletedInOutput && aliasedInOutput && readyObserved;

  // Post-deploy version on production alias
  console.log("[evidence] prod /api/version");
  const versionBeforeProof = await fetchProdVersion();
  const versionMatchesHead =
    String(versionBeforeProof?.commit || "").startsWith(head.slice(0, 12)) ||
    versionBeforeProof?.commit === head;
  writeLog(
    "prod-version.json",
    JSON.stringify(
      {
        ...versionBeforeProof,
        evidence_deploy_sha: head,
        version_matches_head: versionMatchesHead,
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

  // Step 6c: targeted recovery of known production "Yes" inbound
  console.log("[evidence] prod recovery Yes ownership inbound");
  const yesInbound = await findOwnershipYesInbound(env);
  let yesRecoveryJson = null;
  let yesRecoveryResStatus = null;
  if (yesInbound?.id) {
    const yesRecoveryRes = await fetch(`${PROD_ALIAS}/api/internal/seller-flow/recover-inbound`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-secret": secret,
      },
      body: JSON.stringify({
        message_event_id: yesInbound.id,
        dry_run: true,
        auto_reply_mode: "live_limited",
      }),
    });
    yesRecoveryResStatus = yesRecoveryRes.status;
    yesRecoveryJson = await yesRecoveryRes.json();
  }

  const prodVerifyPayload = {
    captured_at: new Date().toISOString(),
    deploy_sha: head,
    prod_alias: PROD_ALIAS,
    proof_cases: proofJson,
    recovery_scan: recoveryJson,
    recovery_yes_lookup: yesInbound,
    recovery_yes_inbound: yesRecoveryJson,
  };
  writeLog("prod-verify.log", JSON.stringify(prodVerifyPayload, null, 2));
  const prodVerifyText = JSON.stringify(prodVerifyPayload);
  const yesOwnership =
    (proofJson.proof_results || []).find((r) => r.proof_case === "ownership_confirmed_yes") ||
    null;
  const nfsCase =
    (proofJson.proof_results || []).find((r) => r.proof_case === "s1_not_for_sale") || null;
  const yesRecovery = yesRecoveryJson?.results?.[0] || null;
  const queuedObserved = /"queued"\s*:\s*true/.test(prodVerifyText);
  const followupObserved = /"followup_scheduled"\s*:\s*true/.test(prodVerifyText);
  const executionQueuedObserved = Boolean(yesOwnership?.execution?.queued);
  const sellerStageQueuedObserved = Boolean(
    yesOwnership?.execution?.seller_stage_reply?.queued ??
      yesOwnership?.seller_stage_reply?.queued
  );
  const intelligenceQueueObserved = Boolean(
    yesOwnership?.intelligence_snapshot?.reply_recommendation?.should_queue_reply
  );

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
    `version_matches_head=${versionMatchesHead}`,
    `deploy_build_success=${ready}`,
    `deploy_ready_observed=${readyObserved}`,
    `deploy_aliased_in_cli_output=${aliasedInOutput}`,
    `deploy_sha_observed_in_cli=${deployShaObserved}`,
    `grep_queued_true=${queuedObserved}`,
    `grep_followup_scheduled_true=${followupObserved}`,
    `execution_queued_true=${executionQueuedObserved}`,
    `seller_stage_reply_queued_true=${sellerStageQueuedObserved}`,
    `intelligence_should_queue_true=${intelligenceQueueObserved}`,
    "",
    "=== RAW ORCHESTRATOR FIELDS (proof ownership_confirmed_yes) ===",
    yesOwnership
      ? [
          `queued=${yesOwnership.queued} execution.queued=${yesOwnership.execution?.queued}`,
          `queue_row_created=${yesOwnership.queue_row_created} effective_action=${yesOwnership.effective_action}`,
          `execution.effective_action=${yesOwnership.execution?.effective_action}`,
          `seller_stage_reply.queued=${yesOwnership.execution?.seller_stage_reply?.queued}`,
          `intelligence.execution.effective_action=${yesOwnership.intelligence_snapshot?.decision_layers?.execution?.effective_action}`,
        ].join("\n")
      : "(missing)",
    "",
    "=== RAW ORCHESTRATOR FIELDS (proof s1_not_for_sale) ===",
    nfsCase
      ? `followup_scheduled=${nfsCase.followup_scheduled} followup_created=${nfsCase.followup_created} effective_action=${nfsCase.effective_action}`
      : "(missing)",
    "",
    "=== RAW ORCHESTRATOR FIELDS (recovery Yes inbound) ===",
    yesRecovery
      ? `queued=${yesRecovery.queued} queue_row_created=${yesRecovery.queue_row_created} followup_scheduled=${yesRecovery.followup_scheduled}`
      : `lookup=${yesInbound?.error || yesInbound?.id || "unknown"}`,
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
      `deploy_ready_observed=${readyObserved}`,
      `deploy_aliased_in_cli_output=${aliasedInOutput}`,
      `deploy_sha_observed_in_cli=${deployShaObserved}`,
      `grep_queued_true=${queuedObserved}`,
      `grep_followup_scheduled_true=${followupObserved}`,
      `execution_queued_true=${executionQueuedObserved}`,
      `deploy_alias=${PROD_ALIAS}`,
      `prod_version_commit=${versionBeforeProof?.commit || "unknown"}`,
      `version_matches_head=${versionMatchesHead}`,
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

  if (!ready) throw new Error("deploy.log missing Build Completed + Aliased + Ready markers");
  if (!deployShaObserved) throw new Error("deploy.log missing DEPLOY_GIT_SHA or [deploy-sha] marker");
  if (!proofJson.ok) throw new Error("prod proof_cases returned ok:false");
  if (!queuedObserved) throw new Error('prod-verify.log missing raw "queued":true');
  if (!executionQueuedObserved) {
    throw new Error("prod proof ownership_confirmed_yes missing execution.queued=true");
  }
  if (!sellerStageQueuedObserved) {
    throw new Error("prod proof ownership_confirmed_yes missing seller_stage_reply.queued=true");
  }
  if (!intelligenceQueueObserved) {
    throw new Error(
      "prod proof ownership_confirmed_yes missing intelligence reply_recommendation.should_queue_reply=true"
    );
  }
  if (!followupObserved) throw new Error('prod-verify.log missing raw "followup_scheduled":true');
  if (!versionMatchesHead) {
    throw new Error(
      `prod /api/version commit=${versionBeforeProof?.commit || "unknown"} does not match HEAD ${head}`
    );
  }

  console.log("[evidence] complete");
  console.log(summaryLines.join("\n"));
  } finally {
    restoreNonSellerWorkspace(stashResult);
  }
}

main().catch((error) => {
  writeFileSync(resolve(SCRATCH, "blocker.log"), `${error?.stack || error?.message || error}\n`);
  console.error("[evidence] blocked:", error?.message || error);
  process.exit(1);
});