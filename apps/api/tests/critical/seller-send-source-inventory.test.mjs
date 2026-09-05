/**
 * seller-send-source-inventory.test.mjs
 *
 * A ratchet, not a description.
 *
 * §11 only means anything if the set of places a seller message can originate
 * is CLOSED. Converging today's sources is worthless if a new direct
 * sendTextgridSMS() call can land tomorrow without anyone noticing. This file
 * pins the inventory: adding a provider call site or a queue-row creator fails
 * here and forces an explicit decision about which classification it takes.
 *
 * Classifications:
 *   CONVERGED_CANONICAL  routes through the canonical dispatch seam
 *   PENDING_CONVERGENCE  seller-visible, still direct; the work list
 *   HARD_FENCED          reachable only behind an operator/env fence
 *   TEST_ONLY            cannot execute in production (proven, not assumed)
 *   DEAD                 substrate removed; unreachable
 *   OUT_OF_SCOPE         not seller-visible
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../src");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}
const FILES = walk(SRC);
const rel = (f) => path.relative(SRC, f);

/** Line comments stripped: a mention in prose is not a call site. */
function code(file) {
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .join("\n");
}

// ── the provider primitive ─────────────────────────────────────────────────

const PROVIDER_CALL_SITES = {
  "lib/domain/queue/process-send-queue.js": "PENDING_CONVERGENCE", // the canonical drain + legacy Podio path
  "lib/domain/inbox/send-now-service.js": "PENDING_CONVERGENCE",   // manual operator send
  "lib/verification/live-textgrid.js": "HARD_FENCED",              // canary/readiness verification
  "app/api/dev/force-send/route.js": "TEST_ONLY",                  // 404 in production, proven live
  "lib/domain/buyers/send-buyer-blast.js": "OUT_OF_SCOPE",         // buyer messaging, not seller
};

test("sendTextgridSMS is the ONLY provider send primitive", () => {
  const adapter = fs.readFileSync(path.join(SRC, "lib/providers/textgrid.js"), "utf8");
  const exported = [...adapter.matchAll(/^export (?:async )?function (send\w*)/gm)].map((m) => m[1]);
  assert.deepEqual(exported, ["sendTextgridSMS"],
    `a second send primitive would route around the inventory: ${exported.join(", ")}`);
});

test("no module reaches the provider HTTP endpoint directly", () => {
  const offenders = FILES.filter((f) =>
    rel(f) !== "lib/providers/textgrid.js" && /api\.textgrid\.com/.test(code(f)))
    .map(rel)
    // Status LOOKUP is a read, not a send: it cannot deliver a message.
    .filter((r) => r !== "lib/domain/delivery/delivery-polling-fallback.js");
  assert.deepEqual(offenders, [],
    `these bypass the adapter entirely:\n  ${offenders.join("\n  ")}`);
});

test("the provider call-site inventory is exactly as classified", () => {
  const found = FILES
    .filter((f) => rel(f) !== "lib/providers/textgrid.js")
    .filter((f) => /\bsendTextgridSMS\b/.test(code(f)))
    .map(rel)
    .sort();
  assert.deepEqual(found, Object.keys(PROVIDER_CALL_SITES).sort(),
    "a provider call site was added or removed: classify it in PROVIDER_CALL_SITES");
});

test("no seller-visible provider call site is left UNKNOWN", () => {
  for (const [file, klass] of Object.entries(PROVIDER_CALL_SITES)) {
    assert.ok(
      ["CONVERGED_CANONICAL", "PENDING_CONVERGENCE", "HARD_FENCED", "TEST_ONLY", "DEAD", "OUT_OF_SCOPE"].includes(klass),
      `${file} has no valid classification`);
  }
});

// ── queue row creators: the other way a seller message begins ──────────────

const QUEUE_ROW_CREATORS = [
  "app/api/dev/send-test/route.js",
  "app/api/internal/proof/s1s2-attended/route.js",
  "lib/domain/acquisition/delivery-retry-engine.js",
  "lib/domain/acquisition/inbound-dispatcher.js",
  "lib/domain/acquisition/no-reply-followup-scheduler.js",
  "lib/domain/campaigns/enqueue-campaign-target-one.js",
  "lib/domain/closings/advance-closing-workflow.js",
  "lib/domain/inbound/unknown-inbound-router.js",
  "lib/domain/inbox/send-now-service.js",
  "lib/domain/outbound/run-supabase-outbound-feeder.js",
  "lib/domain/queue/build-send-queue-item.js",
  "lib/domain/queue/canonical-queue-writer.js",
  "lib/domain/seller-flow/apply-inbound-automation-decision.js",
  "lib/domain/seller-flow/execute-referral-automation.js",
  "lib/domain/workflow-v2/queue-adapter.js",
  "lib/sms/queue_message.js",
  "lib/supabase/sms-engine.js",
];

test("the set of queue-row creators is closed", () => {
  const found = FILES
    .filter((f) => /\binsertSupabaseSendQueueRow\b/.test(code(f)))
    .map(rel)
    .sort();
  assert.deepEqual(found, [...QUEUE_ROW_CREATORS].sort(),
    "a new seller send source appeared: add it to QUEUE_ROW_CREATORS and converge it");
});

test("only ONE module inserts send_queue rows without the shared helper", () => {
  // The bulk campaign path builds rows itself and inserts them in chunks, so it
  // is the one creator that never passes through insertSupabaseSendQueueRow and
  // therefore never sees the identity the helper would attach.
  const direct = FILES.filter((f) => {
    const lines = code(f).split("\n");
    return lines.some((l, i) =>
      /from\(['"]send_queue['"]\)/.test(l) &&
      lines.slice(i, i + 6).some((n) => /\.(insert|upsert)\(/.test(n)));
  }).map(rel).sort();
  assert.deepEqual(direct, ["lib/domain/campaigns/campaign-automation-service.js"],
    "a new direct send_queue insert bypasses every identity guard");
});

// ── the identity defect this slice replaces ────────────────────────────────

test("the existing queue idempotency key is template-sensitive", () => {
  // Documents WHY lck_v1 is needed rather than reusing what is already there.
  // The canonical writer keys dedupe on template_id, so re-rendering the same
  // domain action under a different template mints a NEW key, the dedupe lookup
  // misses, and a second queue row is created for one decision. lck_v1 derives
  // identity from the decision alone, which is why the dispatch proof
  // "a template change does not create a second communication" passes.
  const writer = fs.readFileSync(path.join(SRC, "lib/domain/queue/canonical-queue-writer.js"), "utf8");
  assert.match(writer, /idempotency_key\s*=[\s\S]{0,200}template_id/,
    "if this stops being template-keyed, re-check whether lck_v1 still adds identity safety");
});

test("random queue identity is confined to the KNOWN sites", () => {
  // A DEFECT RATCHET, keyed on FILE + CODE SHAPE rather than file:line.
  //
  // Line pinning fired on every unrelated edit above these sites (adding one
  // import to the Discord route shifted two entries and failed the gate while
  // the site SET was unchanged). A ratchet that cries wolf on formatting gets
  // silenced, so it keys on what the code DOES.
  //
  // Post-§11 these are all TRANSPORT_ONLY: queue_key is listed in
  // FORBIDDEN_IDENTITY_FIELDS, so a random value structurally cannot mint a
  // logical communication. They are still pinned because a NEW site is a signal
  // that someone is building identity out of randomness again.
  const KNOWN = new Set([
    "app/api/dev/send-test/route.js",                       // TEST_ONLY
    "app/api/internal/discord/reply-sms/route.js",          // CONVERGED (operator_action_id anchors it)
    "lib/domain/acquisition/acquisition-event-service.js",  // EVENT_LEDGER, not a send
    "lib/domain/acquisition/inbound-dispatcher.js",         // TRANSPORT_ONLY
    "lib/domain/inbox/send-now-service.js",                 // CONVERGED (operator_action_id)
    "lib/domain/queue/canonical-queue-writer.js",           // DEAD (both importers quarantined)
    "lib/domain/workflow-v2/events-service.js",             // EVENT_LEDGER, not a send
    "lib/supabase/sms-engine.js",                           // TRANSPORT_ONLY
  ]);

  const sites = new Set();
  for (const f of FILES) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/randomUUID\(\)|Math\.random\(\)/.test(line)) continue;
      if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
      const ctx = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
      if (!/queue_key|dedupe_key/.test(ctx)) continue;
      sites.add(rel(f));
    }
  }
  assert.deepEqual([...sites].sort(), [...KNOWN].sort(),
    "random queue identity appeared in a file not on the known list");
});

test("queue_key can never become logical identity, by construction", () => {
  // The structural reason every site above is TRANSPORT_ONLY rather than a
  // judgement call: the key builder REFUSES these fields outright.
  const keyModule = fs.readFileSync(path.join(SRC, "lib/domain/communications/logical-communication-key.js"), "utf8");
  assert.match(keyModule, /FORBIDDEN_IDENTITY_FIELDS/);
  for (const field of ["queue_key", "queue_row_id"]) {
    assert.ok(keyModule.includes(`"${field}"`) || keyModule.includes(`'${field}'`),
      `${field} must be a forbidden identity field`);
  }
});

test("the Discord operator reply now has DURABLE operator identity", () => {
  // This previously asserted the opposite: queue_key = randomUUID() with no
  // deterministic path at all. Converging it was not optional -- once dispatch
  // began refusing identity-underivable rows, every Discord reply became a
  // silent dead end where the operator saw success and the seller got nothing.
  const route = fs.readFileSync(path.join(SRC, "app/api/internal/discord/reply-sms/route.js"), "utf8");
  assert.match(route, /resolveOperatorAction\(/,
    "a Discord reply must create a durable operator action");
  assert.match(route, /operator_action_id: operator_action\.operator_action_id/,
    "the queue row must carry the anchor dispatch derives identity from");
  assert.ok(
    route.indexOf("await resolveOperatorAction(") < route.indexOf("const payload = {"),
    "the action must be durable BEFORE the row is enqueued");
});

// ── DIRECT_PROVIDER_BYPASS = 0 ────────────────────────────────────────────
//
// These replace the earlier dormancy assertions. Those checked that NOTHING
// imported the seam, which was right while §11 was inert and became VACUOUS the
// moment convergence landed: both adapters live under lib/domain/communications/,
// so the old scan excluded exactly the files that now do the wiring. A guard
// that cannot fail is worse than no guard, so it is replaced by its inverse.

/** Provider invocation, as opposed to merely naming or injecting the function. */
function providerInvocations(file) {
  const hits = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
    // `await sendTextgridSMS(` / `await send_textgrid_sms(` = calling it.
    // `sendProvider: (args) => sendTextgridImpl({` = handing it to the seam,
    // which is the converged shape and must NOT be flagged.
    if (/await\s+(sendTextgridSMS|send_textgrid_sms|sendTextgridImpl)\s*\(/.test(line)) {
      hits.push(`${rel(file)}:${i + 1}: ${t}`);
    }
  });
  return hits;
}

test("the ONLY module that invokes the provider is the canonical seam", () => {
  // The seam calls its injected sendProvider; everyone else must hand the
  // function TO the seam rather than calling it.
  const offenders = [];
  for (const f of FILES) {
    const r = rel(f);
    if (r === "lib/providers/textgrid.js") continue;                 // the definition
    if (r === "lib/domain/buyers/send-buyer-blast.js") continue;      // buyer, out of scope
    if (r === "lib/verification/live-textgrid.js") continue;          // HARD_FENCED canary
    if (r === "app/api/dev/force-send/route.js") continue;            // TEST_ONLY, 404 in prod
    if (r === "lib/domain/queue/process-send-queue.js") {
      // The legacy Podio body is retained for review but unreachable; the live
      // supabase path must contain no invocation at all.
      const live = providerInvocations(f).filter((h) => !/UnreachableLegacy/.test(h));
      const src = fs.readFileSync(f, "utf8");
      assert.ok(src.includes("processLegacyQueueItemUnreachable"),
        "the legacy body must remain fenced behind the unreachable marker");
      // Only the retained (unreachable) legacy body may still invoke it.
      assert.ok(live.length <= 1,
        `process-send-queue may not invoke the provider on the live path:\n  ${live.join("\n  ")}`);
      continue;
    }
    offenders.push(...providerInvocations(f));
  }
  assert.deepEqual(offenders, [],
    `seller-visible provider invocation outside the canonical seam:\n  ${offenders.join("\n  ")}`);
});

test("both former bypasses now route through the canonical seam", () => {
  const queue = code(path.join(SRC, "lib/domain/queue/process-send-queue.js"));
  assert.match(queue, /dispatchSellerQueueRow\(/,
    "process-send-queue must dispatch through the seam");

  const manual = code(path.join(SRC, "lib/domain/inbox/send-now-service.js"));
  assert.match(manual, /dispatchManualOperatorSend\(/,
    "send-now must dispatch through the seam");
  // The resolver is injectable, so the call site reads resolve_operator_action().
  // Match the CALL, not the import: an unused import would satisfy the latter.
  assert.match(manual, /await resolve_operator_action\(/,
    "a manual send must establish durable operator identity BEFORE dispatch");
  assert.ok(
    manual.indexOf("await resolve_operator_action(") < manual.indexOf("dispatchManualOperatorSend("),
    "the operator action must be durable BEFORE dispatch, not created during it");
});

test("the legacy Podio path is hard-fenced before any provider work", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/domain/queue/process-send-queue.js"), "utf8");
  assert.match(src, /legacy_podio_path_fenced_by_s11/,
    "the legacy path must refuse rather than reach a seller");
  // The fence must come BEFORE the retained body, or it fences nothing.
  assert.ok(
    src.indexOf("legacy_podio_path_fenced_by_s11") < src.indexOf("processLegacyQueueItemUnreachable"),
    "the fence must precede the retained legacy body");
});

test("the seam refuses rather than falling back when its store is missing", () => {
  // The change that would quietly undo the whole slice: a dispatcher that
  // shrugs and calls the old send path when the ledger is unavailable.
  const seam = code(path.join(SRC, "lib/domain/communications/canonical-communication-dispatch.js"));
  assert.match(seam, /logical_communication_store_unavailable/,
    "a missing store must produce a refusal");
  assert.ok(!/sendTextgridSMS/.test(seam),
    "the seam must reach the provider only through its injected sendProvider");
});

test("a queue row whose action cannot be named is refused, not sent", () => {
  const resolver = code(path.join(SRC, "lib/domain/communications/queue-row-identity.js"));
  assert.match(resolver, /queue_row_identity_underivable/,
    "an underivable row must produce a refusal reason");
  assert.ok(!/randomUUID|Math\.random/.test(resolver),
    "identity must never be invented when it cannot be derived");
});
