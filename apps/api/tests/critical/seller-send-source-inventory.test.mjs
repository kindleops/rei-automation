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
  // A DEFECT RATCHET, not an approval.
  //
  // Each of these mints queue identity from a fresh UUID when the deterministic
  // derivation yields nothing. A row keyed on a fresh UUID is unique by
  // construction, so every dedupe lookup against it misses and the guard
  // silently does nothing. This is the identity hole lck_v1 closes: it derives
  // identity from durable business anchors and REFUSES rather than inventing.
  //
  // The worst is the Discord operator reply, which has no deterministic path at
  // all -- queue_key is ALWAYS a fresh UUID, so two operators (or one operator
  // clicking twice) produce two unrelated rows for one intent.
  //
  // These are NOT removed here. Deleting a fallback without the §11 tables in
  // place would fail enqueue outright for callers relying on it, and that
  // migration has not been applied. This freezes the blast radius; a NEW site
  // fails this test, and the whole test is deleted when convergence lands.
  const KNOWN = {
    "app/api/dev/send-test/route.js:68": "TEST_ONLY",
    "app/api/internal/discord/reply-sms/route.js:505": "PENDING_CONVERGENCE",
    "app/api/internal/discord/reply-sms/route.js:506": "PENDING_CONVERGENCE",
    "lib/domain/acquisition/inbound-dispatcher.js:420": "PENDING_CONVERGENCE",
    "lib/domain/inbox/send-now-service.js:482": "PENDING_CONVERGENCE",
    "lib/domain/queue/canonical-queue-writer.js:149": "PENDING_CONVERGENCE",
    "lib/supabase/sms-engine.js:4241": "PENDING_CONVERGENCE",
    "lib/supabase/sms-engine.js:4242": "PENDING_CONVERGENCE",
    // Same defect shape, different blast radius: these key an EVENT LEDGER, not
    // send_queue, so a miss duplicates a ledger row rather than a seller SMS.
    // Listed so the ratchet stays complete; not part of the send convergence.
    "lib/domain/acquisition/acquisition-event-service.js:59": "EVENT_LEDGER_NOT_SEND",
    "lib/domain/workflow-v2/events-service.js:64": "EVENT_LEDGER_NOT_SEND",
  };

  // Raw lines: comment stripping would shift every line number reported here.
  const sites = [];
  for (const f of FILES) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/randomUUID\(\)|Math\.random\(\)/.test(line)) continue;
      if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
      const ctx = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
      if (!/queue_key|dedupe_key/.test(ctx)) continue;
      sites.push(`${rel(f)}:${i + 1}`);
    }
  }
  assert.deepEqual(sites.sort(), Object.keys(KNOWN).sort(),
    `random queue identity appeared somewhere new:\n  ${sites.join("\n  ")}`);
});

test("the Discord operator reply has NO deterministic identity at all", () => {
  // Called out separately because it is a different severity. The others fall
  // back to a UUID only when a deterministic derivation comes up empty; this
  // one never attempts a derivation, so every single operator reply is
  // undedupable by construction.
  const route = fs.readFileSync(path.join(SRC, "app/api/internal/discord/reply-sms/route.js"), "utf8");
  assert.match(route, /const queue_key = randomUUID\(\);/,
    "if this gained a deterministic derivation, update the inventory severity note");
});

// ── the new seam is dormant until the migration gate ───────────────────────

test("the canonical dispatch seam is not wired into any live path", () => {
  // §11's tables do not exist in production (verified: 0 tables, 0 RPCs). Until
  // they do, the seam must remain unreachable, so landing this branch cannot
  // change what any seller receives. When convergence begins, this test is
  // replaced by the inverse assertion: that every PENDING_CONVERGENCE source
  // reaches the provider ONLY through it.
  const importers = FILES
    .filter((f) => !rel(f).startsWith("lib/domain/communications/"))
    .filter((f) => /canonical-communication-dispatch|executeSellerCommunicationAttempt/.test(code(f)))
    .map(rel);
  assert.deepEqual(importers, [],
    `the seam became reachable before the migration was applied:\n  ${importers.join("\n  ")}`);
});

test("the seam refuses rather than falling back when its store is missing", () => {
  // The failure mode that would quietly undo the whole slice: a dispatcher that
  // shrugs and calls the old send path when the ledger is unavailable. Pin the
  // absence of any such fallback.
  const seam = code(path.join(SRC, "lib/domain/communications/canonical-communication-dispatch.js"));
  assert.match(seam, /logical_communication_store_unavailable/,
    "a missing store must produce a refusal");
  assert.ok(!/sendTextgridSMS/.test(seam),
    "the seam must reach the provider only through its injected sendProvider");
});
