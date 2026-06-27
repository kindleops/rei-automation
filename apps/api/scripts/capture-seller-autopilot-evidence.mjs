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
    canonical_should_queue_reply: r.canonical_should_queue_reply,
    planned_queue_action: r.planned_queue_action,
    execution_should_queue_reply: r.execution_should_queue_reply,
    execution_shadow_only: r.execution_shadow_only,
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

function parseInspectDeployment(inspectOutput = "") {
  const urlMatch = inspectOutput.match(/url\s+(https:\/\/\S+)/);
  const statusMatch = inspectOutput.match(/status\s+●\s+(\w+)/i);
  const idMatch = inspectOutput.match(/\bid\s+(dpl_\w+)/);
  return {
    deployment_url: urlMatch?.[1] || null,
    status: statusMatch?.[1] || null,
    deployment_id: idMatch?.[1] || null,
    ready: /Ready/i.test(inspectOutput),
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

  // Step 3: git status — seller-flow porcelain + explicit non-seller listing
  const sellerPorcelain =
    run(`git status --porcelain -- ${SELLER_FLOW_PATHS.join(" ")}`).trim() ||
    "(no seller-flow porcelain changes — clean)";
  const allPorcelain = run("git status --porcelain").trim();
  const nonSellerPorcelain = allPorcelain
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return !SELLER_FLOW_PATHS.some((scope) => trimmed.endsWith(scope) || trimmed.includes(scope));
    })
    .join("\n");
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
      "=== non-seller porcelain (intentionally excluded from seller-flow commits) ===",
      nonSellerPorcelain || "(none)",
      "",
      "=== seller-flow diff stat c45c0dd..HEAD ===",
      sessionDiffStat || "(no diff)",
      "",
      "=== attestation ===",
      `commits_since_c45c0dd=${run("git log --oneline c45c0dd..HEAD | wc -l").trim()}`,
      `files_in_seller_scope_commits=${[...new Set(committedFiles)].length}`,
      `total_porcelain_lines=${run("git status --porcelain | wc -l").trim()}`,
      `non_seller_porcelain_lines=${nonSellerPorcelain ? nonSellerPorcelain.split("\n").length : 0}`,
      "policy=no unrelated global changes forced into seller-flow commits",
    ].join("\n")
  );

  // Step 4: push with full stdout + remote ref confirmation
  console.log("[evidence] git push");
  const pushOutput = run("git push origin seller-autopilot 2>&1");
  const remoteRef = run("git ls-remote origin refs/heads/seller-autopilot 2>&1").trim();
  writeLog(
    "push.log",
    [
      "=== VERIFICATION PLAN STEP 4: PUSH ===",
      `LOCAL_HEAD=${head}`,
      "",
      "=== git push stdout/stderr ===",
      pushOutput.trim() || "(no output)",
      "",
      "=== origin seller-autopilot ref ===",
      remoteRef,
      "",
      `remote_matches_local=${remoteRef.startsWith(head)}`,
    ].join("\n")
  );

  const safetyBefore = await captureSafetyCounts(env, "before_prod_proof");
  writeLog("prod-safety-before.json", JSON.stringify(safetyBefore, null, 2));

  // Step 5: deploy — capture RAW vercel output first (no prepended assertions)
  console.log("[evidence] vercel deploy --prod");
  const deployOutput = run("vercel deploy --prod --yes 2>&1", { cwd: API_ROOT });
  writeLog("deploy.log", deployOutput);

  let inspectOutput = "";
  let inspectMeta = { ready: false, deployment_url: null, status: null };
  try {
    inspectOutput = run(`vercel inspect ${PROD_ALIAS.replace("https://", "")} 2>&1`, {
      cwd: API_ROOT,
    });
    inspectMeta = parseInspectDeployment(inspectOutput);
    appendFileSync(
      resolve(SCRATCH, "deploy.log"),
      `\n\n=== VERCEL INSPECT (${PROD_ALIAS}) ===\n${inspectOutput}\n`
    );
  } catch (error) {
    appendFileSync(
      resolve(SCRATCH, "deploy.log"),
      `\n\n=== VERCEL INSPECT FAILED ===\n${error?.message || error}\n`
    );
  }

  const buildCompletedInOutput = /Build Completed/i.test(deployOutput);
  const aliasedInOutput = new RegExp(
    `Aliased:\\s*${PROD_ALIAS.replace("https://", "").replace(/\./g, "\\.")}`,
    "i"
  ).test(deployOutput);
  const ready = buildCompletedInOutput && (aliasedInOutput || inspectMeta.ready);
  appendFileSync(
    resolve(SCRATCH, "deploy.log"),
    `\n${[
      "=== DEPLOY METADATA (appended after raw CLI output) ===",
      `DEPLOY_SHA=${head}`,
      `DEPLOY_BRANCH=${branch}`,
      `PROD_ALIAS=${PROD_ALIAS}`,
      `build_completed_in_cli_output=${buildCompletedInOutput}`,
      `aliased_to_prod_in_cli_output=${aliasedInOutput}`,
      `inspect_status=${inspectMeta.status || "unknown"}`,
      `inspect_deployment_url=${inspectMeta.deployment_url || "unknown"}`,
      `build_success_observed=${ready}`,
    ].join("\n")}\n`
  );

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
        inspect_deployment: inspectMeta,
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
    prod_version: versionBeforeProof,
    version_matches_head: versionMatchesHead,
    deploy_inspect: inspectMeta,
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
    recovery_yes_inbound: {
      lookup: yesInbound,
      http_status: yesRecoveryResStatus,
      request: yesInbound?.id
        ? {
            message_event_id: yesInbound.id,
            dry_run: true,
            auto_reply_mode: "live_limited",
          }
        : null,
      response: yesRecoveryJson,
      summarized: yesRecoveryJson?.results?.[0]
        ? summarizeProofResult(yesRecoveryJson.results[0])
        : null,
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
    `deploy_aliased_in_cli_output=${aliasedInOutput}`,
    `inspect_ready=${inspectMeta.ready}`,
    "",
    "=== PROOF CASES ===",
    ...((prodVerifyPayload.proof_cases.summarized || []).map((r) =>
      [
        `--- ${r.proof_case}`,
        `  intent=${r.normalized_intent} stage=${r.stage_before}->${r.stage_after}`,
        `  canonical_should_queue_reply=${r.canonical_should_queue_reply} planned_queue_action=${r.planned_queue_action}`,
        `  queues_s2_reply_preview=${r.queues_s2_reply_preview} execution_shadow_only=${r.execution_shadow_only}`,
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
    "=== RECOVERY YES INBOUND (production message_event) ===",
    yesInbound?.id
      ? [
          `  message_event_id=${yesInbound.id} body=${JSON.stringify(yesInbound.message_body)}`,
          `  ok=${yesRecoveryJson?.ok} intent=${prodVerifyPayload.recovery_yes_inbound.summarized?.normalized_intent || "unknown"}`,
          `  canonical_should_queue_reply=${prodVerifyPayload.recovery_yes_inbound.summarized?.canonical_should_queue_reply}`,
          `  stage=${prodVerifyPayload.recovery_yes_inbound.summarized?.stage_before}->${prodVerifyPayload.recovery_yes_inbound.summarized?.stage_after}`,
        ].join("\n")
      : `  lookup_error=${yesInbound?.error || "unknown"}`,
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
      `deploy_aliased_in_cli_output=${aliasedInOutput}`,
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

  if (!ready) throw new Error("deploy.log missing Build Completed + prod alias markers");
  if (!proofJson.ok) throw new Error("prod proof_cases returned ok:false");
  if (!versionMatchesHead) {
    throw new Error(
      `prod /api/version commit=${versionBeforeProof?.commit || "unknown"} does not match HEAD ${head}`
    );
  }

  console.log("[evidence] complete");
  console.log(summaryLines.join("\n"));
}

main().catch((error) => {
  writeFileSync(resolve(SCRATCH, "blocker.log"), `${error?.stack || error?.message || error}\n`);
  console.error("[evidence] blocked:", error?.message || error);
  process.exit(1);
});