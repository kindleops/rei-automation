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
const { scoreConversationBehavior } = await import(
  "../../src/lib/domain/seller-flow/conversation-behavior-scoring.js"
);
const { generateConstrainedReply, validateGeneratedReply } = await import(
  "../../src/lib/domain/seller-flow/natural-response-engine.js"
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
    .order("id", { ascending: true })
    .range(fromIdx, fromIdx + PAGE - 1);
  if (error) {
    console.error("load failed:", error.message);
    process.exit(1);
  }
  events.push(...(data || []));
  if (!data || data.length < PAGE) break;
}
console.log(`Fetched ${events.length} historical inbound events (full corpus, read-only).`);

// ── 1.5 HTTP receipts + DATABASE-BACKED idempotency simulation ──
// webhook_log holds one row per raw HTTP delivery (including provider
// retries), so it is the receipt stream the claim contract would have seen.
// Only sid + timestamps are fetched — no payloads, no bodies, no PII.
// When INBOUND_REPLAY_CLAIM_DB_URL is set (a LOCAL scratch Postgres with the
// claim migrations applied — never production), every receipt is replayed
// through the REAL public.claim_inbound_processing/complete_inbound_processing
// functions and the outcome distribution is reported.
const receipts = [];
for (let fromIdx = 0; ; fromIdx += PAGE) {
  // Two writer generations: historical rows carry only event_type='inbound'
  // (direction/provider columns are null); current rows set direction too.
  const { data, error } = await supabase
    .from("webhook_log")
    .select("id,provider_message_sid,created_at,event_type")
    .or("event_type.eq.inbound,direction.eq.inbound")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(fromIdx, fromIdx + PAGE - 1);
  if (error) {
    console.error("webhook_log load failed (continuing without receipts):", error.message);
    break;
  }
  receipts.push(...(data || []));
  if (!data || data.length < PAGE) break;
}

const idempotency_sim = {
  http_receipts_total: receipts.length,
  receipts_with_sid: 0,
  receipts_without_sid: 0,
  unique_sid_receipts: 0,
  duplicate_deliveries: 0,
  db_backed: false,
  claim_outcomes: {},
  claimed_events: 0,
  completed_events: 0,
  claim_invariant_violations: [],
};
{
  const seen_sids = new Map();
  for (const receipt of receipts) {
    const sid = String(receipt.provider_message_sid || "").trim();
    if (!sid) {
      idempotency_sim.receipts_without_sid += 1;
      continue;
    }
    idempotency_sim.receipts_with_sid += 1;
    seen_sids.set(sid, (seen_sids.get(sid) || 0) + 1);
  }
  idempotency_sim.unique_sid_receipts = seen_sids.size;
  idempotency_sim.duplicate_deliveries =
    idempotency_sim.receipts_with_sid - seen_sids.size;
}

const CLAIM_DB_URL = process.env.INBOUND_REPLAY_CLAIM_DB_URL || "";
if (CLAIM_DB_URL && /supabase\.co|prod/i.test(CLAIM_DB_URL)) {
  console.error("Refusing to run the claim simulation against a production-looking URL.");
  process.exit(1);
}
if (CLAIM_DB_URL && receipts.length) {
  const { default: pgPkg } = await import("pg");
  const pool = new pgPkg.Pool({ connectionString: CLAIM_DB_URL, max: 4 });
  const run_ns = `replay:${Date.now()}`;
  try {
    for (const receipt of receipts) {
      const sid = String(receipt.provider_message_sid || "").trim();
      // No-SID receipts degrade to per-receipt keys in production (receipt
      // hint in the hash) — simulate them as singleton claims keyed by the
      // webhook_log row id.
      const key = sid ? `${run_ns}:sid:${sid}` : `${run_ns}:nosid:${receipt.id}`;
      const { rows } = await pool.query(
        `SELECT public.claim_inbound_processing($1, $2, NULL, NULL, NULL, NULL, 0, $3) AS r`,
        [key, sid || null, receipt.created_at || new Date().toISOString()]
      );
      const claim = rows[0].r;
      const outcome = claim?.outcome || "error";
      idempotency_sim.claim_outcomes[outcome] =
        (idempotency_sim.claim_outcomes[outcome] || 0) + 1;
      if (outcome === "claimed_new") {
        idempotency_sim.claimed_events += 1;
        const { rows: done } = await pool.query(
          `SELECT public.complete_inbound_processing($1, $2, 'no_reply_required') AS r`,
          [key, claim.processing_run_id]
        );
        if (done[0].r?.ok === true) idempotency_sim.completed_events += 1;
        else
          idempotency_sim.claim_invariant_violations.push({
            key_suffix: key.slice(-24),
            reason: done[0].r?.reason || "complete_failed",
          });
      } else if (outcome !== "duplicate_completed") {
        // With sequential replay every non-first delivery must observe the
        // completed row; anything else is a contract violation.
        idempotency_sim.claim_invariant_violations.push({
          key_suffix: key.slice(-24),
          outcome,
        });
      }
    }
    idempotency_sim.db_backed = true;
    await pool.query(
      `DELETE FROM public.inbound_processing_ledger WHERE idempotency_key LIKE $1`,
      [`${run_ns}:%`]
    );
  } finally {
    await pool.end();
  }
  console.log(
    `Claim simulation (real SQL functions): ${idempotency_sim.claimed_events} claimed, ` +
      `${idempotency_sim.claim_outcomes.duplicate_completed || 0} duplicate_completed, ` +
      `${idempotency_sim.claim_invariant_violations.length} violations.`
  );
} else {
  console.log(
    "Claim simulation skipped (set INBOUND_REPLAY_CLAIM_DB_URL to a local scratch Postgres to enable)."
  );
}

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
  // Behavioral scoring layer (deterministic; model assist absent by design)
  scored_events: 0,
  scoring_exceptions: 0,
  score_value_counts: {},
  score_insufficient_evidence: {},
  // Compound-intent preservation
  compound_multi_intent_events: 0,
  compound_marker_events: 0,
  // Policy self-consistency + wrong-number safety
  reply_policy_consistent: 0,
  reply_policy_inconsistent: [],
  wrong_number_violations: [],
  // Stratified manual-inspection samples (ids + digests only)
  manual_samples: {},
};

const MANUAL_SAMPLE_CAP = 10;
function collectManualSample(category, event, replayIntent) {
  const bucket = (bulk.manual_samples[category] ||= []);
  if (bucket.length >= MANUAL_SAMPLE_CAP) return;
  bucket.push({
    event_id: event.id,
    body_sha256: digest(event.message_body || ""),
    body_length: (event.message_body || "").length,
    replayed_intent: replayIntent,
  });
}
const LEGAL_INTENTS = new Set([
  "title_issue",
  "lien_tax_issue",
  "bankruptcy_disclosed",
  "trust_ownership",
  "llc_corporation",
]);
const PRICING_INTENTS = new Set(["asking_price_provided", "asks_offer"]);

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

  // Wrong-number safety: a historically wrong-number event must never replay
  // to a would-reply outcome either.
  if (
    String(event.detected_intent || "").toLowerCase() === "wrong_number" &&
    result.detail?.should_queue_reply
  ) {
    bulk.wrong_number_violations.push({
      event_id: event.id,
      body_sha256: digest(body),
      replay_intent: replayIntent,
    });
  }

  // Reply-policy self-consistency: a suppressed/review disposition must never
  // coexist with a queued reply, and a would-reply outcome must carry one.
  {
    const queued = result.detail?.should_queue_reply === true;
    const suppressed_or_review =
      String(disposition || "").startsWith("suppressed_") ||
      disposition === "human_review_required" ||
      disposition === "no_reply_required";
    const consistent = queued ? !suppressed_or_review : true;
    if (consistent) bulk.reply_policy_consistent += 1;
    else if (bulk.reply_policy_inconsistent.length < 50) {
      bulk.reply_policy_inconsistent.push({
        event_id: event.id,
        disposition,
        body_sha256: digest(body),
      });
    }
  }

  // Compound-intent preservation coverage.
  const secondary = result.classification?.secondary_intents || [];
  if (secondary.length > 0) bulk.compound_multi_intent_events += 1;
  if (
    secondary.includes("compound_intent") ||
    (result.classification?.matched_intents || []).includes("compound_intent")
  ) {
    bulk.compound_marker_events += 1;
  }

  // Behavioral scoring layer (deterministic evidence only; never length-alone).
  try {
    const scores = scoreConversationBehavior({
      raw_text: body,
      classification: result.classification || null,
    });
    bulk.scored_events += 1;
    for (const [dimension, score] of Object.entries(scores?.scores || scores || {})) {
      if (!score || typeof score !== "object") continue;
      if (score.value != null) bump(bulk.score_value_counts, dimension);
      else if (score.fallback_reason === "insufficient_evidence")
        bump(bulk.score_insufficient_evidence, dimension);
    }
  } catch {
    bulk.scoring_exceptions += 1;
  }

  // Stratified manual-inspection sample collection (ids + digests only).
  const lang = result.classification?.language || "unknown";
  if (lang === "Spanish") collectManualSample("spanish", event, replayIntent);
  else if (lang === "English") collectManualSample("english", event, replayIntent);
  if (body.length <= 5) collectManualSample("short_replies", event, replayIntent);
  if (body.length > 60) collectManualSample("long_replies", event, replayIntent);
  if ((NOW - Date.parse(event.created_at)) / 86_400_000 > 60)
    collectManualSample("old_thread_re_engagement", event, replayIntent);
  if (replayIntent === "probate" || secondary.includes("probate") || LEGAL_INTENTS.has(replayIntent))
    collectManualSample("probate_estate_legal", event, replayIntent);
  if (replayIntent === "trust_ownership" || replayIntent === "llc_corporation")
    collectManualSample("authority", event, replayIntent);
  if (PRICING_INTENTS.has(replayIntent) || result.classification?.price_parse?.amount)
    collectManualSample("pricing", event, replayIntent);
  if (replayIntent === "hostile_or_legal") collectManualSample("hostile", event, replayIntent);
  if (replayIntent === "property_correction" || replayIntent === "wrong_number")
    collectManualSample("property_mismatch", event, replayIntent);
  if (secondary.length >= 2) collectManualSample("compound", event, replayIntent);

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
      if (
        classification?.primary_intent === "opt_out" ||
        String(classification?.compliance_flag || "").includes("stop")
      ) {
        optedOut = true;
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

// ── 4.5 Natural-response validation, SHADOW mode with RECORDED model output ──
// Never calls a provider. Each critical intent family runs through the real
// generateConstrainedReply + validator twice: once with a recorded compliant
// model output (must pass validation) and once with a recorded hostile output
// (invented $/facts — must be rejected and fall back to the deterministic
// template). This measures the validator, not a model.
const NATURAL_SHADOW_FAMILIES = [
  { family: "ownership_opener", objective: "Confirm ownership and gauge interest", text: "Thanks for confirming! Would you consider an offer on the property?" },
  { family: "interest", objective: "Advance an interested seller", text: "Great to hear. What price range were you hoping for?" },
  { family: "asking_price", objective: "Acknowledge the asking price", text: "Appreciate you sharing that. We'll review and follow up shortly." },
  { family: "need_time", objective: "Respect a delay request", text: "No problem at all — I'll check back with you in a couple of weeks." },
  { family: "re_engagement", objective: "Re-engage a returning seller", text: "Yes, we're still interested! Want me to put together an updated offer?", reEngagement: true },
  { family: "probate_authority", objective: "Clarify estate authority", text: "Thanks for letting me know. Who would be the right person to speak with about the estate?" },
  { family: "agent_involved", objective: "Acknowledge representation", text: "Understood — feel free to have your agent reach out anytime." },
  { family: "price_negotiation", objective: "Continue the price conversation", text: "Understood. Is there flexibility if we can close quickly?" },
  { family: "spanish", objective: "Continue in Spanish", language: "Spanish", languageConfidence: 0.95, text: "¡Gracias por responder! ¿Le interesa recibir una oferta por su propiedad?" },
  { family: "callback_request", objective: "Confirm a call", text: "Absolutely — what time works best for a quick call?" },
  { family: "email_request", objective: "Confirm email follow-up", text: "Sure — I'll send the details over by email." },
  { family: "condition_disclosure", objective: "Acknowledge condition", text: "Thanks for the details — we buy as-is, so no repairs needed on your end." },
];
const natural_shadow = {
  families: NATURAL_SHADOW_FAMILIES.length,
  generated: 0,
  validation_passed: 0,
  hostile_rejected: 0,
  deterministic_fallbacks: 0,
  suppressed_no_generation: 0,
  failures: [],
};
for (const scenario of NATURAL_SHADOW_FAMILIES) {
  const base = {
    objective: scenario.objective,
    deterministicText: "Thanks for the reply — we'll be in touch shortly.",
    allowedFacts: { our_role: "local homebuyer" },
    prohibitedClaims: ["guaranteed", "licensed agent", "attorney"],
    language: scenario.language || "English",
    languageConfidence: scenario.languageConfidence ?? 0,
    maxLength: 320,
    reEngagement: Boolean(scenario.reEngagement),
  };
  // Recorded model outputs use the upgraded client contract: the model call
  // resolves { output, provider, model } — output is the parsed JSON object.
  const compliant = await generateConstrainedReply({
    ...base,
    modelCall: async () => ({
      output: {
        response_text: scenario.text,
        confidence: 0.9,
        facts_used: [],
        questions_answered: [],
      },
      provider: "recorded",
      model: "recorded-compliant-v1",
    }),
  });
  natural_shadow.generated += 1;
  if (compliant.ok && compliant.source !== "deterministic_template" && !compliant.fallback_reason) {
    natural_shadow.validation_passed += 1;
  } else {
    natural_shadow.deterministic_fallbacks += 1;
    natural_shadow.failures.push({
      family: scenario.family,
      kind: "compliant_output_rejected",
      fallback_reason: compliant.fallback_reason || null,
    });
  }
  const hostile = await generateConstrainedReply({
    ...base,
    modelCall: async () => ({
      output: {
        response_text: "We guarantee $185,000 cash and can close in 5 days!",
        confidence: 0.99,
        facts_used: [],
        questions_answered: [],
      },
      provider: "recorded",
      model: "recorded-hostile-v1",
    }),
  });
  if (
    hostile.fallback_reason &&
    hostile.response_text === base.deterministicText
  ) {
    natural_shadow.hostile_rejected += 1;
    natural_shadow.deterministic_fallbacks += 1;
  } else {
    natural_shadow.failures.push({ family: scenario.family, kind: "hostile_output_survived" });
  }
}
// Suppression hard-gate: opt-out / wrong-number / post-STOP must not generate.
for (const reason of ["opt_out", "wrong_number", "seller_initiated_after_stop"]) {
  const suppressed = await generateConstrainedReply({
    objective: "should never run",
    deterministicText: "template",
    suppression: { active: true, reason },
    modelCall: async () => {
      throw new Error("model must not be invoked under suppression");
    },
  });
  if (suppressed.source === "suppressed_no_reply") natural_shadow.suppressed_no_generation += 1;
  else natural_shadow.failures.push({ family: reason, kind: "suppression_gate_breached" });
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
  http_receipts_and_idempotency: idempotency_sim,
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
    wrong_number_violations: bulk.wrong_number_violations,
    reply_policy_accuracy: pct(bulk.reply_policy_consistent, bulk.total),
    reply_policy_inconsistent: bulk.reply_policy_inconsistent,
    compound_multi_intent_events: bulk.compound_multi_intent_events,
    compound_marker_events: bulk.compound_marker_events,
    disposition_histogram: bulk.disposition_histogram,
    latency_ms: { p50: p(0.5), p95: p(0.95) },
  },
  behavior_scoring: {
    scored_events: bulk.scored_events,
    scoring_exceptions: bulk.scoring_exceptions,
    dimensions_with_values: bulk.score_value_counts,
    insufficient_evidence_counts: bulk.score_insufficient_evidence,
  },
  natural_response_shadow: natural_shadow,
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
  manual_inspection_samples: bulk.manual_samples,
  disagreement_samples: bulk.disagreement_samples,
};

writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, disagreement_samples: `${bulk.disagreement_samples.length} (in file)` }, null, 2));
console.log(`\nReport written to ${outFile} (redacted).`);
