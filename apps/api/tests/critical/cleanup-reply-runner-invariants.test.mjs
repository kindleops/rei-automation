/**
 * RC 7.1 — cleanup replies vs the runner's invariants, the vendor-DNC lookup,
 * and the re-queue of the 16 rows the runner paused on 2026-10-02.
 *
 * The runner's OWN functions are the oracle (validateSendQueueRowPreclaim,
 * evaluateContactWindow, isManualInboxSend); every DB is a test double.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { queueCleanupReply, applyNewRepliesCleanupPlan, REPLY_HOLD } from "@/lib/domain/inbox/new-replies-cleanup-apply.js";
import {
  buildCleanupReplyRow,
  checkCleanupRowAgainstRunner,
  resolveCleanupSellerIdentity,
  loadCleanupSellerIdentity,
  RUNNER_BLANK_GREETING_GUARD_RE,
  RUNNER_BLANK_GREETING_INLINE_RE,
} from "@/lib/domain/inbox/cleanup-reply-row.js";
import { lookupVendorDnc, VENDOR_DNC_PLAINTEXT_SQL } from "@/lib/domain/inbox/vendor-dnc-lookup.js";
import {
  requeueCleanupReply,
  REQUEUE_TAG,
  REQUEUE_QUEUE_KEY_SUFFIX,
  LIVE_STATUSES,
} from "@/lib/domain/inbox/cleanup-reply-requeue.js";
import { validateSendQueueRowPreclaim, evaluateContactWindow } from "@/lib/supabase/sms-engine.js";
import { isManualInboxSend } from "@/lib/domain/queue/is-manual-inbox-send.js";

const SOURCE = "classifier_cleanup_20261001";
const NOW = "2026-10-06T18:00:00.000Z"; // 14:00 New York
const THREAD_KEY = "+15555550100";
const SAFE_BODY = "Hey {{seller_first_name}}, this is {{agent_name}}. I reached out a while back about {{property_address}}. Are you still the owner?";
const IDENTITY = Object.freeze({
  seller_first_name: "Pat",
  seller_full_name: "Pat Q Owner",
  seller_display_name: "Pat Q Owner",
  seller_name_source: "master_owner_display_name",
  identity_alignment_status: "unknown",
  phone_id: "ph-1",
  prospect_id: "pr-1",
  candidate: { owner_display_name: "Pat Q Owner", master_owner_display_name: "Pat Q Owner" },
});
const PLAN = { category: "A · live lead", reply: { template_id: "lc-late-identity-en-1", variables: { agent_name: "Sam", property_address: "123 Main St" } } };
const CTX = { deal_id: "deal-1", thread: { thread_key: THREAD_KEY, master_owner_id: "mo-1", property_id: "p-1" }, property: { state: "NY", zip: "10001" }, market: "New York, NY" };

function replyDeps(overrides = {}) {
  const queued = [];
  const deps = {
    now: NOW,
    cohort: { thread_ids: new Set(), thread_keys: new Set(), deal_ids: new Set(["deal-1"]) },
    loadVendorDnc: async () => ({ dnc: false, basis: "plaintext_match" }),
    checkSuppression: async () => ({ suppressed: false }),
    checkRelationship: async () => ({ not_owner: false }),
    loadSellerIdentity: async () => IDENTITY,
    resolveOperatorAction: async () => ({ ok: true, operator_action_id: "act-1" }),
    loadTemplate: async (id) => ({ template_id: id, use_case: "late_reply_identity", language: "English", is_active: true, template_body: SAFE_BODY }),
    selectSender: async () => ({ routing_allowed: true, phone_number: "+15550001000", item_id: "tg-1", selection_reason: "exact_market" }),
    resolveTimezone: () => "America/New_York",
    isWithinContactWindow: () => ({ ok: true }),
    enqueueSendQueueItem: async (payload) => {
      queued.push(payload);
      return { ok: true, queue_row_id: `row-${queued.length}` };
    },
    ...overrides,
  };
  return { deps, queued };
}

// ── The runner's validity checks ─────────────────────────────────────────────

test("a cleanup reply row passes the runner's own preclaim validity check and window", async () => {
  const { deps, queued } = replyDeps();
  const res = await queueCleanupReply(PLAN, CTX, deps);
  assert.equal(res.queued, true, JSON.stringify(res));
  const row = { ...queued[0], id: "11111111-1111-4111-8111-111111111111" };
  const pre = validateSendQueueRowPreclaim(row, NOW);
  assert.equal(pre.ok, true, `runner preclaim: ${pre.reason}`);
  assert.equal(typeof row.metadata.candidate_snapshot, "object");
  assert.equal(row.metadata.candidate_snapshot.seller_first_name, "Pat");
  assert.equal(row.metadata.candidate_snapshot.property_address_state, "NY");
  assert.equal(isManualInboxSend(row), false, "never rides the operator exemption (it waives the window)");
  const window = evaluateContactWindow(row, { now: NOW });
  assert.equal(window.allowed, true);
  assert.equal(window.timezone, "America/New_York");
  // Unchanged: repair tag, template, sender engine number, per-thread dedupe key.
  assert.equal(row.metadata.source, SOURCE);
  assert.equal(row.metadata.repair_tag, SOURCE);
  assert.equal(row.template_id, "lc-late-identity-en-1");
  assert.equal(row.from_phone_number, "+15550001000");
  assert.equal(row.dedupe_key, `${SOURCE}:reply:${THREAD_KEY}`);
  assert.equal(row.queue_key, row.dedupe_key);
});

test("ROOT CAUSE pinned: the pre-fix row shape fails the runner with missing_candidate_snapshot", () => {
  const preFix = {
    id: "22222222-2222-4222-8222-222222222222",
    queue_key: `${SOURCE}:reply:${THREAD_KEY}`,
    dedupe_key: `${SOURCE}:reply:${THREAD_KEY}`,
    thread_key: THREAD_KEY,
    to_phone_number: THREAD_KEY,
    from_phone_number: "+15550001000",
    queue_status: "queued",
    type: "outbound",
    message_type: "reengagement",
    message_body: "Hello there, this is Sam about 123 Main St.",
    template_id: "lc-late-identity-en-1",
    metadata: { source: SOURCE, repair_tag: SOURCE, selected_template_id: "lc-late-identity-en-1" },
  };
  assert.equal(validateSendQueueRowPreclaim(preFix, NOW).reason, "missing_candidate_snapshot");
});

test("the late-reply copy 'Hey, this is…' / 'Hola, soy…' is refused by the send-time guard: HELD, never queued", async () => {
  for (const body of ["Hey, this is {{agent_name}} about {{property_address}}.", "Hola, soy {{agent_name}}. Sobre {{property_address}}."]) {
    const { deps, queued } = replyDeps({ loadTemplate: async (id) => ({ template_id: id, use_case: "x", language: "English", is_active: true, template_body: body }) });
    const res = await queueCleanupReply(PLAN, CTX, deps);
    assert.equal(res.held_reason, REPLY_HOLD.RUNNER_INVALID);
    assert.equal(res.detail, "blank_greeting_guard");
    assert.equal(queued.length, 0);
  }
});

test("the blank-greeting regexes are the runner's and the provider's, verbatim", () => {
  const root = process.cwd();
  const runner = fs.readFileSync(path.join(root, "src/lib/domain/queue/process-send-queue.js"), "utf8");
  assert.ok(runner.includes(`BLANK_GREETING_GUARD_RE = ${RUNNER_BLANK_GREETING_GUARD_RE.toString()};`));
  assert.ok(runner.includes(`BLANK_GREETING_INLINE_RE = ${RUNNER_BLANK_GREETING_INLINE_RE.toString()};`));
  const provider = fs.readFileSync(path.join(root, "src/lib/providers/textgrid.js"), "utf8");
  assert.ok(provider.includes("BLANK_GREETING_RE = /^(Hello|Hi|Hey|Hola|Ola|Marhaba)\\s*,|(Hello\\s*,|Hey\\s*,|Hi\\s*,|Hola\\s*,|Ola\\s*,|Marhaba\\s*,)/i;"));
});

test("holds stay fail-closed: no seller name, unreadable identity, runner window closed, asset guard", async () => {
  const noName = replyDeps({ loadSellerIdentity: async () => ({ ...IDENTITY, seller_first_name: null }) });
  assert.equal((await queueCleanupReply(PLAN, CTX, noName.deps)).held_reason, REPLY_HOLD.NO_SELLER_NAME);
  const down = replyDeps({ loadSellerIdentity: async () => { throw new Error("down"); } });
  assert.equal((await queueCleanupReply(PLAN, CTX, down.deps)).held_reason, REPLY_HOLD.IDENTITY_UNKNOWN);
  // The executor's window says yes but the runner's (recipient zone) says no.
  const night = replyDeps({ now: "2026-10-06T04:00:00.000Z" });
  const r = await queueCleanupReply(PLAN, CTX, night.deps);
  assert.equal(r.held_reason, REPLY_HOLD.WINDOW);
  assert.equal(night.queued.length, 0);
  // No geography and no zone: the runner would hold (D10), so we hold.
  const noGeo = replyDeps();
  const r2 = await queueCleanupReply(PLAN, { ...CTX, property: {} }, { ...noGeo.deps, resolveTimezone: () => null });
  assert.equal(r2.held_reason, REPLY_HOLD.TIMEZONE);
  const asset = replyDeps({ evaluateTemplateAssetGuard: async () => ({ allowed: false, reason: "template_scope_excludes_property" }) });
  const r3 = await queueCleanupReply(PLAN, CTX, asset.deps);
  assert.equal(r3.held_reason, REPLY_HOLD.ASSET);
  assert.equal(asset.queued.length, 0);
  // Vendor DNC (object form) and no eligible sender still hold, unchanged.
  const dnc = replyDeps({ loadVendorDnc: async () => ({ dnc: true, basis: "plaintext_match" }) });
  assert.equal((await queueCleanupReply(PLAN, CTX, dnc.deps)).held_reason, REPLY_HOLD.VENDOR_DNC);
  const unk = replyDeps({ loadVendorDnc: async () => ({ dnc: null, basis: "unverifiable_encrypted_slot" }) });
  const ru = await queueCleanupReply(PLAN, CTX, unk.deps);
  assert.equal(ru.held_reason, REPLY_HOLD.VENDOR_DNC_UNKNOWN);
  assert.equal(ru.detail, "unverifiable_encrypted_slot");
  const noSender = replyDeps({ selectSender: async () => ({ routing_allowed: false, phone_number: "" }) });
  assert.equal((await queueCleanupReply(PLAN, CTX, noSender.deps)).held_reason, REPLY_HOLD.NO_SENDER);
});

test("a nurture follow-up reads the object-form vendor flag the same way (null holds, false proceeds)", async () => {
  const calls = [];
  const base = {
    cohort: { thread_ids: new Set(), thread_keys: new Set([THREAD_KEY]), deal_ids: new Set() },
    scheduleFollowUp: async () => { calls.push("scheduleFollowUp"); return { ok: true }; },
  };
  const held = await applyNewRepliesCleanupPlan({ category: "x", apply: ["schedule_nurture_followup"] }, { thread: { thread_key: THREAD_KEY } }, { ...base, loadVendorDnc: async () => ({ dnc: null, basis: "x" }) });
  assert.equal(held.steps[0].held_reason, REPLY_HOLD.VENDOR_DNC_UNKNOWN);
  await applyNewRepliesCleanupPlan({ category: "x", apply: ["schedule_nurture_followup"] }, { thread: { thread_key: THREAD_KEY } }, { ...base, loadVendorDnc: async () => ({ dnc: false, basis: "plaintext_match" }) });
  assert.deepEqual(calls, ["scheduleFollowUp"]);
});

test("seller identity: the canonical resolver names the owner; a company owner yields no first name", () => {
  const person = resolveCleanupSellerIdentity({ master_owner: { display_name: "Gale D Leflore" }, phone: { phone_id: "ph" } });
  assert.equal(person.seller_first_name, "Gale");
  const company = resolveCleanupSellerIdentity({ master_owner: { display_name: "Pegasus Land Co LLC" } });
  assert.equal(company.seller_first_name, null);
});

test("seller identity loader fails closed on a read error", async () => {
  const db = { from: () => ({ select: () => ({ in: () => ({ limit: async () => ({ error: { message: "x" } }) }) }) }) };
  assert.equal(await loadCleanupSellerIdentity(db, { thread_key: THREAD_KEY }), null);
});

test("the built row is never an operator/auto-reply exemption and carries no pinned sender", () => {
  const row = buildCleanupReplyRow({
    thread: CTX.thread, property: CTX.property, template: { template_id: "t", use_case: "u", language: "English" },
    rendered_text: "Hey Pat, this is Sam.", sender: { phone_number: "+15550001000" }, timezone: "America/New_York",
    identity: IDENTITY, source: SOURCE, dedupe_key: "k", now: NOW,
  });
  // Without an action anchor the dispatcher refuses it (e740c6d8, 20:18Z).
  const unanchored = checkCleanupRowAgainstRunner(row, { now: NOW });
  assert.deepEqual(unanchored.failures, ["queue_row_identity_underivable"]);
  row.metadata.operator_action_id = "act-1";
  assert.equal(checkCleanupRowAgainstRunner(row, { now: NOW }).ok, true);
  assert.equal(row.metadata.source, SOURCE);
});

// ── Vendor DNC lookup ────────────────────────────────────────────────────────

function fakeQuery({ plain, enc, failPlain = false }) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql === VENDOR_DNC_PLAINTEXT_SQL) {
      if (failPlain) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      return { rows: [plain] };
    }
    return { rows: [enc] };
  };
  return { query, calls };
}

test("vendor DNC: exact match on the phone's forms, no per-row regexp scan", async () => {
  const { query, calls } = fakeQuery({ plain: { dnc: true, n: 1 } });
  assert.deepEqual(await lookupVendorDnc(query, "+17025557776"), { dnc: true, basis: "plaintext_match" });
  assert.deepEqual(calls[0].params[0], ["7025557776", "17025557776", "+17025557776"]);
  assert.equal(/regexp_replace/.test(calls[0].sql), false);
  const clear = fakeQuery({ plain: { dnc: false, n: 1 } });
  assert.deepEqual(await lookupVendorDnc(clear.query, "+17025557776"), { dnc: false, basis: "plaintext_match" });
});

test("vendor DNC: a timeout holds; an unlisted phone whose individual has ENCRYPTED slots is unknown, not clear", async () => {
  const t = fakeQuery({ failPlain: true });
  const r = await lookupVendorDnc(t.query, "+17025557776");
  assert.equal(r.dnc, null);
  assert.match(r.basis, /^plaintext_lookup_failed:57014/);
  const enc = fakeQuery({ plain: { dnc: null, n: 0 }, enc: { encrypted_slots: 2, n: 2 } });
  assert.deepEqual(await lookupVendorDnc(enc.query, "+17025557776"), { dnc: null, basis: "unverifiable_encrypted_slot" });
  const none = fakeQuery({ plain: { dnc: null, n: 0 }, enc: { encrypted_slots: 0, n: 0 } });
  assert.deepEqual(await lookupVendorDnc(none.query, "+17025557776"), { dnc: false, basis: "not_in_vendor_data" });
  assert.equal((await lookupVendorDnc(none.query, "12")).dnc, null);
});

// ── Re-queue ─────────────────────────────────────────────────────────────────

function requeueWorld(initialRows) {
  const rows = initialRows.map((r) => ({ ...r }));
  const writes = [];
  const base = replyDeps({
    enqueueSendQueueItem: async (payload) => {
      writes.push({ op: "insert", queue_key: payload.queue_key });
      // Mirrors send_queue_queue_key_key + uq_send_queue_active_dedupe_key.
      const keyClash = rows.find((r) => r.queue_key === payload.queue_key);
      const liveClash = rows.find((r) => r.dedupe_key === payload.dedupe_key && !r.sent_at && LIVE_STATUSES.has(r.queue_status));
      if (keyClash || liveClash) return { ok: true, idempotent_replay: true, queue_row_id: (keyClash || liveClash).id };
      const row = { ...payload, id: `new-${rows.length}`, sent_at: null };
      rows.push(row);
      return { ok: true, queue_row_id: row.id };
    },
  });
  const deps = {
    ...base.deps,
    source: SOURCE,
    loadCleanupRows: async () => rows.map((r) => ({ ...r })),
    cancelPausedRow: async (row, patch) => {
      writes.push({ op: "cancel", id: row.id });
      const live = rows.find((r) => r.id === row.id);
      // CAS on the status that was read (the script's .eq("queue_status", row.queue_status)).
      if (!live || live.queue_status !== row.queue_status) return { ok: true, changed: false };
      Object.assign(live, patch);
      return { ok: true, changed: true };
    },
    queueReply: queueCleanupReply,
  };
  return { rows, writes, deps };
}

const PAUSED_ROW = Object.freeze({
  id: "old-1",
  queue_key: `${SOURCE}:reply:${THREAD_KEY}`,
  dedupe_key: `${SOURCE}:reply:${THREAD_KEY}`,
  queue_status: "paused_invalid_queue_row",
  guard_reason: null,
  sent_at: null,
  metadata: { source: SOURCE, skip_reason: "missing_candidate_snapshot" },
});

test("re-queue: cancels the paused row with audit and queues ONE runner-valid row; a second run adds nothing", async () => {
  const w = requeueWorld([PAUSED_ROW]);
  const first = await requeueCleanupReply(PLAN, CTX, w.deps);
  assert.equal(first.outcome, "queued", JSON.stringify(first));
  const old = w.rows.find((r) => r.id === "old-1");
  assert.equal(old.queue_status, "cancelled");
  assert.equal(old.guard_reason, REQUEUE_TAG);
  assert.equal(old.metadata.requeue_audit.prior_guard_reason, "missing_candidate_snapshot");
  const fresh = w.rows.filter((r) => r.id !== "old-1");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].queue_key, `${SOURCE}:reply:${THREAD_KEY}:${REQUEUE_QUEUE_KEY_SUFFIX}`);
  assert.equal(fresh[0].dedupe_key, `${SOURCE}:reply:${THREAD_KEY}`, "the per-thread dedupe key is unchanged");
  assert.deepEqual(fresh[0].metadata.requeue.replaces_queue_row_ids, ["old-1"]);
  assert.equal(validateSendQueueRowPreclaim(fresh[0], NOW).ok, true);

  const second = await requeueCleanupReply(PLAN, CTX, w.deps);
  assert.equal(second.outcome, "skipped");
  assert.equal(second.reason, "live_row_exists");
  const live = w.rows.filter((r) => !r.sent_at && LIVE_STATUSES.has(r.queue_status));
  assert.equal(live.length, 1, "never two live rows per thread");
});

test("re-queue: a held reply cancels the dead row, writes no new row, and a later run re-evaluates and queues", async () => {
  const w = requeueWorld([PAUSED_ROW]);
  const night = await requeueCleanupReply(PLAN, CTX, { ...w.deps, now: "2026-10-06T04:00:00.000Z" });
  assert.equal(night.outcome, "held");
  assert.equal(night.held_reason, REPLY_HOLD.WINDOW);
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].queue_status, "cancelled");
  const later = await requeueCleanupReply(PLAN, CTX, w.deps);
  assert.equal(later.outcome, "queued", "the cancelled row does not block the re-queue");
  assert.equal(w.rows.length, 2);
});

test("re-queue: a sent row is never re-sent; threads outside the 16 are skipped; unreadable rows refuse", async () => {
  const sent = requeueWorld([PAUSED_ROW, { ...PAUSED_ROW, id: "s-1", queue_key: "x", queue_status: "sent", sent_at: NOW }]);
  assert.equal((await requeueCleanupReply(PLAN, CTX, sent.deps)).reason, "already_sent");
  assert.deepEqual(sent.writes, []);
  const outside = requeueWorld([]);
  assert.equal((await requeueCleanupReply(PLAN, CTX, outside.deps)).reason, "not_in_requeue_set");
  assert.deepEqual(outside.writes, []);
  const broken = requeueWorld([PAUSED_ROW]);
  const r = await requeueCleanupReply(PLAN, CTX, { ...broken.deps, loadCleanupRows: async () => { throw new Error("down"); } });
  assert.equal(r.reason, "existing_rows_unreadable");
  assert.deepEqual(broken.writes, []);
});

test("re-queue DRY RUN: reports would_cancel + would_queue with ZERO writes", async () => {
  const w = requeueWorld([PAUSED_ROW]);
  const r = await requeueCleanupReply(PLAN, CTX, { ...w.deps, dryRun: true, enqueueSendQueueItem: async () => { throw new Error("write in dry run"); }, cancelPausedRow: async () => { throw new Error("write in dry run"); } });
  assert.equal(r.outcome, "would_queue");
  assert.deepEqual(r.cancelled, [{ id: "old-1", would_cancel: true }]);
  assert.equal(w.rows[0].queue_status, "paused_invalid_queue_row");
});

// ── Owner-locked copy (2026-10-02) ───────────────────────────────────────────

import { applyLockedLateReplyCopy, LOCKED_LATE_REPLY_TEMPLATES } from "@/lib/domain/inbox/late-reply-locked-copy.js";
import { templateUsesFirstName } from "@/lib/domain/inbox/new-replies-cleanup-apply.js";

const LOCKED_EN = "This is {{agent_name}}. I reached out a while back about {{property_address}}. Just checking back in. Are you still the owner?";
const LOCKED_ES = "Soy {{agent_name}}. Me comuniqué hace un tiempo por {{property_address}}. Solo quería saber si todavía eres el propietario.";

test("locked copy: EN for English and wrong-language threads, ES for Spanish; other rows untouched", () => {
  assert.equal(applyLockedLateReplyCopy({ template_id: "lc-late-identity-en-2" }).template_id, LOCKED_LATE_REPLY_TEMPLATES.English);
  assert.equal(applyLockedLateReplyCopy({ template_id: "lc-late-wrong-language-from-es-en-1" }).template_id, LOCKED_LATE_REPLY_TEMPLATES.English);
  const es = applyLockedLateReplyCopy({ template_id: "lc-late-listed-other-property-es-1", variables: { agent_name: "A" } });
  assert.equal(es.template_id, LOCKED_LATE_REPLY_TEMPLATES.Spanish);
  assert.equal(es.plan_template_id, "lc-late-listed-other-property-es-1");
  assert.deepEqual(es.variables, { agent_name: "A" });
  assert.deepEqual(applyLockedLateReplyCopy({ template_id: "1124" }), { template_id: "1124" });
});

test("locked copy: the SQL carries the owner's exact bodies, and both pass every runner guard", async () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "scripts/repairs/20261001_late_reply_templates.sql"), "utf8");
  const part4 = sql.slice(sql.indexOf("── PART 4 ·"));
  assert.ok(part4.includes(`('lc-late-checkin-en-1', 'late_reply_checkin', 'S1', 'English', '${LOCKED_EN}'`));
  assert.ok(part4.includes(`('lc-late-checkin-es-1', 'late_reply_checkin', 'S1', 'Spanish', '${LOCKED_ES}'`));
  for (const [body, lang] of [[LOCKED_EN, "English"], [LOCKED_ES, "Spanish"]]) {
    assert.equal(templateUsesFirstName(body), false);
    const { deps, queued } = replyDeps({ loadTemplate: async (id) => ({ template_id: id, use_case: "late_reply_checkin", language: lang, is_active: true, template_body: body }) });
    const res = await queueCleanupReply({ ...PLAN, reply: applyLockedLateReplyCopy(PLAN.reply) }, CTX, deps);
    assert.equal(res.queued, true, JSON.stringify(res));
    assert.equal(queued[0].metadata.plan_template_id, "lc-late-identity-en-1");
    assert.equal(validateSendQueueRowPreclaim({ ...queued[0], id: "x-1" }, NOW).ok, true);
  }
});

test("first-name hold is token-aware: no name token -> no hold; a name token without a name -> hold", async () => {
  assert.equal(templateUsesFirstName("Hey {{seller_first_name}}, this is {{agent_name}}."), true);
  assert.equal(templateUsesFirstName(LOCKED_EN), false);
  const unnamed = { ...IDENTITY, seller_first_name: null, seller_name_source: "none", identity_alignment_status: "weak" };
  const locked = replyDeps({
    loadSellerIdentity: async () => unnamed,
    loadTemplate: async (id) => ({ template_id: id, use_case: "late_reply_checkin", language: "English", is_active: true, template_body: LOCKED_EN }),
  });
  const ok = await queueCleanupReply(PLAN, CTX, locked.deps);
  assert.equal(ok.queued, true, JSON.stringify(ok));
  assert.equal(locked.queued[0].message_body.startsWith("This is Sam."), true);
  const named = replyDeps({ loadSellerIdentity: async () => unnamed });
  const held = await queueCleanupReply(PLAN, CTX, named.deps);
  assert.equal(held.held_reason, REPLY_HOLD.NO_SELLER_NAME);
  assert.equal(named.queued.length, 0);
});

// ── Sender selection (20:16Z: 15 rows on operator-blocked numbers) ──────────

import { selectCleanupReplySender } from "@/lib/domain/inbox/cleanup-reply-sender.js";
import { chooseTextgridNumber } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { evaluateSmsHealthGuard } from "@/lib/domain/delivery/sms-health-guard.js";
import { evaluateOutboundNumberEligibility } from "@/lib/supabase/sms-engine.js";
import { resolveQueueRowIdentity } from "@/lib/domain/communications/queue-row-identity.js";

const LA_BLOCKED = "+13235554544";
const LA_OK = "+13235550001";
const fleetRow = (phone, market, extra = {}) => ({ id: `tg-${phone.slice(-4)}`, phone_number: phone, market, status: "active", health_state: "healthy", messages_sent_today: 0, ...extra });
const SC = { sms_blocked_sender_numbers: LA_BLOCKED, sms_blocked_template_ids: "", require_local_routing: "false", allow_regional_fallback_for_first_touch: "true" };
const scReader = (sc = SC) => async (key) => sc[key] ?? null;
const env = {};

test("sender: the operator-blocked number is never chosen; the selection passes the runner's sender guards (parity)", async () => {
  // The blocked number has the lowest usage: the pre-fix selector picked it.
  const fleet = [fleetRow(LA_BLOCKED, "Los Angeles, CA"), fleetRow(LA_OK, "Los Angeles, CA", { messages_sent_today: 40 })];
  const pre = await chooseTextgridNumber({ market: "Los Angeles, CA", state: "CA", touch_number: 2 }, { first_touch: false }, { textgridNumberRows: fleet });
  assert.equal(pre.selected_textgrid_number, LA_BLOCKED, "the defect, reproduced: no blocklist -> blocked number");
  const s = await selectCleanupReplySender({ market: "Los Angeles, CA", state: "CA", template_id: "lc-late-checkin-en-1" }, { chooseTextgridNumber, getSystemValue: scReader(), textgridNumberRows: fleet, env });
  assert.equal(s.routing_allowed, true);
  assert.equal(s.phone_number, LA_OK);
  // Parity: exactly what the runner evaluates at send time.
  const guard = evaluateSmsHealthGuard({ from_phone_number: s.phone_number, template_id: "lc-late-checkin-en-1", routing_tier: s.routing_tier, first_touch: false, system_control: SC, env });
  assert.equal(guard.allowed, true);
  assert.equal(evaluateOutboundNumberEligibility(fleet.find((r) => r.phone_number === s.phone_number)).ok, true);
});

test("sender parity, exhaustive over a mixed fleet: whatever is returned passes the runner's guard", async () => {
  const fleet = [
    fleetRow(LA_BLOCKED, "Los Angeles, CA"),
    fleetRow("+13055555670", "Miami, FL"),
    fleetRow("+17135550002", "Houston, TX", { health_state: "cooling", cooling_until: "2099-01-01T00:00:00Z" }),
    fleetRow("+16125550495", "Minneapolis, MN"),
    fleetRow("+12145550003", "Dallas, TX", { status: "paused" }),
  ];
  const sc = { ...SC, sms_blocked_sender_numbers: `${LA_BLOCKED},+13055555670` };
  for (const [market, state] of [["Los Angeles, CA", "CA"], ["Miami, FL", "FL"], ["Houston, TX", "TX"], ["Minneapolis, MN", "MN"], ["Providence, RI", "RI"], ["Dallas, TX", "TX"]]) {
    const s = await selectCleanupReplySender({ market, state, template_id: "t" }, { chooseTextgridNumber, getSystemValue: scReader(sc), textgridNumberRows: fleet, env });
    if (!s.routing_allowed) {
      assert.equal(s.phone_number, null, "no eligible sender -> nothing pinned");
      continue;
    }
    assert.notEqual(s.phone_number, LA_BLOCKED);
    assert.notEqual(s.phone_number, "+13055555670");
    const guard = evaluateSmsHealthGuard({ from_phone_number: s.phone_number, template_id: "t", routing_tier: s.routing_tier, first_touch: false, system_control: sc, env });
    assert.equal(guard.allowed, true, `${market}: ${guard.reason}`);
    assert.equal(evaluateOutboundNumberEligibility(fleet.find((r) => r.phone_number === s.phone_number)).ok, true, market);
  }
});

test("sender: no eligible number -> no_eligible_sender HOLD; an unreadable blocklist holds too (fail closed)", async () => {
  const fleet = [fleetRow(LA_BLOCKED, "Los Angeles, CA")];
  const none = await selectCleanupReplySender({ market: "Los Angeles, CA", state: "CA" }, { chooseTextgridNumber, getSystemValue: scReader(), textgridNumberRows: fleet, env });
  assert.equal(none.routing_allowed, false);
  assert.equal(none.phone_number, null);
  const down = await selectCleanupReplySender({ market: "Los Angeles, CA", state: "CA" }, { chooseTextgridNumber, getSystemValue: async () => { throw new Error("down"); }, textgridNumberRows: [fleetRow(LA_OK, "Los Angeles, CA")], env });
  assert.equal(down.routing_block_reason, "sender_blocklist_unreadable");
  // Through the executor: HOLD no_eligible_sender, nothing queued.
  const { deps, queued } = replyDeps({ selectSender: async () => none });
  const res = await queueCleanupReply(PLAN, CTX, deps);
  assert.equal(res.held_reason, REPLY_HOLD.NO_SENDER);
  assert.equal(queued.length, 0);
});

test("a queued cleanup row names its action (operator_reply anchor), one action per queue_key; no anchor -> HOLD", async () => {
  const actions = [];
  const { deps, queued } = replyDeps({
    resolveOperatorAction: async (input) => { actions.push(input); return { ok: true, operator_action_id: "act-9" }; },
  });
  await queueCleanupReply(PLAN, CTX, deps);
  assert.equal(actions[0].action_type, "operator_reply");
  assert.equal(actions[0].request_idempotency_key, queued[0].queue_key);
  assert.equal(queued[0].metadata.operator_action_id, "act-9");
  const id = resolveQueueRowIdentity({ ...queued[0], id: "r-1" });
  assert.equal(id.ok, true);
  assert.equal(id.anchors.operator_action_id, "act-9");
  assert.equal(isManualInboxSend(queued[0]), false, "an action anchor is not the operator window exemption");
  const failing = replyDeps({ resolveOperatorAction: async () => ({ ok: false, reason: "operator_action_not_durable" }) });
  const r = await queueCleanupReply(PLAN, CTX, failing.deps);
  assert.equal(r.held_reason, REPLY_HOLD.NO_ACTION);
  assert.equal(failing.queued.length, 0);
  // Existing action (a re-run): reused, nothing new recorded.
  const again = replyDeps({ findOperatorAction: async () => "act-old", resolveOperatorAction: async () => { throw new Error("must not create"); } });
  await queueCleanupReply(PLAN, CTX, again.deps);
  assert.equal(again.queued[0].metadata.operator_action_id, "act-old");
});

test("re-queue SENDER pass: cancels only the blocked row, keeps one live row per thread, never touches a live/sent thread", async () => {
  const { REQUEUE_PASSES } = await import("@/lib/domain/inbox/cleanup-reply-requeue.js");
  const blockedRow = {
    id: "blk-1", queue_key: `${SOURCE}:reply:${THREAD_KEY}:requeue:rc71`, dedupe_key: `${SOURCE}:reply:${THREAD_KEY}`,
    queue_status: "blocked_by_health_guard", guard_reason: "blocked_sender_number", from_phone_number: LA_BLOCKED, sent_at: null,
    metadata: { source: SOURCE },
  };
  const original = { ...PAUSED_ROW, queue_status: "cancelled", guard_reason: REQUEUE_TAG };
  const w = requeueWorld([original, blockedRow]);
  const pass = REQUEUE_PASSES.sender;
  const r = await requeueCleanupReply(PLAN, CTX, { ...w.deps, pass });
  assert.equal(r.outcome, "queued", JSON.stringify(r));
  const blk = w.rows.find((x) => x.id === "blk-1");
  assert.equal(blk.queue_status, "cancelled");
  assert.equal(blk.guard_reason, "rc71_replies_requeue_sender");
  assert.equal(blk.metadata["requeue_audit_rc71_replies_requeue_sender"].prior_from_phone_masked, "•••4544");
  assert.equal(w.rows.find((x) => x.id === "old-1").guard_reason, REQUEUE_TAG, "the pass-1 row is untouched");
  const fresh = w.rows.filter((x) => x.queue_key.endsWith(":requeue:rc71:sender"));
  assert.equal(fresh.length, 1);
  const again = await requeueCleanupReply(PLAN, CTX, { ...w.deps, pass });
  assert.equal(again.reason, "live_row_exists");
  // A thread whose row is live (e740c6d8's shape) is never touched.
  const liveThread = requeueWorld([{ ...blockedRow, id: "live-1", queue_status: "queued", guard_reason: null }]);
  const lr = await requeueCleanupReply(PLAN, CTX, { ...liveThread.deps, pass });
  assert.equal(lr.reason, "live_row_exists");
  assert.deepEqual(liveThread.writes, []);
});

test("re-queue IDENTITY pass: replaces the stranded queued row once, anchored; refuses a claimed/anchored/sent row", async () => {
  const { REQUEUE_PASSES } = await import("@/lib/domain/inbox/cleanup-reply-requeue.js");
  const pass = REQUEUE_PASSES.identity;
  const stranded = {
    id: "str-1", queue_key: `${SOURCE}:reply:${THREAD_KEY}:requeue:rc71`, dedupe_key: `${SOURCE}:reply:${THREAD_KEY}`,
    queue_status: "queued", is_locked: false, lock_token: null, sent_at: null, provider_message_id: null,
    metadata: { source: SOURCE, skip_reason: "queue_row_identity_underivable" },
  };
  const w = requeueWorld([{ ...PAUSED_ROW, queue_status: "cancelled", guard_reason: REQUEUE_TAG }, stranded]);
  const r = await requeueCleanupReply(PLAN, CTX, { ...w.deps, pass });
  assert.equal(r.outcome, "queued", JSON.stringify(r));
  const old = w.rows.find((x) => x.id === "str-1");
  assert.equal(old.queue_status, "cancelled");
  assert.equal(old.guard_reason, "rc71_replies_requeue_identity");
  assert.ok(old.metadata.requeue_audit_rc71_replies_requeue_identity.cancelled_at);
  const fresh = w.rows.filter((x) => x.queue_key.endsWith(":requeue:rc71:identity"));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].metadata.operator_action_id, "act-1");
  assert.equal(resolveQueueRowIdentity({ ...fresh[0], id: "n-1" }).ok, true);
  const live = w.rows.filter((x) => !x.sent_at && LIVE_STATUSES.has(x.queue_status));
  assert.equal(live.length, 1, "one live row per thread");
  // Idempotent: the replacement is live and anchored -> nothing more.
  assert.equal((await requeueCleanupReply(PLAN, CTX, { ...w.deps, pass })).reason, "live_row_exists");

  for (const [label, row] of [
    ["claimed", { ...stranded, is_locked: true, lock_token: "t" }],
    ["anchored", { ...stranded, metadata: { ...stranded.metadata, operator_action_id: "a" } }],
    ["provider id", { ...stranded, provider_message_id: "SM1" }],
  ]) {
    const x = requeueWorld([row]);
    const res = await requeueCleanupReply(PLAN, CTX, { ...x.deps, pass });
    assert.notEqual(res.outcome, "queued", label);
    assert.equal(x.writes.length, 0, label);
  }
  // Moved between read and cancel -> refuse, no insert.
  const moved = requeueWorld([stranded]);
  const rm = await requeueCleanupReply(PLAN, CTX, { ...moved.deps, pass, cancelPausedRow: async () => ({ ok: true, changed: false }) });
  assert.equal(rm.reason, "row_changed_since_read");
  assert.equal(moved.rows.length, 1);
});
