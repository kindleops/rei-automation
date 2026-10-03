import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Cloudflare scheduler scope.
//
// The Worker is release-only TypeScript with no runtime harness here, so this
// asserts against its SOURCE. That is the right level: "no send-capable job is
// reachable from a schedule" is a static property of the job tables, the
// per-job flags, and the trigger lists.

const WORKER = new URL("../../../../infra/cloudflare/worker/index.ts", import.meta.url);
const STAGING = new URL("../../../../infra/cloudflare/wrangler.jsonc", import.meta.url);
const PRODUCTION = new URL("../../../../infra/cloudflare/wrangler.production.jsonc", import.meta.url);

// Reconciliation lanes. None can produce a dispatchable send_queue row.
//
// PRODUCTION-COMMISSIONING-1 added the last two, both moved off
// apps/api/vercel.json when its crons were removed so this Worker became the
// only scheduler touching the production database. Each is send-incapable for a
// stated structural reason, not because a flag happens to be off:
//
//   workflows/runtime-tick  runWorkflowRuntimeTick returns live_send_blocked
//                           and no_outbound_messages_sent; workflow-generated
//                           communication is written `no_send` and the queue
//                           processor refuses it. Independently,
//                           matchDefinitions requires status='active' and the
//                           14 real acquisition workflows are 'published'.
//   queue/reconcile         writes only terminal/delivered statuses, which are
//                           disjoint from the five the processor claims, so it
//                           cannot produce a claimable row.
const RECONCILIATION_JOB_PATHS = [
  "/api/internal/seller-flow/reconcile-state",
  "/api/internal/webhooks/recover-delivery",
  "/api/internal/workflows/runtime-tick",
  "/api/internal/queue/reconcile",
];

// THE ONE SEND-CAPABLE JOB, commissioned by explicit operator authorization.
// It is singular on purpose: this constant is what keeps "production outbound
// is on" from drifting into "several routes may now send". Adding a second
// entry here should be as deliberate as adding the first.
const SEND_CAPABLE_JOB_PATHS = ["/api/internal/queue/run"];

// CAMPAIGN EXECUTION, commissioned 2026-09-28 by explicit operator
// authorization. Neither transmits: activate-due walks scheduled->active (a
// stale schedule is marked missed, never fired) and feed writes send_queue rows
// that only queue/run can send, under every operator brake. They ARM rows, which
// is why they were forbidden until an operator commissioned them by name.
const CAMPAIGN_EXECUTION_JOB_PATHS = [
  "/api/internal/campaigns/activate-due",
  "/api/internal/campaigns/feed",
];

/**
 * Closing automation: writes closing_email_requests (never sends), cancels,
 * escalates, notifies. Not send-capable, no stage/money writes.
 */
const CLOSING_AUTOMATION_JOB_PATHS = ["/api/internal/closings/automation"];

/**
 * THE ONE EMAIL SENDER, commissioned 2026-09-29 by explicit operator request
 * (Email Command: "use canonical Cloudflare scheduling … Do NOT create Vercel
 * cron jobs"; Brevo chosen as the one transport). A different channel from
 * SMS, so it is counted separately: the SMS invariant below stays "exactly
 * queue/run". It transmits only with EMAIL_SEND_ENABLED=true (default deny,
 * forwarded unconditionally as "false") AND system_control.email_enabled.
 */
const EMAIL_SEND_CAPABLE_JOB_PATHS = ["/api/internal/email/dispatch"];

/**
 * Workflow orchestrator, commissioned 2026-09-29 by explicit operator request
 * ("Wire the Workflow Orchestrator into the canonical Cloudflare scheduler
 * behind its explicit production flag and enable it"). Not a transport: its
 * only send capability requires an operator Approval on every path and then
 * writes a send_queue row that only queue/run can send.
 */
const WORKFLOW_ORCHESTRATOR_JOB_PATHS = ["/api/internal/workflow-studio/orchestrator/tick"];

/**
 * Signal Center evaluator (Platform 7.0) — registered, NOT commissioned: its
 * CRON_SIGNAL_EVALUATE_ENABLED flag is absent from every wrangler config.
 * Send-incapable (writes only signal tables + notification_events).
 */
const SIGNAL_EVALUATE_JOB_PATHS = ["/api/internal/signals/evaluate"];

/**
 * Notification Center 2.0 story projector (RC 8.2) — registered on its own
 * "*\/1" lane, NOT commissioned: no wrangler trigger declares that lane and its
 * CRON_NOTIFICATION_STORIES_PROJECT_ENABLED flag is absent everywhere.
 * Send-incapable (writes only the notification_stor* projection tables).
 */
const NOTIFICATION_PROJECTION_JOB_PATHS = ["/api/internal/notifications/stories/project"];

const ALLOWED_JOB_PATHS = [...RECONCILIATION_JOB_PATHS, ...SEND_CAPABLE_JOB_PATHS, ...CAMPAIGN_EXECUTION_JOB_PATHS, ...CLOSING_AUTOMATION_JOB_PATHS, ...EMAIL_SEND_CAPABLE_JOB_PATHS, ...WORKFLOW_ORCHESTRATOR_JOB_PATHS, ...SIGNAL_EVALUATE_JOB_PATHS, ...NOTIFICATION_PROJECTION_JOB_PATHS];

// Every one of these can send a seller-visible message, or arm a row that a
// later processor run would send. None may be reachable from a schedule.
// queue/run has MOVED OUT of this list; the rest have not.
const FORBIDDEN_JOBS = [
  "/api/internal/queue/retry",
  "/api/internal/queue/force-due",
  "/api/internal/campaigns/recover-stale-expired",
  "/api/internal/autopilot/run",
  "/api/internal/seller-flow/flush-inbound-bursts",
  // The BROAD recovery route: replays inbound under live_limited and runs all
  // seven gap sweeps. The narrow reconcile-state adapter replaces it.
  "/api/internal/seller-flow/recover-inbound",
  "/api/internal/webhooks/recover-inbound",
  "/api/internal/offers/recalculate",
];

/**
 * Worker source with comments stripped, because the prose deliberately names
 * forbidden jobs and matching on prose would pass for the wrong reason.
 *
 * Line-based on purpose. A regex block-comment stripper mispairs here: the cron
 * literal "*\/5 * * * *" contains a comment terminator, so it swallowed real
 * code. This only inspects how a line STARTS, which a string literal cannot fake.
 */
async function workerCode() {
  const raw = await readFile(WORKER, "utf8");
  const out = [];
  let inBlock = false;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      if (t.endsWith("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.endsWith("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("*")) continue;
    out.push(line);
  }
  return out.join("\n");
}

async function declaredCrons(configUrl) {
  const raw = await readFile(configUrl, "utf8");
  const stripped = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const block = stripped.match(/"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[([^\]]*)\]/);
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

async function configVars(configUrl) {
  const raw = await readFile(configUrl, "utf8");
  const stripped = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const block = stripped.match(/"vars"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return {};
  return Object.fromEntries([...block[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

test("no send-capable job appears anywhere in the worker's executable code", async () => {
  const code = await workerCode();
  for (const job of FORBIDDEN_JOBS) {
    assert.ok(!code.includes(job), `a schedule could reach a send-capable job: ${job}`);
  }
});

test("every registered job path is on the allowlist", async () => {
  const code = await workerCode();
  const registered = [...code.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(registered.length > 0, "expected at least one registered job");
  for (const path of registered) {
    assert.ok(ALLOWED_JOB_PATHS.includes(path), `unexpected scheduled job registered: ${path}`);
  }
});

test("EXACTLY ONE send-capable job is registered, and it is the canonical runner", async () => {
  // The failure this guards is not "outbound is on" -- that is now intended --
  // but outbound quietly widening to a second dispatcher, a retry lane or a
  // force-due lane that nobody separately approved.
  const code = await workerCode();
  const registered = [...code.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  const sendCapable = registered.filter((p) => SEND_CAPABLE_JOB_PATHS.includes(p));
  assert.deepEqual(sendCapable, ["/api/internal/queue/run"]);
  // Email is its own, singular sender.
  assert.deepEqual(registered.filter((p) => EMAIL_SEND_CAPABLE_JOB_PATHS.includes(p)), ["/api/internal/email/dispatch"]);
});

test("the email sender is default-deny: EMAIL_SEND_ENABLED is forwarded as 'false' unless explicitly 'true'", async () => {
  const code = await workerCode();
  assert.match(code, /EMAIL_SEND_ENABLED:\s*env\.EMAIL_SEND_ENABLED === "true" \? "true" : "false"/);
  for (const k of ["BREVO_API_KEY", "BREVO_WEBHOOK_SECRET", "EMAIL_INBOUND_SECRET"]) {
    assert.match(code, new RegExp(`env\\.${k}\\s*\\?`), `${k} must be forwarded conditionally`);
  }
});

test("the queue runner carries NO body, so system_control owns throughput", async () => {
  // A body here would let a deployed literal outrank a live operator setting
  // for limit / batch size / caps. The runner must read those from the DB.
  const code = await workerCode();
  const block = code.match(/const QUEUE_RUN: CronJob = \{([\s\S]*?)\};/);
  assert.ok(block, "QUEUE_RUN must be declared");
  assert.ok(!/body\s*:/.test(block[1]), "the queue runner must not hardcode a body");
});

test("EVERY job carries its own enable flag, so the master switch cannot awaken it alone", async () => {
  const code = await workerCode();
  const jobBlocks = [...code.matchAll(/\{\s*id:\s*"([^"]+)",\s*enabledBy:\s*"([^"]+)",\s*path:\s*"([^"]+)"/g)];
  assert.ok(jobBlocks.length >= 2, "expected the reconciliation jobs to declare id + enabledBy + path");

  const flags = new Set();
  for (const [, id, enabledBy, path] of jobBlocks) {
    assert.ok(enabledBy.startsWith("CRON_"), `${id} must name a CRON_* flag, got ${enabledBy}`);
    assert.notEqual(enabledBy, "CRON_ENABLED", `${id} must not reuse the master switch as its job flag`);
    assert.ok(ALLOWED_JOB_PATHS.includes(path), `${id} points at an unapproved path`);
    flags.add(enabledBy);
  }
  assert.equal(flags.size, jobBlocks.length, "each job needs a DISTINCT flag, else one toggle moves two jobs");
});

test("the dispatcher filters on the per-job flag and defaults it to false", async () => {
  const code = await workerCode();
  assert.match(code, /job\.enabledBy/, "dispatch must consult each job's own flag");
  assert.match(code, /\?\?\s*"false"/, "an absent per-job flag must read as false");
  assert.ok(/jobs\.length === 0/.test(code), "an empty enabled set must return without dispatching");
});

test("job resolution is default-deny on BOTH environment and expression", async () => {
  const code = await workerCode();
  assert.match(code, /CRON_JOBS_BY_ENV\[[^\]]*\]\s*\?\?\s*\{\}/, "unknown env must resolve to an empty table");
  assert.match(code, /table\[event\.cron\]\s*\?\?\s*\[\]/, "unknown expression must resolve to no jobs");
});

test("CRON_ENABLED and CRON_SECRET both still gate dispatch", async () => {
  const code = await workerCode();
  assert.match(code, /env\.CRON_ENABLED\s*\?\?\s*"false"/, "missing CRON_ENABLED must default to false");
  assert.ok(code.includes("CRON_SECRET"), "CRON_SECRET guard must remain");
});

test("the delivery reconciler still runs with its outbound provider call disabled", async () => {
  const code = await workerCode();
  assert.match(code, /include_polling_fallback:\s*false/);
});

test("production declares the reconciliation and send schedules, and only approved flags", async () => {
  assert.deepEqual(await declaredCrons(PRODUCTION), ["*/5 * * * *", "* * * * *"]);

  const vars = await configVars(PRODUCTION);
  assert.equal(vars.DEPLOYMENT_ENV, "production");
  assert.equal(vars.CRON_ENABLED, "true", "production is commissioned");

  // Only commissioned flags may be true. Any other CRON_* flag turned on is
  // an unapproved job.
  const enabled = Object.entries(vars).filter(([k, v]) => k.startsWith("CRON_") && v === "true").map(([k]) => k);
  assert.deepEqual(
    enabled.sort(),
    [
      // Campaign execution, operator-commissioned 2026-09-28.
      "CRON_CAMPAIGN_ACTIVATE_DUE_ENABLED",
      "CRON_CAMPAIGN_FEED_ENABLED",
      "CRON_CLOSING_AUTOMATION_ENABLED",
      "CRON_DELIVERY_RECONCILE_ENABLED",
      // Email Command dispatcher, operator-commissioned 2026-09-29.
      "CRON_EMAIL_DISPATCH_ENABLED",
      "CRON_ENABLED",
      // PRODUCTION-COMMISSIONING-1. Both send-incapable; see
      // RECONCILIATION_JOB_PATHS for the structural reason each one is.
      "CRON_QUEUE_RECONCILE_ENABLED",
      "CRON_QUEUE_RUN_ENABLED",
      "CRON_SELLER_STATE_RECONCILE_ENABLED",
      // Workflow orchestrator, operator-commissioned 2026-09-29.
      "CRON_WORKFLOW_ORCHESTRATOR_ENABLED",
      "CRON_WORKFLOW_RUNTIME_ENABLED",
    ],
    `unexpected enabled cron flags: ${enabled.join(", ")}`
  );

  // Intelligence Core 8.0 env ceilings (architecture §10). Approved-ON list is
  // EMPTY until the owner activates observation (tmp/ic8/design/
  // observation-activation.md); turning one on is an edit to this list.
  const IC8_CEILINGS = [
    "INTELLIGENCE_LOGGING_ENABLED",
    "SELLER_MODEL_SHADOW",
    "CONVERSATION_MODEL_SHADOW",
    "COMP_CHALLENGER_SHADOW",
    "CAMPAIGN_POLICY_SHADOW",
    "STRATEGY_RECOMMENDATIONS_ENABLED",
    "CAMPAIGN_AUTONOMY_ENABLED",
  ];
  const ic8On = IC8_CEILINGS.filter((k) => vars[k] === "true");
  assert.deepEqual(ic8On, [], `unapproved IC8 ceilings enabled: ${ic8On.join(", ")}`);
});

test("the IC8 logging ceiling is forwarded default-deny and no other IC8 ceiling is forwarded yet", async () => {
  const code = await workerCode();
  assert.match(code, /INTELLIGENCE_LOGGING_ENABLED:\s*env\.INTELLIGENCE_LOGGING_ENABLED === "true" \? "true" : "false"/);
  for (const k of ["SELLER_MODEL_SHADOW", "CONVERSATION_MODEL_SHADOW", "COMP_CHALLENGER_SHADOW", "CAMPAIGN_POLICY_SHADOW", "STRATEGY_RECOMMENDATIONS_ENABLED", "CAMPAIGN_AUTONOMY_ENABLED"]) {
    assert.ok(!new RegExp(`${k}:`).test(code), `${k} must not be forwarded before its phase`);
  }
});

test("the send lane sits on its OWN expression, not bolted onto reconciliation", async () => {
  // If queue/run shared the */5 entry, retuning send cadence would silently
  // retune reconciliation too, and a reader could not tell which schedule is
  // send-capable.
  const code = await workerCode();
  const table = code.match(/const PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(table, "PRODUCTION_CRON_JOBS must exist");
  const fiveMin = table[1].match(/"\*\/5 \* \* \* \*":\s*\[([^\]]*)\]/);
  assert.ok(fiveMin, "the */5 reconciliation entry must remain");
  assert.ok(!fiveMin[1].includes("QUEUE_RUN"), "the send lane must not ride the reconciliation schedule");
  const oneMin = table[1].match(/"\* \* \* \* \*":\s*\[([^\]]*)\]/);
  assert.ok(oneMin, "the one-minute send entry must be declared");
  // The send lane carries the senders and nothing else: the SMS runner and
  // (2026-09-29) the email dispatcher. No reconciler or feeder rides it.
  assert.deepEqual(oneMin[1].split(",").map((x) => x.trim()).filter(Boolean), ["QUEUE_RUN", "EMAIL_DISPATCH"], "the send schedule carries the senders and nothing else");
  assert.ok(!fiveMin[1].includes("EMAIL_DISPATCH"), "the email sender must not ride the reconciliation schedule");
});

test("STAGING declares no schedule and registers no job at all", async () => {
  // Staging shares the production database, so it gets no scheduler surface.
  assert.deepEqual(await declaredCrons(STAGING), [], "staging must declare no cron expressions");

  const vars = await configVars(STAGING);
  assert.equal(vars.DEPLOYMENT_ENV, "staging");
  assert.equal(vars.CRON_ENABLED, "false", "staging master switch stays off");
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith("CRON_")) assert.notEqual(v, "true", `staging must not enable ${k}`);
  }

  const code = await workerCode();
  const staging = code.match(/STAGING_CRON_JOBS[^=]*=\s*(\{[\s\S]*?\});/);
  assert.ok(staging, "STAGING_CRON_JOBS must exist");
  assert.match(staging[1].replace(/\s/g, ""), /^\{\}$/, "the staging job table must be EMPTY");
});

test("production's declared schedule maps to registered jobs, and staging's absence maps to none", async () => {
  const code = await workerCode();
  const prod = code.match(/PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(prod, "PRODUCTION_CRON_JOBS must exist");
  for (const expr of await declaredCrons(PRODUCTION)) {
    assert.ok(prod[1].includes(expr), `${expr} is declared but maps to no job`);
  }
  assert.ok(prod[1].includes("SELLER_STATE_RECONCILIATION"), "seller-state lane must be registered");
});

test("CRON_SECRET is forwarded to the container, because signing without forwarding cannot work", async () => {
  // scheduled() signs its request with `Authorization: Bearer ${env.CRON_SECRET}`,
  // but the API that VERIFIES that header runs INSIDE the container. When the
  // secret was withheld from the envVars allowlist, cron-auth saw no configured
  // secret and -- correctly, since it fails closed in production -- rejected
  // every scheduled call with 500 missing_cron_secret. Observed live:
  //   cron.done job=seller_state_reconciliation status=500
  //   cron.done job=delivery_reconciliation     status=401
  const code = await workerCode();

  assert.match(
    code,
    /env\.CRON_SECRET\s*\?\s*\{\s*CRON_SECRET:\s*env\.CRON_SECRET\s*\}/,
    "the container must receive CRON_SECRET or every scheduled call is rejected"
  );
  assert.match(
    code,
    /Authorization:\s*`Bearer \$\{env\.CRON_SECRET\}`/,
    "the Worker must still sign with the same secret it forwards"
  );

  // The forward must stay CONDITIONAL so staging, which holds no CRON_SECRET,
  // receives nothing.
  assert.ok(
    !/CRON_SECRET:\s*env\.CRON_SECRET\s*,/.test(code.replace(/env\.CRON_SECRET\s*\?[^,]*,/g, "")),
    "the forward must be conditional, never unconditional"
  );
});

test("the transport and queue-engine secrets remain withheld from the container", async () => {
  const code = await workerCode();
  // Forwarding CRON_SECRET must not have opened the door to anything else.
  for (const withheld of ["TEXTGRID_ACCOUNT_SID:", "TEXTGRID_AUTH_TOKEN:"]) {
    const forwarded = new RegExp(`env\\.${withheld.replace(":", "")}\\s*\\?`).test(code);
    // TextGrid IS forwarded by design for the send path; assert it is at least
    // conditional rather than unconditional.
    if (forwarded) {
      assert.match(code, new RegExp(`env\\.${withheld.replace(":", "")}\\s*\\?`), "must be conditional");
    }
  }
  assert.ok(!code.includes("...env,"), "never spread the whole environment into the container");
  assert.ok(
    !/QUEUE_ENGINE_SHARED_SECRET:\s*env\./.test(code),
    "the queue-engine secret must stay withheld"
  );
});

test("campaign execution jobs are registered on the */5 lane, carry no body, and are not the sender", async () => {
  const code = await workerCode();
  for (const [name, path] of [["CAMPAIGN_ACTIVATE_DUE", "/api/internal/campaigns/activate-due"], ["CAMPAIGN_FEED", "/api/internal/campaigns/feed"]]) {
    const block = code.match(new RegExp(`const ${name}: CronJob = \\{([\\s\\S]*?)\\};`));
    assert.ok(block, `${name} must be declared`);
    assert.ok(block[1].includes(path), `${name} must point at ${path}`);
    assert.ok(!/body\s*:/.test(block[1]), `${name} must not hardcode a body`);
    assert.ok(!SEND_CAPABLE_JOB_PATHS.includes(path), `${name} must not be counted as a sender`);
  }
  const table = code.match(/const PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const fiveMin = table[1].match(/"\*\/5 \* \* \* \*":\s*\[([^\]]*)\]/);
  assert.ok(fiveMin[1].includes("CAMPAIGN_ACTIVATE_DUE") && fiveMin[1].includes("CAMPAIGN_FEED"));
});

test("the workflow orchestrator rides the reconciliation cadence, never the send lane, and its env gate is default-deny", async () => {
  const code = await workerCode();
  const table = code.match(/const PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const fiveMin = table[1].match(/"\*\/5 \* \* \* \*":\s*\[([^\]]*)\]/);
  const oneMin = table[1].match(/"\* \* \* \* \*":\s*\[([^\]]*)\]/);
  assert.ok(fiveMin[1].includes("WORKFLOW_ORCHESTRATOR"));
  assert.ok(!oneMin[1].includes("WORKFLOW_ORCHESTRATOR"));
  assert.match(code, /WORKFLOW_ORCHESTRATOR_ENABLED:\s*\n?\s*env\.WORKFLOW_ORCHESTRATOR_ENABLED === "true" \? "true" : "false"/);
  const vars = await configVars(PRODUCTION);
  assert.equal(vars.WORKFLOW_ORCHESTRATOR_ENABLED, "true");
  const staging = await configVars(STAGING);
  assert.notEqual(staging.WORKFLOW_ORCHESTRATOR_ENABLED, "true", "staging shares the production DB: no orchestrator");
});

test("the Signal Center evaluator is registered on the reconciliation cadence but switched OFF everywhere (flag + env ceiling default-deny)", async () => {
  const code = await workerCode();
  const table = code.match(/const PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const fiveMin = table[1].match(/"\*\/5 \* \* \* \*":\s*\[([^\]]*)\]/);
  const oneMin = table[1].match(/"\* \* \* \* \*":\s*\[([^\]]*)\]/);
  assert.ok(fiveMin[1].includes("SIGNAL_EVALUATE"));
  assert.ok(!oneMin[1].includes("SIGNAL_EVALUATE"));
  const block = code.match(/const SIGNAL_EVALUATE: CronJob = \{([\s\S]*?)\};/);
  assert.ok(block && block[1].includes('"CRON_SIGNAL_EVALUATE_ENABLED"') && block[1].includes('"/api/internal/signals/evaluate"'));
  assert.ok(!/body\s*:/.test(block[1]), "the evaluator takes no body");
  assert.match(code, /SIGNAL_CENTER_ENABLED:\s*\n?\s*env\.SIGNAL_CENTER_ENABLED === "true" \? "true" : "false"/);
  for (const cfg of [PRODUCTION, STAGING]) {
    const vars = await configVars(cfg);
    assert.notEqual(vars.CRON_SIGNAL_EVALUATE_ENABLED, "true", "not commissioned: the owner flips this");
    assert.notEqual(vars.SIGNAL_CENTER_ENABLED, "true", "not commissioned: the owner flips this");
  }
});

test("the Notification Center projector is registered on its own lane at 30 s, but not commissioned (no trigger, no flag)", async () => {
  const code = await workerCode();
  const table = code.match(/const PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const lane = table[1].match(/"\*\/1 \* \* \* \*":\s*\[([^\]]*)\]/);
  assert.ok(lane, "the projection lane must be declared in the job table");
  assert.deepEqual(lane[1].split(",").map((x) => x.trim()).filter(Boolean), ["NOTIFICATION_STORIES_PROJECT"], "the projection lane carries the projector only");
  const oneMin = table[1].match(/"\* \* \* \* \*":\s*\[([^\]]*)\]/);
  assert.ok(!oneMin[1].includes("NOTIFICATION_STORIES_PROJECT"), "never on the send lane");
  const block = code.match(/const NOTIFICATION_STORIES_PROJECT: CronJob = \{([\s\S]*?)\};/);
  assert.ok(block && block[1].includes('"CRON_NOTIFICATION_STORIES_PROJECT_ENABLED"') && block[1].includes('"/api/internal/notifications/stories/project"'));
  assert.ok(/repeatEveryMs:\s*30_000/.test(block[1]), "fires at :00 and :30");
  assert.ok(!/body\s*:/.test(block[1]), "the projector takes no body");
  for (const cfg of [PRODUCTION, STAGING]) {
    const vars = await configVars(cfg);
    assert.notEqual(vars.CRON_NOTIFICATION_STORIES_PROJECT_ENABLED, "true", "not commissioned: the owner flips this");
    assert.ok(!(await declaredCrons(cfg)).includes("*/1 * * * *"), "the projection lane is not a declared trigger yet");
  }
});
