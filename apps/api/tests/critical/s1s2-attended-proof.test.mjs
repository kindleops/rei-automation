import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateProofGate,
  runArmAndS1,
  runVerifyAndS2,
  runAbort,
  runS1S2ProofWatchdog,
  restoreContainment,
  PROOF,
  secretEquals,
} from "@/lib/domain/proof/s1s2-attended-proof.js";

const SECRET = "trigger-secret-value";
// Deployment-supplied SHAs (never a module constant). SHA_A is the "current"
// validated deployment; SHA_B simulates a different deployment.
const SHA_A = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const SHA_B = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const GOOD_ENV = { S1S2_PROOF_ENABLED: "1", S1S2_PROOF_TRIGGER_SECRET: SECRET, S1S2_PROOF_EXPECTED_SHA: SHA_A };
const GOOD_HEADERS = { "x-s1s2-proof-secret": SECRET };

// ── In-memory fake supabase covering the four tables the lib reads ────────────
function makeWorld(opts = {}) {
  const sys = new Map(Object.entries({ queue_execution_mode: "paused", ...(opts.sys || {}) }));
  const queue = [...(opts.queue || [])];
  const inbound = [];
  let seq = 1;
  let clock = opts.startMs ?? 1_000_000;
  const events = {
    sms: [], dispatched: [],
    locks: { acquired: [], released: [], live: new Set() },
    auths: { created: [], consumed: [], open: new Set() },
  };

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
  // Optional injection: make send_queue count queries error or return null count.
  if (opts.countError || opts.nullCount) {
    const orig = table;
    // wrap `from` so send_queue head-count resolves to the injected shape
    var wrappedFrom = (name) => {
      const api = orig(name);
      if (name === "send_queue") {
        const origThen = api.then;
        api.then = (resolve) => {
          if (api._head) {
            return resolve(opts.countError ? { data: null, error: { message: "count boom" }, count: null } : { data: [], error: null, count: null });
          }
          return origThen(resolve);
        };
      }
      return api;
    };
  }
  const supabase = { from: (name) => (typeof wrappedFrom === "function" ? wrappedFrom(name) : table(name)) };
  const writeFails = opts.writeFails || (() => false); // (key) => boolean
  const setSystemValues = async (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      if (writeFails(k)) return { ok: false, error: { message: `write rejected: ${k}` } };
      sys.set(k, v);
    }
    return { ok: true, updated: Object.keys(patch).length };
  };
  function lastS1Id() { return queue.filter((r) => r.use_case_template === "ownership_check").slice(-1)[0]?.id ?? null; }

  const deps = {
    supabase, setSystemValues, operatorOpts: {},
    // The route validates runtime===S1S2_PROOF_EXPECTED_SHA and injects the
    // validated SHA; tests default to SHA_A and can override to simulate a
    // deployment change between phases.
    validatedSha: opts.validatedSha ?? SHA_A,
    now: () => clock,
    mintNonce: opts.mintNonce,
    insertSendQueueRow: async (payload) => {
      const id = `q${seq++}`;
      queue.push({ id, ...payload, created_at: new Date(clock).toISOString(), provider_message_id: null });
      events.sms.push({ id, to: payload.to_phone_number, use_case: payload.use_case_template });
      return { ok: true, queue_row_id: id };
    },
    fetchQueueRow: async (id) => queue.find((r) => r.id === id) || null,
    // Canonical scoped-canary ops injected (the lib uses these instead of the
    // real RPC helpers when provided). Tracked for release/close assertions.
    mintCanaryRunId: opts.mintCanaryRunId,
    mintAuthToken: opts.mintAuthToken,
    acquireLock: async (o) => {
      events.locks.acquired.push(o);
      if (opts.lockUnavailable) return { acquired: false, reason: "global_lock_held" };
      const token = `lock-${seq++}`;
      events.locks.live.add(token);
      return { acquired: true, token, owner_type: o.owner_type, canary_run_id: o.canary_run_id };
    },
    releaseLock: async (token) => { events.locks.released.push(token); if (events.locks.live.has(token)) { events.locks.live.delete(token); return true; } return false; },
    createAuthorization: async (o) => {
      events.auths.created.push(o);
      if (opts.authCreateFails) throw new Error("authorization_insert_failed");
      const id = `auth-${seq++}`;
      events.auths.open.add(id);
      return { id, canary_run_id: o.canary_run_id, campaign_id: o.campaign_id, queue_row_ids: o.queue_row_ids };
    },
    consumeAuthorization: async (id) => { events.auths.consumed.push(id); events.auths.open.delete(id); return { ok: true, authorization_id: id }; },
    // Claim path. Injections: dispatchFails (ok:false), dispatchSkipped
    // (ok:true,skipped — the live bug), dispatchNoProvider, dispatchNoSentAt.
    dispatchQueueRow: async (row, ctx = {}) => {
      events.dispatched.push({ id: row.id, ctx });
      if (opts.dispatchFails) return { ok: false, reason: "scoped_dispatch_rejected" };
      if (opts.dispatchSkipped) return { ok: true, skipped: true, reason: "scoped_canary_execution_lock_mismatch" };
      const r = queue.find((x) => x.id === row.id);
      if (r && !opts.dispatchNoProvider) { r.provider_message_id = `pv-${r.id}`; }
      if (r && !opts.dispatchNoSentAt) { r.sent_at = new Date(clock).toISOString(); r.queue_status = "sent"; r.latest_delivery_status = "sent"; }
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
    seedS2: (atMs = clock, useCase = "offer_interest", n = 1, campaignId = PROOF.campaign_id) => {
      for (let i = 0; i < n; i++) queue.push({ id: `s2-${seq++}`, to_phone_number: PROOF.handset, campaign_id: campaignId, use_case_template: useCase, created_at: new Date(atMs).toISOString(), provider_message_id: null });
    },
    getQueue: () => queue,
  };
}

// ── GATE: enable flag / secret / SHA ─────────────────────────────────────────
test("missing enable flag denies", () => {
  const g = evaluateProofGate({ env: { S1S2_PROOF_TRIGGER_SECRET: SECRET }, headers: GOOD_HEADERS, deployedSha: SHA_A });
  assert.deepEqual([g.ok, g.reason], [false, "proof_disabled"]);
});
test("wrong secret denies (constant-time)", () => {
  const g = evaluateProofGate({ env: GOOD_ENV, headers: { "x-s1s2-proof-secret": "nope" }, deployedSha: SHA_A });
  assert.deepEqual([g.ok, g.reason], [false, "invalid_trigger_secret"]);
  assert.equal(secretEquals("a", "ab"), false);
});
test("wrong SHA denies", () => {
  const g = evaluateProofGate({ env: GOOD_ENV, headers: GOOD_HEADERS, deployedSha: "deadbeef" });
  assert.deepEqual([g.ok, g.reason], [false, "sha_mismatch"]);
});
test("full gate passes only when all three hold", () => {
  assert.equal(evaluateProofGate({ env: GOOD_ENV, headers: GOOD_HEADERS, deployedSha: SHA_A }).ok, true);
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

// ── FINDING 1: S1 and S2 dispatch through the scoped-canary execution context ──
test("S1 and S2 both dispatch with scoped_canary:true (normal brakes untouched)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  // S1 dispatch carried the scoped-canary context.
  assert.equal(w.events.dispatched.length, 1);
  assert.equal(w.events.dispatched[0].ctx.scoped_canary, true);
  w.advance(1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  // S2 dispatch also carried it.
  assert.equal(w.events.dispatched.length, 2);
  assert.equal(w.events.dispatched[1].ctx.scoped_canary, true);
});

// ── FINDING 2: pre-arm read failure does not touch an unrelated mode ───────────
test("pre-arm authorization read failure leaves an unrelated execution mode alone", async () => {
  const w = makeWorld({ sys: { queue_execution_mode: "normal" }, mintNonce: () => "n1" });
  // Break the authorization read that runs before anything is armed.
  const realFrom = w.deps.supabase.from;
  w.deps.supabase.from = (name) => {
    if (name === "system_control") {
      const api = realFrom(name);
      const eq = api.eq;
      api.eq = (c, v) => { if (v === "s1s2_proof_authorization") { api.maybeSingle = async () => { throw new Error("read boom"); }; } return eq(c, v); };
      return api;
    }
    return realFrom(name);
  };
  const r = await runArmAndS1(w.deps);
  assert.deepEqual([r.ok, r.reason], [false, "authorization_read_failed"]);
  assert.equal(w.sys.get("queue_execution_mode"), "normal"); // NOT clobbered to paused
  assert.equal(w.events.sms.length, 0);
});
test("a failure AFTER arming still restores paused (ownership-aware)", async () => {
  const w = makeWorld({ mintNonce: () => "n1", dispatchFails: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

// ── FINDING 3: containment writes verify success; watchdog raises failure ──────
test("restoreContainment reports failure when the mode write is rejected", async () => {
  const w = makeWorld({ mintNonce: () => "n1", writeFails: (k) => k === "queue_execution_mode" });
  // Arm succeeds for session/auth but the mode write is rejected → arm fails and
  // the restore also cannot flip the mode: surface it, never silently "ok".
  const arm = await runArmAndS1(w.deps);
  assert.equal(arm.ok, false);
  // Directly assert the restore contract on a scoped_canary_only state.
  const w2 = makeWorld({ mintNonce: () => "n2" });
  await armOk(w2);
  w2.deps.setSystemValues = async () => ({ ok: false, error: { message: "rejected" } });
  const res = await restoreContainment(w2.deps, "test");
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes("mode_restore_write_rejected"));
});
test("watchdog returns ok:false when restore write is rejected (error signal)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  await armOk(w);
  w.advance(21 * 60 * 1000);
  w.deps.setSystemValues = async () => ({ ok: false, error: { message: "rejected" } });
  const wd = await runS1S2ProofWatchdog(w.deps);
  assert.equal(wd.acted, true);
  assert.equal(wd.ok, false); // the run-send-queue hook logs this at ERROR level
  assert.ok((wd.errors || []).length > 0);
});

// ── FINDING 4: pre-existing-row count query fails closed ──────────────────────
test("arm fails closed when the dispatchable-row count query errors", async () => {
  const w = makeWorld({ mintNonce: () => "n1", countError: true });
  const r = await runArmAndS1(w.deps);
  assert.deepEqual([r.ok, r.reason], [false, "precondition_failed"]);
  assert.equal(w.events.sms.length, 0);
});
test("arm fails closed when the dispatchable-row count is null/unavailable", async () => {
  const w = makeWorld({ mintNonce: () => "n1", nullCount: true });
  const r = await runArmAndS1(w.deps);
  assert.deepEqual([r.ok, r.reason], [false, "precondition_failed"]);
  assert.equal(w.events.sms.length, 0);
});

// ── FINDING 5: abort failure returns non-2xx + ok:false ───────────────────────
test("abort returns non-2xx and ok:false when restore fails", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  await armOk(w);
  w.deps.setSystemValues = async () => ({ ok: false, error: { message: "rejected" } });
  const res = await runAbort(w.deps);
  assert.equal(res.ok, false);
  assert.notEqual(res.status, 200);
  assert.ok(res.status >= 400);
});
test("abort returns 200 + ok:true on a clean restore", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  await armOk(w);
  const res = await runAbort(w.deps);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

// ── DEPLOYMENT-SUPPLIED SHA AUTHORITY (S1S2_PROOF_EXPECTED_SHA) ────────────────
test("expected SHA missing → deny (deny-by-default)", () => {
  const env = { S1S2_PROOF_ENABLED: "1", S1S2_PROOF_TRIGGER_SECRET: SECRET }; // no S1S2_PROOF_EXPECTED_SHA
  const g = evaluateProofGate({ env, headers: GOOD_HEADERS, deployedSha: SHA_A });
  assert.deepEqual([g.ok, g.reason], [false, "expected_sha_not_configured"]);
});
test("expected SHA present but runtime mismatch → deny", () => {
  const g = evaluateProofGate({ env: GOOD_ENV, headers: GOOD_HEADERS, deployedSha: SHA_B });
  assert.deepEqual([g.ok, g.reason], [false, "sha_mismatch"]);
});
test("runtime SHA null while expected present → deny (never open)", () => {
  const g = evaluateProofGate({ env: GOOD_ENV, headers: GOOD_HEADERS, deployedSha: null });
  assert.deepEqual([g.ok, g.reason], [false, "sha_mismatch"]);
});
test("expected SHA exact match → allow and returns the validated SHA", () => {
  const g = evaluateProofGate({ env: GOOD_ENV, headers: GOOD_HEADERS, deployedSha: SHA_A });
  assert.equal(g.ok, true);
  assert.equal(g.deployed_sha, SHA_A); // callers pin to THIS, not a module constant
});
test("authorization + session stamp the validated deployed SHA (not a constant)", async () => {
  const w = makeWorld({ mintNonce: () => "n1", validatedSha: SHA_A });
  const arm = await armOk(w);
  assert.equal(arm.ok, true);
  const session = JSON.parse(w.sys.get("internal_proof_session"));
  const auth = JSON.parse(w.sys.get("s1s2_proof_authorization"));
  assert.equal(session.production_sha, SHA_A);
  assert.equal(auth.pinned_sha, SHA_A);
});
test("arm fails closed if the validated SHA was not injected", async () => {
  const w = makeWorld({ mintNonce: () => "n1", validatedSha: "" });
  w.deps.validatedSha = ""; // simulate a caller that skipped the gate
  const r = await runArmAndS1(w.deps);
  assert.deepEqual([r.ok, r.reason], [false, "validated_sha_missing"]);
  assert.equal(w.events.sms.length, 0);
});
test("second phase on a DIFFERENT deployment SHA → deny (deployment_changed)", async () => {
  const w = makeWorld({ mintNonce: () => "n1", validatedSha: SHA_A });
  const arm = await armOk(w);          // armed & pinned to SHA_A
  w.advance(1000); w.addInbound(); w.seedS2();
  w.deps.validatedSha = SHA_B;          // deployment changed between phases
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.deepEqual([v.ok, v.reason], [false, "deployment_changed"]);
});
test("second phase on the SAME validated SHA still succeeds", async () => {
  const w = makeWorld({ mintNonce: () => "n1", validatedSha: SHA_A });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
});

// ── SCOPED-CANARY AUTHORITY FIX (root cause of the live S1 failure) ────────────
test("missing scoped-canary registration → skipped claim reproduces the incident and FAILS closed", async () => {
  // dispatchSkipped simulates the live {ok:true,skipped:true,scoped_canary_execution_lock_mismatch}.
  const w = makeWorld({ mintNonce: () => "n1", dispatchSkipped: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);                          // NO phantom success
  assert.match(r.reason, /arm_and_s1_failed/);
  assert.match(String(r.detail), /s1_dispatch_unconfirmed/);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");  // containment restored
});
test("correct lock + authorization + canary_run_id → S1 claim succeeds", async () => {
  const w = makeWorld({ mintNonce: () => "n1", mintCanaryRunId: () => "run-1", mintAuthToken: () => "tok-1" });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, true, r.detail);
  assert.ok(r.s1_provider_id);
  assert.equal(w.events.locks.acquired[0].owner_type, "scoped_canary");
  assert.equal(w.events.locks.acquired[0].canary_run_id, "run-1");
  assert.equal(w.events.auths.created[0].campaign_id, PROOF.campaign_id);
});
test("full scoped-canary context reaches the S1 dispatch/claim", async () => {
  const w = makeWorld({ mintNonce: () => "n1", mintCanaryRunId: () => "run-1", mintAuthToken: () => "tok-1" });
  await armOk(w);
  const ctx = w.events.dispatched[0].ctx;
  assert.equal(ctx.scoped_canary, true);
  assert.equal(ctx.canary_run_id, "run-1");
  assert.equal(ctx.authorization_token, "tok-1");
  assert.equal(ctx.campaign_id, PROOF.campaign_id);
});
test("full scoped-canary context reaches the S2 dispatch/claim", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  const s2ctx = w.events.dispatched[1].ctx; // [0]=S1, [1]=S2
  assert.equal(s2ctx.scoped_canary, true);
  assert.ok(s2ctx.canary_run_id);
  assert.ok(s2ctx.authorization_token);
  assert.equal(s2ctx.campaign_id, PROOF.campaign_id);
});
test("{ok:true, skipped:true} is never a successful send", async () => {
  const w = makeWorld({ mintNonce: () => "n1", dispatchSkipped: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);
  assert.equal(w.events.sms.length, 1);               // row enqueued
  assert.equal((w.getQueue().find((x) => x.provider_message_id)) , undefined); // nothing "sent"
});
test("{ok:true} but missing provider id → FAIL closed", async () => {
  const w = makeWorld({ mintNonce: () => "n1", dispatchNoProvider: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);
  assert.match(String(r.detail), /s1_dispatch_unconfirmed/);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});
test("provider id present but missing sent_at → FAIL closed", async () => {
  const w = makeWorld({ mintNonce: () => "n1", dispatchNoSentAt: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);
  assert.match(String(r.detail), /s1_dispatch_unconfirmed/);
});
test("lock released + authorization consumed on successful S1", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  await armOk(w);
  assert.equal(w.events.locks.live.size, 0, "no lock left held");
  assert.equal(w.events.auths.open.size, 0, "no authorization left open");
  assert.equal(w.events.locks.released.length, 1);
  assert.equal(w.events.auths.consumed.length, 1);
});
test("lock released on S1 dispatch failure", async () => {
  const w = makeWorld({ mintNonce: () => "n1", dispatchSkipped: true });
  await runArmAndS1(w.deps);
  assert.equal(w.events.locks.live.size, 0, "lock released even though dispatch failed");
  assert.equal(w.events.auths.open.size, 0, "authorization closed on failure");
});
test("lock released on S2 dispatch failure", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  assert.equal(w.events.locks.live.size, 0); // S1 released
  // Make the S2 dispatch skip.
  w.deps.__opts_dispatchSkipped = true; // not used; re-create with skip via a fresh dispatch override:
  const origDispatch = w.deps.dispatchQueueRow;
  w.deps.dispatchQueueRow = async (row, ctx) => { w.events.dispatched.push({ id: row.id, ctx }); return { ok: true, skipped: true, reason: "x" }; };
  w.advance(1000); w.addInbound(); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(w.events.locks.live.size, 0, "S2 lock released on failure");
  assert.equal(w.events.auths.open.size, 0, "S2 authorization closed on failure");
  w.deps.dispatchQueueRow = origDispatch;
});
test("restoreContainment releases a recorded proof lock + closes its authorization (watchdog path)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  // Simulate a proof authorization row with an in-flight lock/auth recorded.
  w.sys.set("s1s2_proof_authorization", JSON.stringify({
    nonce: "n1", phase: "s1_sent", expires_at: new Date(w.now() + 60000).toISOString(),
    execution_lock_token: "held-token", canary_authorization_id: "held-auth",
  }));
  w.events.locks.live.add("held-token"); w.events.auths.open.add("held-auth");
  w.sys.set("queue_execution_mode", "scoped_canary_only");
  const res = await restoreContainment(w.deps, "watchdog_expiry");
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(w.events.locks.released.includes("held-token"), true);
  assert.equal(w.events.auths.consumed.includes("held-auth"), true);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});
test("this proof cannot release another run's lock (token-scoped)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  // Another operator/canary run holds a lock with a DIFFERENT token.
  w.events.locks.live.add("someone-elses-token");
  w.sys.set("s1s2_proof_authorization", JSON.stringify({
    nonce: "n1", phase: "s1_sent", expires_at: new Date(w.now() + 60000).toISOString(),
    execution_lock_token: "our-token", canary_authorization_id: null,
  }));
  w.sys.set("queue_execution_mode", "scoped_canary_only");
  await restoreContainment(w.deps, "test");
  // We only asked to release OUR token; the release fake no-ops on a token it
  // does not own, so the other run's lock is untouched.
  assert.equal(w.events.locks.live.has("someone-elses-token"), true, "other run's lock preserved");
  assert.equal(w.events.locks.released.includes("our-token"), true);
});
test("scoped-canary lock unavailable → S1 fails closed, containment restored", async () => {
  const w = makeWorld({ mintNonce: () => "n1", lockUnavailable: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);
  assert.match(String(r.detail), /scoped_canary_lock_unavailable/);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
  assert.equal(w.events.sms.length, 1); // row enqueued but never sent
});
test("duplicate-S2 protection remains intact after the fix", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound(); w.seedS2(w.now(), "offer_interest", 2); // two S2 rows
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.match(String(v.reason), /verify_and_s2_failed/);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});
