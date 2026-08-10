import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateProofGate,
  runArmAndS1,
  runVerifyAndS2,
  runS1S2ProofWatchdog,
  restoreContainment,
  EXPECTED_SHA,
  PROOF,
  secretEquals,
} from "@/lib/domain/proof/s1s2-attended-proof.js";

const SECRET = "trigger-secret-value";
const GOOD_ENV = { S1S2_PROOF_ENABLED: "1", S1S2_PROOF_TRIGGER_SECRET: SECRET };
const GOOD_HEADERS = { "x-s1s2-proof-secret": SECRET };

// ── In-memory fake supabase covering the four tables the lib reads ────────────
function makeWorld(opts = {}) {
  const sys = new Map(Object.entries({ queue_execution_mode: "paused", ...(opts.sys || {}) }));
  const queue = [...(opts.queue || [])];
  const inbound = [];
  let seq = 1;
  let clock = opts.startMs ?? 1_000_000;
  const events = { sms: [], dispatched: [] };

  function table(name) {
    const f = [];
    let lim = null;
    const api = {
      select(_s, o) { api._head = Boolean(o?.head); return api; },
      eq(c, v) { f.push(["eq", c, v]); return api; },
      in(c, v) { f.push(["in", c, v]); return api; },
      gte(c, v) { f.push(["gte", c, v]); return api; },
      order() { return api; },
      limit(n) { lim = n; return api; },
      _rows() {
        let src;
        if (name === "system_control") src = [...sys.entries()].map(([key, value]) => ({ key, value }));
        else if (name === "send_queue") src = queue;
        else if (name === "message_events") src = inbound;
        else if (name === "seller_inbound_bursts") {
          src = inbound.length
            ? [{ id: "burst-1", thread_key: PROOF.handset, last_authorized_received_at: inbound[inbound.length - 1].received_at, created_at: inbound[inbound.length - 1].received_at }]
            : [];
        } else src = [];
        let rows = src.filter((r) => f.every(([op, c, v]) =>
          op === "in" ? v.includes(r[c]) : op === "gte" ? String(r[c] ?? "") >= String(v) : r[c] === v));
        if (lim) rows = rows.slice(0, lim);
        return rows;
      },
      async maybeSingle() { return { data: api._rows()[0] ?? null, error: null }; },
      then(resolve) { const rows = api._rows(); return resolve({ data: rows, error: null, count: rows.length }); },
    };
    return api;
  }
  const supabase = { from: table };
  const setSystemValues = async (patch) => { for (const [k, v] of Object.entries(patch)) sys.set(k, v); return { ok: true }; };
  function lastS1Id() { return queue.filter((r) => r.use_case_template === "ownership_check").slice(-1)[0]?.id ?? null; }

  const deps = {
    supabase, setSystemValues, operatorOpts: {},
    now: () => clock,
    mintNonce: opts.mintNonce,
    insertSendQueueRow: async (payload) => {
      const id = `q${seq++}`;
      queue.push({ id, ...payload, created_at: new Date(clock).toISOString(), provider_message_id: null });
      events.sms.push({ id, to: payload.to_phone_number, use_case: payload.use_case_template });
      return { ok: true, queue_row_id: id };
    },
    fetchQueueRow: async (id) => queue.find((r) => r.id === id) || null,
    dispatchQueueRow: async (row) => {
      if (opts.dispatchFails) return { ok: false, reason: "scoped_dispatch_rejected" };
      const r = queue.find((x) => x.id === row.id);
      if (r) { r.provider_message_id = `pv-${r.id}`; r.queue_status = "sent"; r.latest_delivery_status = "sent"; events.dispatched.push(r.id); }
      return { ok: true, provider_message_id: r?.provider_message_id };
    },
    classify: async (text) => (opts.classify ? opts.classify(text) : { primary_intent: "ownership_confirmed", confidence: 0.9 }),
    findRecentOutboundContextPair: async () => ({ context_source_id: opts.ctxOverride ?? lastS1Id() }),
  };

  return {
    deps, sys, events,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    addInbound: (body = "Yes I still own it", atMs = clock) => {
      inbound.push({ id: `evt-${seq++}`, thread_key: PROOF.handset, direction: "inbound", body, received_at: new Date(atMs).toISOString(), provider_message_id: `in-${seq}` });
    },
    seedS2: (atMs = clock, useCase = "offer_interest", n = 1) => {
      for (let i = 0; i < n; i++) queue.push({ id: `s2-${seq++}`, to_phone_number: PROOF.handset, use_case_template: useCase, created_at: new Date(atMs).toISOString(), provider_message_id: null });
    },
    getQueue: () => queue,
  };
}

// ── GATE: enable flag / secret / SHA ─────────────────────────────────────────
test("missing enable flag denies", () => {
  const g = evaluateProofGate({ env: { S1S2_PROOF_TRIGGER_SECRET: SECRET }, headers: GOOD_HEADERS, deployedSha: EXPECTED_SHA });
  assert.deepEqual([g.ok, g.reason], [false, "proof_disabled"]);
});
test("wrong secret denies (constant-time)", () => {
  const g = evaluateProofGate({ env: GOOD_ENV, headers: { "x-s1s2-proof-secret": "nope" }, deployedSha: EXPECTED_SHA });
  assert.deepEqual([g.ok, g.reason], [false, "invalid_trigger_secret"]);
  assert.equal(secretEquals("a", "ab"), false);
});
test("wrong SHA denies", () => {
  const g = evaluateProofGate({ env: GOOD_ENV, headers: GOOD_HEADERS, deployedSha: "deadbeef" });
  assert.deepEqual([g.ok, g.reason], [false, "sha_mismatch"]);
});
test("full gate passes only when all three hold", () => {
  assert.equal(evaluateProofGate({ env: GOOD_ENV, headers: GOOD_HEADERS, deployedSha: EXPECTED_SHA }).ok, true);
});

// ── RECIPIENT is code-pinned — impossible to specify arbitrary ────────────────
test("S1 always targets the code-pinned handset regardless of any input", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, true);
  assert.equal(w.events.sms.length, 1);
  assert.equal(w.events.sms[0].to, PROOF.handset);
});

// ── SECOND trigger attempt denied while active ────────────────────────────────
test("second arm while a proof is active is refused", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  assert.equal((await runArmAndS1(w.deps)).ok, true);
  const second = await runArmAndS1(w.deps);
  assert.deepEqual([second.ok, second.reason], [false, "proof_already_active"]);
});

// ── PRECONDITION: not-paused blocks + restores nothing armed ──────────────────
test("arm refuses when execution mode is not paused and leaves it untouched", async () => {
  const w = makeWorld({ sys: { queue_execution_mode: "normal" }, mintNonce: () => "n1" });
  const r = await runArmAndS1(w.deps);
  assert.deepEqual([r.ok, r.reason], [false, "precondition_failed"]);
  // Nothing was armed, so the operator's pre-existing mode is NOT clobbered.
  assert.equal(w.sys.get("queue_execution_mode"), "normal");
  assert.equal(w.events.sms.length, 0);
});

// ── FAILURE between S1 and S2 (dispatch rejected) restores containment ────────
test("S1 dispatch rejection restores paused + closes session", async () => {
  const w = makeWorld({ mintNonce: () => "n1", dispatchFails: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
  const session = JSON.parse(w.sys.get("internal_proof_session"));
  assert.ok(session.closed_at, "session closed on failure");
});

// ── HAPPY PATH arm → verify → one S2 → restore ────────────────────────────────
async function armOk(w) {
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, true, r.reason);
  assert.equal(w.sys.get("queue_execution_mode"), "scoped_canary_only");
  return r;
}
test("verify_and_s2 dispatches exactly one S2 then restores paused", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  assert.equal(v.s2_count, 1);
  assert.equal(v.final_queue_execution_mode, "paused");
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

// ── DUPLICATE S2 prevention ───────────────────────────────────────────────────
test("verify fails closed when more than one S2 exists", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound(); w.seedS2(w.now(), "offer_interest", 2);
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.deepEqual([v.ok, v.reason], [false, "verify_and_s2_failed"]);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

// ── NONCE: expired / reused / wrong ───────────────────────────────────────────
test("expired nonce is rejected", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(21 * 60 * 1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.deepEqual([v.ok, v.reason], [false, "nonce_expired"]);
});
test("reused nonce after completion is rejected", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound(); w.seedS2();
  assert.equal((await runVerifyAndS2(w.deps, { nonce: arm.nonce })).ok, true);
  const again = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.deepEqual([again.ok, again.reason], [false, "nonce_consumed"]);
});
test("wrong nonce is rejected", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  await armOk(w); w.advance(1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: "not-the-nonce" });
  assert.deepEqual([v.ok, v.reason], [false, "nonce_mismatch"]);
});

// ── ABANDONMENT + WATCHDOG ────────────────────────────────────────────────────
test("watchdog restores containment after expiry when operator abandons", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  await armOk(w);
  // operator never returns; time passes beyond expiry
  w.advance(21 * 60 * 1000);
  const wd = await runS1S2ProofWatchdog(w.deps);
  assert.equal(wd.acted, true);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
  const session = JSON.parse(w.sys.get("internal_proof_session"));
  assert.ok(session.closed_at);
});
test("watchdog is a no-op before expiry", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  await armOk(w);
  w.advance(60 * 1000);
  const wd = await runS1S2ProofWatchdog(w.deps);
  assert.equal(wd.acted, false);
  assert.equal(w.sys.get("queue_execution_mode"), "scoped_canary_only"); // still armed, not yet expired
});

// ── VERIFY guards: no inbound yet, wrong classification, wrong context ────────
test("verify returns too-early when no real inbound yet", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.deepEqual([v.ok, v.reason, v.status], [false, "no_real_inbound_yet", 425]);
});
test("verify fails closed on non-ownership classification (restores)", async () => {
  const w = makeWorld({ mintNonce: () => "n1", classify: () => ({ primary_intent: "not_interested", confidence: 0.9 }) });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("no thanks"); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});
test("verify fails closed when context binds to a non-S1 outbound (restores)", async () => {
  const w = makeWorld({ mintNonce: () => "n1", ctxOverride: "some-other-row" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});
