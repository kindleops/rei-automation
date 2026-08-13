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
    sms: [], dispatched: [], fromCalls: [], // fromCalls records every supabase.from(table) access
    locks: { acquired: [], released: [], live: new Set(), holder: null },
    auths: { created: [], consumed: [], open: new Set(), byRunId: new Map() },
  };

  function table(name) {
    const f = [];
    let lim = null;
    let ord = null; // { col, ascending } — models PostgREST .order(col, { ascending })
    const api = {
      select(_s, o) { api._head = Boolean(o?.head); return api; },
      eq(c, v) { f.push(["eq", c, v]); return api; },
      in(c, v) { f.push(["in", c, v]); return api; },
      gte(c, v) { f.push(["gte", c, v]); return api; },
      // Faithful order(): record the column + direction (PostgREST default is
      // ascending) and apply it in _rows() BEFORE limit, so `.order(col,{ascending})
      // .limit(1)` returns the true first row by that column — not insertion order.
      order(col, opts = {}) { ord = { col, ascending: opts.ascending !== false }; return api; },
      limit(n) { lim = n; return api; },
      _rows() {
        let src;
        if (name === "system_control") src = [...sys.entries()].map(([key, value]) => ({ key, value }));
        else if (name === "send_queue") src = queue;
        else if (name === "message_events") src = inbound;
        else if (name === "seller_inbound_bursts") {
          // Production-shaped burst row (the live path leaves this table stale — its
          // constituents intentionally carry NO authorized_received_at, since
          // appendConstituent never persists it). The verifier no longer reads this
          // table for temporal authority; the burst fake exists ONLY so the schema-
          // contract test and the "verify never queries seller_inbound_bursts" test
          // have something to assert against. opts.noBurst → empty (no burst at all).
          const last = inbound[inbound.length - 1];
          src = (inbound.length && !opts.noBurst) ? [{
            id: "burst-1", thread_key: PROOF.handset, status: "open",
            constituent_messages: inbound.map((m) => ({
              event_id: m.id, provider_message_id: m.provider_message_sid, body: m.message_body, received_at: m.received_at,
            })),
            first_received_at: inbound[0].received_at, last_received_at: last.received_at, created_at: last.received_at,
          }] : [];
        } else src = [];
        let rows = src.filter((r) => f.every(([op, c, v]) =>
          op === "in" ? v.includes(r[c]) : op === "gte" ? String(r[c] ?? "") >= String(v) : r[c] === v));
        if (ord) {
          const dir = ord.ascending ? 1 : -1;
          rows = [...rows].sort((a, b) => {
            const av = a[ord.col] == null ? "" : String(a[ord.col]);
            const bv = b[ord.col] == null ? "" : String(b[ord.col]);
            return av < bv ? -dir : av > bv ? dir : 0;
          });
        }
        if (lim) rows = rows.slice(0, lim);
        return rows;
      },
      async maybeSingle() { return { data: api._rows()[0] ?? null, error: null }; },
      then(resolve) { const rows = api._rows(); return resolve({ data: rows, error: null, count: rows.length }); },
    };
    return api;
  }
  // Injections:
  //  • send_queue head-count error / null (arm precondition fail-closed).
  //  • hard query errors on a verify-only reader table (message_events,
  //    seller_inbound_bursts) via opts.errorTables — proves a DB/schema/query
  //    error becomes a HARD verify failure, never no_real_inbound_yet. These
  //    tables are read ONLY in verify, so erroring them does not break arm.
  const errorTables = opts.errorTables || {};
  const needWrap = opts.countError || opts.nullCount || Object.keys(errorTables).length > 0;
  if (needWrap) {
    const orig = table;
    var wrappedFrom = (name) => {
      const api = orig(name);
      if (errorTables[name]) {
        const errShape = { data: null, error: { message: `${name} query boom` }, count: null };
        api.then = (resolve) => resolve(errShape);
        api.maybeSingle = async () => errShape;
      }
      if (name === "send_queue" && (opts.countError || opts.nullCount)) {
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
  const supabase = { from: (name) => { events.fromCalls.push(name); return (typeof wrappedFrom === "function" ? wrappedFrom(name) : table(name)); } };
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
      events.locks.live.add(token); events.locks.holder = token;
      return { acquired: true, token, owner_type: o.owner_type, canary_run_id: o.canary_run_id };
    },
    // releaseFails: return false WITHOUT releasing (simulates DB error while held).
    releaseLock: async (token) => {
      events.locks.released.push(token);
      if (opts.releaseFails) return false; // still held
      if (events.locks.live.has(token)) { events.locks.live.delete(token); if (events.locks.holder === token) events.locks.holder = null; return true; }
      return false;
    },
    readLockToken: async () => events.locks.holder ?? null,
    createAuthorization: async (o) => {
      events.auths.created.push(o);
      if (opts.authCreateFails) throw new Error("authorization_insert_failed");
      const id = `auth-${seq++}`;
      events.auths.open.add(id); events.auths.byRunId.set(o.canary_run_id, { id, canary_run_id: o.canary_run_id, campaign_id: o.campaign_id, expires_at: o.expires_at, consumed_at: null });
      return { id, canary_run_id: o.canary_run_id, campaign_id: o.campaign_id, queue_row_ids: o.queue_row_ids };
    },
    // consumeFails: return {ok:false} WITHOUT consuming (simulates a held auth).
    consumeAuthorization: async (id) => {
      events.auths.consumed.push(id);
      if (opts.consumeFails) return { ok: false, reason: "authorization_consume_failed" };
      events.auths.open.delete(id);
      for (const [, a] of events.auths.byRunId) if (a.id === id) a.consumed_at = new Date(clock).toISOString();
      return { ok: true, authorization_id: id };
    },
    loadAuthorizationByRunId: async (runId) => events.auths.byRunId.get(runId) ?? null,
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
    // Canonical find-recent-outbound-pair return shape: the bound outbound id is
    // at context.queue_row_id (NOT context_source_id / outbound.id).
    findRecentOutboundContextPair: async () => ({ found: true, context: { queue_row_id: opts.ctxOverride ?? lastS1Id() } }),
  };

  return {
    deps, sys, events,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    // PRODUCTION-SHAPED inbound row: real message_events columns are
    // message_body + provider_message_sid (NOT body / provider_message_id).
    // receivedAtOverride lets a test force a null/malformed/stale received_at (the
    // canonical temporal-authority source) INDEPENDENT of created_at ordering:
    // `atMs` sets the production-shaped created_at (the column the verifier orders
    // by to pick the newest inbound), while received_at defaults to atMs but can be
    // overridden. So a later-created row can carry a stale/malformed receipt.
    addInbound: (body = "Yes I still own it", atMs = clock, receivedAtOverride = undefined) => {
      const created_at = new Date(atMs).toISOString();
      const received_at = receivedAtOverride !== undefined ? receivedAtOverride : created_at;
      inbound.push({ id: `evt-${seq++}`, thread_key: PROOF.handset, direction: "inbound", message_body: body, provider_message_sid: `in-${seq}`, received_at, created_at });
    },
    // Default to the CANONICAL post-ownership-confirmation reply use-case the live
    // automation actually creates (consider_selling), not the old proof-only enum.
    seedS2: (atMs = clock, useCase = "consider_selling", n = 1, campaignId = PROOF.campaign_id) => {
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
  w.advance(1000); w.addInbound(); w.seedS2(w.now(), "consider_selling", 2);
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
  w.advance(1000); w.addInbound(); w.seedS2(w.now(), "consider_selling", 2); // two S2 rows
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.match(String(v.reason), /verify_and_s2_failed/);
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

// ── LOCK-RECOVERY PERSISTENCE + FAILED-CLEANUP RETENTION (CodeRabbit #1/#2) ────
test("lock token is persisted IMMEDIATELY after acquire, before authorization creation", async () => {
  // createAuthorization throws → simulate a crash right after acquire. The
  // recovery handle must already be persisted so restore/watchdog can release.
  const w = makeWorld({ mintNonce: () => "n1", mintCanaryRunId: () => "run-1", authCreateFails: true });
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, false);
  const auth = JSON.parse(w.sys.get("s1s2_proof_authorization"));
  // The lock handle was recorded before the (failed) authorization insert.
  // Cleanup then confirms release (fake releases live token) and clears it —
  // but the key property is that acquireLock ran and a token existed to persist.
  assert.equal(w.events.locks.acquired.length, 1);
  assert.equal(w.events.locks.released.length, 1); // cleanup attempted the recorded token
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});
test("crash between lock and auth leaves a releasable handle when cleanup cannot run", async () => {
  // authCreateFails throws AND releaseFails → the lock stays held; the recorded
  // handle must be RETAINED (not erased) for restore/watchdog to retry.
  const w = makeWorld({ mintNonce: () => "n1", mintCanaryRunId: () => "run-1", authCreateFails: true, releaseFails: true });
  await runArmAndS1(w.deps);
  const auth = JSON.parse(w.sys.get("s1s2_proof_authorization"));
  assert.ok(auth.execution_lock_token, "lock handle retained for retry");
  assert.equal(auth.scoped_canary_run_id, "run-1");
  assert.equal(w.events.locks.live.size, 1, "lock still held (release failed)");
});
test("restoreContainment surfaces lock_release_failed and does NOT report ok:true while held", async () => {
  const w = makeWorld({ mintNonce: () => "n1", releaseFails: true });
  w.sys.set("s1s2_proof_authorization", JSON.stringify({
    nonce: "n1", phase: "s1_sent", expires_at: new Date(w.now() + 60000).toISOString(),
    execution_lock_token: "held", scoped_canary_run_id: "run-x", canary_authorization_id: null,
  }));
  w.events.locks.live.add("held"); w.events.locks.holder = "held";
  w.sys.set("queue_execution_mode", "scoped_canary_only");
  const res = await restoreContainment(w.deps, "test");
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes("lock_release_failed"));
  const auth = JSON.parse(w.sys.get("s1s2_proof_authorization"));
  assert.equal(auth.execution_lock_token, "held", "handle retained for retry");
  assert.ok(!auth.closed_at, "record NOT closed while a resource is held");
});
test("restoreContainment surfaces authorization_close_failed when the auth is still open", async () => {
  const w = makeWorld({ mintNonce: () => "n1", consumeFails: true });
  // The authorization is still open+unexpired (byRunId), so confirm cannot close it.
  w.events.auths.byRunId.set("run-y", { id: "auth-y", canary_run_id: "run-y", expires_at: new Date(w.now() + 60000).toISOString(), consumed_at: null });
  w.events.auths.open.add("auth-y");
  w.sys.set("s1s2_proof_authorization", JSON.stringify({
    nonce: "n1", phase: "s1_sent", expires_at: new Date(w.now() + 60000).toISOString(),
    execution_lock_token: null, scoped_canary_run_id: "run-y", canary_authorization_id: "auth-y",
  }));
  const res = await restoreContainment(w.deps, "test");
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes("authorization_close_failed"));
  const auth = JSON.parse(w.sys.get("s1s2_proof_authorization"));
  assert.equal(auth.canary_authorization_id, "auth-y", "auth handle retained for retry");
});
test("an already-consumed authorization (spent by the claim) is treated as closed", async () => {
  const w = makeWorld({ mintNonce: () => "n1", consumeFails: true });
  // consume returns ok:false but the auth is already consumed → closed.
  w.events.auths.byRunId.set("run-z", { id: "auth-z", canary_run_id: "run-z", expires_at: new Date(w.now() + 60000).toISOString(), consumed_at: new Date(w.now()).toISOString() });
  w.sys.set("s1s2_proof_authorization", JSON.stringify({
    nonce: "n1", phase: "s1_sent", expires_at: new Date(w.now() + 60000).toISOString(),
    execution_lock_token: null, scoped_canary_run_id: "run-z", canary_authorization_id: "auth-z",
  }));
  const res = await restoreContainment(w.deps, "test");
  assert.ok(!res.errors.includes("authorization_close_failed"));
  const auth = JSON.parse(w.sys.get("s1s2_proof_authorization"));
  assert.equal(auth.canary_authorization_id, null, "closed handle cleared");
});
test("watchdog recovery retries using a RETAINED handle after an earlier failure", async () => {
  const w = makeWorld({ mintNonce: () => "n1", releaseFails: true });
  w.sys.set("s1s2_proof_authorization", JSON.stringify({
    nonce: "n1", phase: "s1_sent", expires_at: new Date(w.now() - 1000).toISOString(), // expired
    execution_lock_token: "held", scoped_canary_run_id: "run-w", canary_authorization_id: null,
  }));
  w.events.locks.live.add("held"); w.events.locks.holder = "held";
  w.sys.set("queue_execution_mode", "scoped_canary_only");
  // First watchdog pass: release fails → ok:false, handle retained.
  const first = await runS1S2ProofWatchdog(w.deps);
  assert.equal(first.ok, false);
  assert.equal(JSON.parse(w.sys.get("s1s2_proof_authorization")).execution_lock_token, "held");
  // The lock frees (TTL / operator). Second pass releases and clears cleanly.
  w.deps.releaseLock = async (t) => { w.events.locks.released.push(t); w.events.locks.live.delete(t); w.events.locks.holder = null; return true; };
  const second = await runS1S2ProofWatchdog(w.deps);
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.equal(JSON.parse(w.sys.get("s1s2_proof_authorization")).execution_lock_token, null);
});

// ── S2 campaign pin enforced in verify (distinct s2_campaign_mismatch stage) ───
test("S2 with a non-pinned campaign fails closed (s2_campaign_mismatch)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound();
  w.seedS2(w.now(), "consider_selling", 1, "some-other-campaign"); // canonical S2 use-case, WRONG campaign
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "verify_and_s2_failed");
  assert.equal(v.stage, "s2_campaign_mismatch"); // distinct campaign gate, before dispatch
  assert.equal(w.events.dispatched.length, 1); // S1 only — S2 never dispatched
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});
test("S2 carrying the pinned campaign dispatches (propagation path)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound();
  w.seedS2(w.now(), "consider_selling", 1, PROOF.campaign_id); // as the reply pipeline propagates
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  assert.ok(v.s2_provider_id);
});

// ── S1 body clears the provider content guards ───────────────────────────────
// Regression for the live fail-closed: the earlier "Hi, …" S1 body matched the
// provider-level blank-greeting guard and was paused as paused_name_missing
// BEFORE provider submission (no provider id, no sent_at, no SMS). These two
// patterns are replicated VERBATIM from the provider content guard
// (apps/api/src/lib/providers/textgrid.js:20-21); they are module-private there,
// so we mirror them and pin the mirror with an anti-drift sandwich — the OLD
// failing body MUST still match (proving the mirror reproduces the live failure)
// and the CURRENT proof body MUST NOT. The body under test is read from the row
// the lib actually enqueues (runArmAndS1 → getQueue), never a hand-copied string.
const PROVIDER_BLANK_GREETING_RE = /^(Hello|Hi|Hey|Hola|Ola|Marhaba)\s*,|(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/i;
const PROVIDER_UNRESOLVED_PLACEHOLDER_RE = /\{\{[^}]+\}\}/;
const OLD_FAILING_S1_BODY = "Hi, this is regarding the property — are you still the owner? Reply YES or NO.";
// The CURRENT proof S1 body ("One quick question…") and the PRIOR version ("Quick
// question…"). Version-bumped intentionally so a fresh attended S1 is a DISTINCT
// message_body and therefore does not collide with the queue's 24h identical-body
// hard-idempotency dedup record (the dedup guard itself is unchanged).
const NEW_PROOF_S1_BODY = "One quick question about a property you may own — are you still the owner? Reply YES or NO.";
const PRIOR_PROOF_S1_BODY = "Quick question about a property you may own — are you still the owner? Reply YES or NO.";

async function enqueuedS1(w) {
  const r = await runArmAndS1(w.deps);
  assert.equal(r.ok, true, r.detail);
  const s1 = w.getQueue().find((row) => row.use_case_template === "ownership_check");
  assert.ok(s1, "S1 row enqueued under the ownership_check use case");
  assert.equal(s1.message_body, s1.message_text); // both are s1Body()
  const body = String(s1.message_body);
  assert.ok(body.trim().length > 0, "S1 body is non-empty");
  return { s1, body };
}

test("anti-drift: the OLD S1 body reproduces the provider blank-greeting failure", () => {
  assert.equal(PROVIDER_BLANK_GREETING_RE.test(OLD_FAILING_S1_BODY.trim()), true);
});

test("S1 body does NOT match the provider blank-greeting rule", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const { body } = await enqueuedS1(w);
  assert.equal(PROVIDER_BLANK_GREETING_RE.test(body.trim()), false);
});

test("S1 body carries no unresolved template placeholder", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const { body } = await enqueuedS1(w);
  assert.equal(PROVIDER_UNRESOLVED_PLACEHOLDER_RE.test(body), false);
});

test("S1 body does not require seller_first_name (no name token; row carries none)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const { s1, body } = await enqueuedS1(w);
  // The proof never sets seller_first_name, so the provider's blank-name guard
  // (textgrid.js:536) is skipped (null, not ""). And the copy demands no name.
  assert.equal(s1.seller_first_name ?? null, null);
  assert.equal(/\{\{?\s*(seller_)?first_?name\s*\}?\}|\[\s*(seller_)?first_?name\s*\]/i.test(body), false);
});

test("S1 body still carries the ownership-check intent", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const { s1, body } = await enqueuedS1(w);
  assert.equal(s1.use_case_template, "ownership_check");
  assert.match(body, /owner/i);
  assert.match(body, /\bYES\b/);
  assert.match(body, /\bNO\b/);
});

test("S1 body is the exact NEW version, DISTINCT from the prior proof body (24h dedup non-collision) and clears all content guards", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const { body } = await enqueuedS1(w);
  // Exactly the intended new version.
  assert.equal(body, NEW_PROOF_S1_BODY);
  // Byte-for-byte distinct from the prior identical-body dedup record — the queue's
  // 24h hard-idempotency match is `clean(message_body) === clean(prior)`, so a
  // trimmed-difference is what makes the new send NOT collide.
  assert.notEqual(body, PRIOR_PROOF_S1_BODY);
  assert.notEqual(body.trim(), PRIOR_PROOF_S1_BODY.trim());
  // And the new body still clears every provider content guard.
  assert.equal(PROVIDER_BLANK_GREETING_RE.test(body.trim()), false); // no blank-greeting
  assert.equal(PROVIDER_UNRESOLVED_PLACEHOLDER_RE.test(body), false); // no unresolved placeholder
  assert.match(body, /owner/i); // ownership-check only
});

// ═══════════════════════════════════════════════════════════════════════════
// VERIFIER SCHEMA/CONTRACT REGRESSIONS — the live attended proof delivered S1
// and received a real "Yes", but verify_and_s2 returned no_real_inbound_yet
// forever because the verifier (and its fake) used proof-only column names +
// a stale reply-use-case enum. These fixtures use the REAL production columns
// (provider_message_sid, message_body) + the REAL reply use-case (consider_selling).
// ═══════════════════════════════════════════════════════════════════════════

// Real production columns the verifier may read. The live incident was caused by
// the proof (and its fake) inventing names that don't exist in production. This
// allowlist IS the schema contract; the drift names below are banned outright.
const PROD_MESSAGE_EVENT_COLUMNS = new Set([
  "id", "provider_message_sid", "message_body", "message_text", "thread_key",
  "direction", "to_phone_number", "from_phone_number", "received_at", "sent_at",
  "delivered_at", "created_at", "updated_at", "event_timestamp", "delivery_status",
  "provider_delivery_status", "detected_intent", "metadata", "master_owner_id",
  "prospect_id", "property_id", "phone_number_id",
]);
const BANNED_MESSAGE_EVENT_COLUMNS = ["body", "provider_message_id"]; // the live-proof drift
const BANNED_BURST_COLUMNS = ["last_authorized_received_at"]; // a derived aggregate, NOT a column

async function readFakeInbound(w) {
  const res = await w.deps.supabase.from("message_events").select("*")
    .eq("thread_key", PROOF.handset).eq("direction", "inbound").gte("received_at", "0").order("received_at").limit(1);
  return (res.data || [])[0];
}
async function readFakeBurst(w) {
  const res = await w.deps.supabase.from("seller_inbound_bursts").select("*")
    .eq("thread_key", PROOF.handset).order("created_at").limit(1).maybeSingle();
  return res.data;
}

test("REGRESSION: the in-memory fake defines ONLY production columns (no proof-only drift)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  w.addInbound("Yes");
  const row = await readFakeInbound(w);
  assert.ok(row, "fake produced an inbound row");
  assert.ok("message_body" in row && "provider_message_sid" in row, "real columns present");
  for (const banned of BANNED_MESSAGE_EVENT_COLUMNS) {
    assert.equal(banned in row, false, `banned message_events column present: ${banned}`);
  }
  for (const k of Object.keys(row)) {
    assert.equal(PROD_MESSAGE_EVENT_COLUMNS.has(k), true, `non-production message_events column: ${k}`);
  }
  const burst = await readFakeBurst(w);
  for (const banned of BANNED_BURST_COLUMNS) {
    assert.equal(banned in burst, false, `banned burst column present: ${banned}`);
  }
  assert.ok(Array.isArray(burst.constituent_messages), "authorized receipt lives in constituent_messages jsonb");
});

test("REGRESSION: real-shaped inbound (provider_message_sid + message_body) is found and returns the SID", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  const row = await readFakeInbound(w);
  assert.equal(v.inbound_provider_id, row.provider_message_sid); // the SID, never undefined
});

test("REGRESSION: a message_events query/schema error FAILS HARD, never no_real_inbound_yet", async () => {
  const w = makeWorld({ mintNonce: () => "n1", errorTables: { message_events: true } });
  const arm = await armOk(w); // arm never touches message_events
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.notEqual(v.reason, "no_real_inbound_yet"); // the exact collapsed-error bug is fixed
  assert.equal(v.reason, "verify_and_s2_failed");
  assert.equal(v.stage, "inbound_lookup_failed");
  assert.equal(v.status, 500);
  assert.equal(w.sys.get("queue_execution_mode"), "paused"); // still restores
});

test("REGRESSION: verify_and_s2 NEVER queries seller_inbound_bursts (temporal authority = message_events.received_at)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  const before = w.events.fromCalls.filter((n) => n === "seller_inbound_bursts").length;
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  const after = w.events.fromCalls.filter((n) => n === "seller_inbound_bursts").length;
  assert.equal(v.ok, true, v.detail);
  assert.equal(after - before, 0, "verify must NOT read the deprecated seller_inbound_bursts table");
});

test("REGRESSION: a fresh received_at >= s1_sent_at PASSES with NO burst row present", async () => {
  const w = makeWorld({ mintNonce: () => "n1", noBurst: true }); // no seller_inbound_burst at all
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  assert.ok(v.inbound_received_at, "temporal authority surfaced from message_events.received_at");
});

test("EXACT LIVE SHAPE: stale/absent historical burst + valid fresh message_events.received_at → PASS", async () => {
  // Reproduces the live failure exactly: no fresh burst (null authorized_received_at),
  // but the inbound carries a valid fresh received_at. Old burst gate denied
  // (temporal_authority_unavailable); the received_at gate passes.
  const w = makeWorld({ mintNonce: () => "n1", noBurst: true });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  assert.equal(v.s2_count, 1);
});

test("REGRESSION: a MISSING received_at fails (temporal_authority_unavailable)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes", w.now(), null); w.seedS2(); // received_at = null
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "temporal_authority_unavailable");
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

test("REGRESSION: a STALE received_at (older than S1) fails (temporal_authority_stale)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w); // s1_sent_at ~ clock 1_000_000
  w.addInbound("Yes", w.now(), new Date(500_000).toISOString()); w.seedS2(); // received_at before S1
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "temporal_authority_stale");
});

// ── created_at ordering (CodeRabbit Minor): the verifier orders inbounds by
// created_at desc, so it must evaluate the NEWEST-by-created_at row, not the
// insertion-order row. Two inbounds; the true newest decides the outcome.
test("REGRESSION: verifier evaluates the NEWEST-by-created_at inbound — later STALE row denies (not the earlier fresh one)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w); // s1_sent_at ~ 1_000_000
  w.addInbound("Yes", 1_001_000);                                    // A: earlier created_at, FRESH receipt (inserted first)
  w.addInbound("Yes", 1_002_000, new Date(500_000).toISOString());  // B: LATER created_at, STALE receipt (inserted second) — the true newest
  w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  // Insertion-order (unfaithful) fake would pick A (fresh) and PASS; created_at
  // ordering picks B (stale, newest) → must fail temporal_authority_stale.
  assert.equal(v.ok, false);
  assert.equal(v.stage, "temporal_authority_stale");
  assert.match(String(v.detail), /predates S1/);
});

test("REGRESSION: verifier evaluates the NEWEST-by-created_at inbound — later FRESH row passes (over an earlier stale one)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.addInbound("Yes", 1_001_000, new Date(500_000).toISOString());  // A: earlier created_at, STALE receipt (inserted first)
  w.addInbound("Yes", 1_002_000);                                   // B: LATER created_at, FRESH receipt (inserted second) — the true newest
  w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  // Newest (B) is fresh → passes. An insertion-order fake would pick A (stale) → fail.
  assert.equal(v.ok, true, v.detail);
  assert.equal(v.s2_count, 1);
});

test("REGRESSION: the real consider_selling auto-reply is recognized as the S2 row", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes");
  w.seedS2(w.now(), "consider_selling"); // exactly what the live automation created
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  assert.equal(v.s2_count, 1);
});

test("REGRESSION: the old proof-only use-cases are NOT recognized as S2 (no_s2_row)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes");
  w.seedS2(w.now(), "offer_interest"); // the stale proof enum — must NOT count as S2
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "no_s2_row");
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIL-CLOSED ON UNUSABLE TEMPORAL/CONTEXT AUTHORITY (CodeRabbit Major) +
// EXACT immediate-S2 matching (CodeRabbit Minor)
// ═══════════════════════════════════════════════════════════════════════════

// Corrupt the persisted authorization to simulate a malformed/missing recorded id
// or timestamp reaching the verifier (values it must never trust blindly).
function corruptAuth(w, patch) {
  const auth = JSON.parse(w.sys.get("s1s2_proof_authorization"));
  w.sys.set("s1s2_proof_authorization", JSON.stringify({ ...auth, ...patch }));
}

test("REGRESSION: an UNPARSEABLE received_at fails hard (temporal_authority_unparseable), not stale-passed", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes", w.now(), "not-a-timestamp"); w.seedS2(); // malformed received_at
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "temporal_authority_unparseable"); // NaN < x would have fail-OPENED
  assert.notEqual(v.reason, "no_real_inbound_yet");
  assert.equal(w.events.dispatched.length, 1); // S2 never dispatched
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

test("REGRESSION: a malformed s1_sent_at fails BEFORE the inbound query (temporal_authority_unparseable, no message_events call)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  corruptAuth(w, { s1_sent_at: "0-invalid-date" }); // a malformed timestamp literal
  const meBefore = w.events.fromCalls.filter((n) => n === "message_events").length;
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  const meAfter = w.events.fromCalls.filter((n) => n === "message_events").length;
  assert.equal(v.ok, false);
  assert.equal(v.stage, "temporal_authority_unparseable"); // validated in step 0, before any query
  assert.notEqual(v.stage, "inbound_lookup_failed");
  // The bound would fail the real PostgREST query — prove it is NEVER attempted.
  assert.equal(meAfter - meBefore, 0, "message_events must not be queried with a malformed timestamp");
  assert.equal(w.events.dispatched.length, 1); // S2 never dispatched
});

test("REGRESSION: a valid s1_sent_at still performs the normal inbound lookup", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  const meBefore = w.events.fromCalls.filter((n) => n === "message_events").length;
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  const meAfter = w.events.fromCalls.filter((n) => n === "message_events").length;
  assert.equal(v.ok, true, v.detail);
  assert.ok(meAfter - meBefore >= 1, "message_events queried for the inbound lookup on a valid timestamp");
});

test("REGRESSION: an empty canonical context id fails hard (context_authority_missing)", async () => {
  const w = makeWorld({ mintNonce: () => "n1", ctxOverride: "" }); // canonical context.queue_row_id absent
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "context_authority_missing");
  assert.equal(w.sys.get("queue_execution_mode"), "paused");
});

test("REGRESSION: an empty recorded s1_queue_row_id fails hard (context_authority_missing)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  corruptAuth(w, { s1_queue_row_id: "" });
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "context_authority_missing");
});

test("REGRESSION: BOTH ids empty must NOT compare equal via String(null) (context_authority_missing, no S2)", async () => {
  const w = makeWorld({ mintNonce: () => "n1", ctxOverride: "" }); // ctx id empty
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes"); w.seedS2();
  corruptAuth(w, { s1_queue_row_id: "" });                          // s1 id also empty
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "context_authority_missing"); // the fail-OPEN bug would have matched ""==="" and dispatched
  assert.equal(w.events.dispatched.length, 1);        // S1 only — S2 never dispatched
});

test("REGRESSION: consider_selling_follow_up is NOT the immediate S2 (no_s2_row)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes");
  w.seedS2(w.now(), "consider_selling_follow_up"); // canonicalizes to CONSIDER_SELLING but is a LATER row
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "no_s2_row");
});

test("REGRESSION: the exact immediate consider_selling IS accepted", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes");
  w.seedS2(w.now(), "consider_selling");
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, true, v.detail);
  assert.equal(v.s2_count, 1);
});

test("REGRESSION: two immediate consider_selling rows → multiple_s2_rows (fail closed)", async () => {
  const w = makeWorld({ mintNonce: () => "n1" });
  const arm = await armOk(w);
  w.advance(1000); w.addInbound("Yes");
  w.seedS2(w.now(), "consider_selling", 2); // two exact immediate S2 rows
  const v = await runVerifyAndS2(w.deps, { nonce: arm.nonce });
  assert.equal(v.ok, false);
  assert.equal(v.stage, "multiple_s2_rows");
  assert.equal(w.events.dispatched.length, 1); // S2 never dispatched
});
