#!/usr/bin/env node
// Full-corpus inbound replay — READ ONLY, never sends, never mutates.
//
// Extends the 400-newest harness to the COMPLETE historical inbound corpus
// with stratified reporting, thread-aware state carried turn-to-turn, the
// adversarial corpus, and scripted golden conversation sequences. Seller
// message bodies are NEVER written to the report — only SHA-256 digests and
// lengths (PII policy mirrors inbound_processing_ledger).
//
// Usage:
//   node --import ./scripts/register-aliases-ops.mjs scripts/ops/inbound-full-replay.mjs \
//     [--env .env.local] [--out /path/report.json]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : fallback;
}

const envFile = argValue("--env", ".env.local");
const outFile = argValue("--out", `/tmp/inbound-full-replay-${Date.now()}.json`);

const envPath = path.resolve(process.cwd(), envFile);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const { createClient } = await import("@supabase/supabase-js");
const { replayInboundCase, makeReplaySupabase, resolveReplayDisposition } = await import(
  "../../src/lib/domain/inbound/inbound-replay-engine.js"
);
const { classify } = await import("../../src/lib/domain/classification/classify.js");
const { executeInboundAutomationDecision } = await import(
  "../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js"
);
const { isInternalTestPhone } = await import("../../src/lib/config/internal-phones.js");
const { ADVERSARIAL_INBOUND_CASES } = await import(
  "../../tests/fixtures/inbound-adversarial-corpus.mjs"
);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const digest = (text) => createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
const pct = (num, den) => (den ? `${((num / den) * 100).toFixed(2)}%` : "n/a");
const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };

// ── 1. Fetch the COMPLETE inbound corpus (paginated; PostgREST caps pages) ──
const PAGE = 1000;
const events = [];
for (let fromIdx = 0; ; fromIdx += PAGE) {
  const { data, error } = await supabase
    .from("message_events")
    .select(
      "id,provider_message_sid,from_phone_number,to_phone_number,message_body,detected_intent,is_opt_out,created_at,thread_key"
    )
    .eq("direction", "inbound")
    .order("created_at", { ascending: true })
    .range(fromIdx, fromIdx + PAGE - 1);
  if (error) {
    console.error("load failed:", error.message);
    process.exit(1);
  }
  events.push(...(data || []));
  if (!data || data.length < PAGE) break;
}
console.log(`Fetched ${events.length} historical inbound events (full corpus, read-only).`);

// ── 2. Context-free bulk replay with stratified metrics ──
const NOW = Date.now();
const bulk = {
  total: 0,
  internal_skipped: 0,
  terminal: 0,
  exceptions: 0,
  silent_drops: 0,
  would_reply: 0,
  human_review: 0,
  low_confidence: 0,
  suppression_violations: [],
  intent_agree: 0,
  intent_compared: 0,
  disposition_histogram: {},
  by_intent: {},
  by_language: {},
  by_length_bucket: {},
  by_thread_age_bucket: {},
  by_market_proxy: {},
  latencies: [],
  disagreement_samples: [],
};

const lengthBucket = (len) =>
  len <= 5 ? "1-5" : len <= 20 ? "6-20" : len <= 60 ? "21-60" : len <= 160 ? "61-160" : "160+";
const ageBucket = (createdAt) => {
  const days = (NOW - Date.parse(createdAt)) / 86_400_000;
  return days <= 7 ? "0-7d" : days <= 30 ? "8-30d" : days <= 60 ? "31-60d" : "61d+";
};

for (const event of events) {
  if (isInternalTestPhone(event.from_phone_number) || isInternalTestPhone(event.to_phone_number)) {
    bulk.internal_skipped += 1;
    continue;
  }
  bulk.total += 1;
  const body = event.message_body || "";
  const result = await replayInboundCase({
    case_id: `hist-${event.id}`,
    message_body: body,
    prior_context: {},
    provider_quirks: {},
  });

  bulk.latencies.push(result.latency_ms || 0);
  const disposition = result.disposition || null;
  if (disposition) bulk.terminal += 1;
  else bulk.silent_drops += 1;
  if (!result.ok) bulk.exceptions += 1;
  bump(bulk.disposition_histogram, disposition || "NONE");

  const replayIntent = result.classification?.primary_intent || "unclear";
  bump(bulk.by_intent, replayIntent);
  bump(bulk.by_language, result.classification?.language || "unknown");
  bump(bulk.by_length_bucket, lengthBucket(body.length));
  bump(bulk.by_thread_age_bucket, ageBucket(event.created_at));
  bump(bulk.by_market_proxy, String(event.from_phone_number || "").replace(/^\+1/, "").slice(0, 3) || "unknown");

  const conf = Number(result.classification?.confidence ?? 0);
  if (conf > 0 && conf < 0.6) bulk.low_confidence += 1;
  if (result.detail?.should_queue_reply) bulk.would_reply += 1;
  if (disposition === "human_review_required") bulk.human_review += 1;

  // Suppression safety: a historical opt-out event must never replay to a
  // would-reply outcome.
  if (event.is_opt_out === true && result.detail?.should_queue_reply) {
    bulk.suppression_violations.push({ event_id: event.id, body_sha256: digest(body), replay_intent: replayIntent });
  }

  // Intent agreement vs the historically recorded label (the only reviewed
  // labels that exist for this corpus).
  const hist = String(event.detected_intent || "").toLowerCase();
  if (hist && hist !== "unknown") {
    bulk.intent_compared += 1;
    if (hist === replayIntent) bulk.intent_agree += 1;
    else if (bulk.disagreement_samples.length < 200) {
      bulk.disagreement_samples.push({
        event_id: event.id,
        body_sha256: digest(body),
        body_length: body.length,
        historical: hist,
        replayed: replayIntent,
        confidence: conf,
      });
    }
  }
}

// ── 3. Thread-aware pass: real threads replayed oldest→newest with state
//      carried turn-to-turn through the LIVE nested context shape ──
const threads = new Map();
for (const event of events) {
  if (isInternalTestPhone(event.from_phone_number) || isInternalTestPhone(event.to_phone_number)) continue;
  const key = event.thread_key || event.from_phone_number;
  if (!threads.has(key)) threads.set(key, []);
  threads.get(key).push(event);
}

const threaded = {
  threads: 0,
  multi_turn_threads: 0,
  turns: 0,
  exceptions: 0,
  supersessions: 0,
  re_engagements: 0,
  reversals: 0,
  post_optout_replies: [],
};

async function replayTurnWithContext(body, priorSummary, receivedAt) {
  const classification = await classify(body, null, { heuristicOnly: true });
  const execution = await executeInboundAutomationDecision({
    message: body,
    threadKey: "+16125550100",
    inboundFrom: "+16125550100",
    inboundTo: "+16125550001",
    ownerId: "replay_owner",
    inboundReceivedAt: receivedAt,
    // LIVE shape: prior state nested under .summary, as the production path
    // in process-seller-inbound-message.js passes it.
    latestThreadContext: priorSummary ? { summary: priorSummary } : null,
    classification,
    dryRun: true,
    autoReplyMode: "dry_run",
    supabaseClient: makeReplaySupabase({
      suppressions: priorSummary?.__suppressions || [],
    }),
  });
  return { classification, execution, disposition: resolveReplayDisposition(execution, classification) };
}

for (const [, turns] of threads) {
  threaded.threads += 1;
  if (turns.length > 1) threaded.multi_turn_threads += 1;
  let summary = null;
  let optedOut = false;
  for (const event of turns) {
    threaded.turns += 1;
    try {
      const { classification, execution, disposition } = await replayTurnWithContext(
        event.message_body || "",
        summary,
        event.created_at
      );
      const decision = execution?.automation_decision || {};
      const precedence = decision.latest_intent_precedence || null;
      if (precedence?.supersedes_prior_state) threaded.supersessions += 1;
      if (precedence?.re_engagement_detected) threaded.re_engagements += 1;
      if (precedence?.reversal_detected) threaded.reversals += 1;
      if (optedOut && decision.should_queue_reply === true) {
        threaded.post_optout_replies.push({ event_id: event.id, body_sha256: digest(event.message_body) });
      }
      if (classification?.primary_intent === "opt_out" || classification?.compliance_flag) {
        optedOut = optedOut || classification?.primary_intent === "opt_out";
      }
      summary = {
        disposition: decision.disposition || null,
        last_intent: classification?.primary_intent || null,
        automation_status: decision.should_suppress_contact ? "paused" : "active",
        last_inbound_at: event.created_at,
        conversation_stage: decision.lifecycle_stage || null,
        __suppressions: optedOut
          ? [{ id: `thr-${event.id}`, suppression_reason: "stop", is_active: true }]
          : [],
      };
    } catch (error) {
      threaded.exceptions += 1;
    }
  }
}

// ── 4. Adversarial corpus with expected-label assertions ──
const adversarial = {
  total: 0,
  terminal: 0,
  exceptions: 0,
  intent_expected: 0,
  intent_pass: 0,
  disposition_expected: 0,
  disposition_pass: 0,
  re_engagement_expected: 0,
  re_engagement_pass: 0,
  suppression_cases: 0,
  suppression_safe: 0,
  state_transition_expected: 0,
  state_transition_pass: 0,
  failures: [],
};

for (const test_case of ADVERSARIAL_INBOUND_CASES) {
  adversarial.total += 1;
  const expected = test_case.expected || {};
  const result = await replayInboundCase(test_case);
  if (result.disposition) adversarial.terminal += 1;
  if (!result.ok) adversarial.exceptions += 1;
  // Duplicate/empty cases terminate before classification; assert their
  // intent expectation via the classifier directly, as the coverage test does.
  let intent = result.classification?.primary_intent || null;
  if (!intent && (test_case.message_body || "").trim()) {
    const direct = await classify(test_case.message_body, null, { heuristicOnly: true });
    intent = direct?.primary_intent || "unclear";
  }
  const fail = (kind, expectedValue, actual) =>
    adversarial.failures.push({ case_id: test_case.case_id, kind, expected: expectedValue, actual });

  if (Array.isArray(expected.intent_any_of) && expected.intent_any_of.length) {
    adversarial.intent_expected += 1;
    if (expected.intent_any_of.includes(intent || "unclear")) adversarial.intent_pass += 1;
    else fail("intent", expected.intent_any_of, intent);
  }
  if (Array.isArray(expected.disposition_any_of) && expected.disposition_any_of.length) {
    adversarial.disposition_expected += 1;
    if (expected.disposition_any_of.includes(result.disposition)) adversarial.disposition_pass += 1;
    else fail("disposition", expected.disposition_any_of, result.disposition);
  }
  if (typeof expected.re_engagement_expected === "boolean" && expected.re_engagement_expected) {
    adversarial.re_engagement_expected += 1;
    if (result.precedence?.re_engagement_detected === true) adversarial.re_engagement_pass += 1;
    else fail("re_engagement", true, false);
  }
  if (expected.must_not_auto_reply === true) {
    adversarial.suppression_cases += 1;
    if (result.detail?.should_queue_reply !== true) adversarial.suppression_safe += 1;
    else fail("suppression", "must_not_auto_reply", "would_reply");
  }
  if (typeof expected.supersedes_prior_state === "boolean") {
    adversarial.state_transition_expected += 1;
    const superseded = result.precedence?.supersedes_prior_state === true;
    if (superseded === expected.supersedes_prior_state) adversarial.state_transition_pass += 1;
    else fail("state_transition", expected.supersedes_prior_state, superseded);
  }
}

// ── 5. Scripted golden sequences (state carried turn-to-turn, live shape) ──
const goldenSequences = [
  {
    name: "re_engagement_after_decline",
    turns: [
      { body: "Not interested.", expect: { disposition_any_of: ["no_reply_required", "suppressed_policy"] } },
      {
        body: "Are you still interested in buying?",
        expect: { re_engagement: true, supersedes: true, would_reply_or_review: true },
      },
    ],
  },
  {
    name: "reversal_after_interest",
    turns: [
      { body: "Yes I might sell, make me an offer." },
      {
        body: "Actually no, not interested anymore.",
        expect: { supersedes: true, no_offer_stage: true, paused: true },
      },
    ],
  },
  {
    name: "stop_then_seller_initiated",
    turns: [
      { body: "STOP" },
      { body: "Hey are you still buying houses?", expect: { human_review: true, no_auto_reply: true } },
    ],
  },
  {
    name: "need_time_follow_through",
    turns: [
      { body: "Give me a couple weeks to think about it." },
      { body: "Ok I thought about it, let's talk numbers.", expect: { would_reply_or_review: true } },
    ],
  },
];

const golden = { sequences: goldenSequences.length, passed: 0, failures: [] };
for (const sequence of goldenSequences) {
  let summary = null;
  let optedOut = false;
  let sequenceOk = true;
  for (const turn of sequence.turns) {
    const received = "2026-07-02T00:00:00.000Z";
    const { classification, execution, disposition } = await replayTurnWithContext(
      turn.body,
      summary,
      received
    );
    const decision = execution?.automation_decision || {};
    const precedence = decision.latest_intent_precedence || null;
    const expect = turn.expect || {};
    const problems = [];
    if (expect.disposition_any_of && !expect.disposition_any_of.includes(disposition))
      problems.push(`disposition=${disposition}`);
    if (expect.re_engagement && precedence?.re_engagement_detected !== true)
      problems.push("no re_engagement");
    if (expect.supersedes && precedence?.supersedes_prior_state !== true)
      problems.push("no supersession");
    if (expect.would_reply_or_review && !(decision.should_queue_reply || decision.should_mark_human_review))
      problems.push("no reply/review");
    if (expect.human_review && decision.should_mark_human_review !== true)
      problems.push("no human_review");
    if (expect.no_auto_reply && decision.should_queue_reply === true)
      problems.push("auto-replied after STOP");
    if (
      expect.paused &&
      decision.should_suppress_contact !== true &&
      precedence?.state_patch?.automation !== "pause" &&
      precedence?.state_patch?.operational_status !== "paused"
    )
      problems.push("not paused");
    if (expect.no_offer_stage && String(decision.lifecycle_stage || "").includes("offer_interest"))
      problems.push(`advanced to ${decision.lifecycle_stage}`);
    if (problems.length) {
      sequenceOk = false;
      golden.failures.push({ sequence: sequence.name, body_sha256: digest(turn.body), problems });
    }
    if (classification?.primary_intent === "opt_out") optedOut = true;
    summary = {
      disposition: decision.disposition || null,
      last_intent: classification?.primary_intent || null,
      automation_status: decision.should_suppress_contact ? "paused" : "active",
      last_inbound_at: received,
      conversation_stage: decision.lifecycle_stage || null,
      __suppressions: optedOut
        ? [{ id: "golden-stop", suppression_reason: "stop", is_active: true }]
        : [],
    };
  }
  if (sequenceOk) golden.passed += 1;
}

// ── 6. Report (bodies redacted: digests + lengths only) ──
bulk.latencies.sort((a, b) => a - b);
const p = (q) => bulk.latencies[Math.min(bulk.latencies.length - 1, Math.floor(q * bulk.latencies.length))] ?? 0;
const report = {
  generated_at: new Date().toISOString(),
  privacy: "seller message bodies redacted; sha256 prefixes only",
  corpus: {
    fetched: events.length,
    replayed: bulk.total,
    internal_skipped: bulk.internal_skipped,
    window: { oldest: events[0]?.created_at || null, newest: events.at(-1)?.created_at || null },
  },
  bulk_metrics: {
    terminal_disposition_coverage: pct(bulk.terminal, bulk.total),
    exceptions: bulk.exceptions,
    silent_drops: bulk.silent_drops,
    would_reply: bulk.would_reply,
    human_review_rate: pct(bulk.human_review, bulk.total),
    low_confidence_rate: pct(bulk.low_confidence, bulk.total),
    intent_agreement_vs_historical: pct(bulk.intent_agree, bulk.intent_compared),
    intent_compared: bulk.intent_compared,
    suppression_violations: bulk.suppression_violations,
    disposition_histogram: bulk.disposition_histogram,
    latency_ms: { p50: p(0.5), p95: p(0.95) },
  },
  strata: {
    by_intent: bulk.by_intent,
    by_language: bulk.by_language,
    by_length_bucket: bulk.by_length_bucket,
    by_thread_age_bucket: bulk.by_thread_age_bucket,
    by_market_proxy_area_code: bulk.by_market_proxy,
  },
  threaded_state_carry: threaded,
  adversarial,
  golden,
  disagreement_samples: bulk.disagreement_samples,
};

writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, disagreement_samples: `${bulk.disagreement_samples.length} (in file)` }, null, 2));
console.log(`\nReport written to ${outFile} (redacted).`);
