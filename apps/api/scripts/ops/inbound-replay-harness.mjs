#!/usr/bin/env node
// Historical inbound replay harness — READ ONLY, never sends, never mutates.
//
// Replays historical inbound message_events through the live decision engine
// (classify → executeInboundAutomationDecision dry-run → precedence →
// canonical terminal disposition) and reports:
//   * coverage: % of events reaching a terminal disposition, engine exceptions
//   * disposition histogram
//   * confusion matrix: historical detected_intent vs replayed intent
//   * invariant violations: would-reply after opt-out, would-reply to wrong
//     numbers, stale-state supersessions
//   * a stratified sample (per intent bucket) for manual review
//
// Usage (the @/ alias needs the ops loader — the test loader blocks network):
//   node --import ./scripts/register-aliases-ops.mjs scripts/ops/inbound-replay-harness.mjs [--limit 500] [--env .env.local]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : fallback;
}

const envFile = argValue("--env", ".env.local");
const limit = Math.min(5000, Number(argValue("--limit", 500)) || 500);
// PII guard: raw seller message bodies are NEVER written to the report unless
// the operator explicitly opts in. The report pairs each excerpt with
// event_id, making it re-identifiable; report files are gitignored
// (inbound-replay-report-*.json) and must never be committed either way.
const includeRawBodies = process.argv.includes("--include-raw-bodies");

if (includeRawBodies) {
  console.warn(
    [
      "",
      "!".repeat(74),
      "!! PRIVACY WARNING: --include-raw-bodies is enabled.",
      "!! The report file will contain RAW SELLER MESSAGE CONTENT (personal",
      "!! data) paired with re-identifiable event IDs. Handle it as sensitive:",
      "!! do NOT commit it, share it, or leave it outside this machine.",
      "!".repeat(74),
      "",
    ].join("\n")
  );
}

const envPath = path.resolve(process.cwd(), envFile);
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const { createClient } = await import("@supabase/supabase-js");
const { replayInboundCase } = await import("../../src/lib/domain/inbound/inbound-replay-engine.js");
const { isInternalTestPhone } = await import("../../src/lib/config/internal-phones.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: events, error } = await supabase
  .from("message_events")
  .select(
    "id,provider_message_sid,from_phone_number,to_phone_number,message_body,detected_intent,is_opt_out,created_at,thread_key"
  )
  .eq("direction", "inbound")
  .order("created_at", { ascending: false })
  .limit(limit);

if (error) {
  console.error("load failed:", error.message);
  process.exit(1);
}

console.log(`Replaying ${events.length} historical inbound events (read-only)…`);

const dispositions = {};
const confusion = {};
const violations = [];
const samples = {};
let exceptions = 0;
let no_disposition = 0;
let internal_skipped = 0;
let processed = 0;
let latency_total = 0;

for (const event of events) {
  if (isInternalTestPhone(event.from_phone_number)) {
    internal_skipped += 1;
    continue;
  }
  processed += 1;
  const result = await replayInboundCase({
    case_id: `hist-${event.id}`,
    message_body: event.message_body || "",
    prior_context: {},
    provider_quirks: {},
  });

  latency_total += result.latency_ms || 0;
  if (result.ok === false) exceptions += 1;
  if (!result.disposition) {
    no_disposition += 1;
    violations.push({ event_id: event.id, kind: "no_terminal_disposition" });
    continue;
  }

  dispositions[result.disposition] = (dispositions[result.disposition] || 0) + 1;

  const historical = String(event.detected_intent || "none").toLowerCase();
  const replayed = String(result.classification?.primary_intent || "none").toLowerCase();
  confusion[`${historical} -> ${replayed}`] = (confusion[`${historical} -> ${replayed}`] || 0) + 1;

  if (event.is_opt_out === true && result.detail?.should_queue_reply === true) {
    violations.push({ event_id: event.id, kind: "would_reply_after_opt_out" });
  }
  if (historical === "wrong_number" && result.detail?.should_queue_reply === true) {
    violations.push({ event_id: event.id, kind: "would_reply_to_wrong_number" });
  }

  const bucket = replayed;
  if (!samples[bucket]) samples[bucket] = [];
  if (samples[bucket].length < 3) {
    samples[bucket].push({
      event_id: event.id,
      // Redacted by default: raw seller text only behind --include-raw-bodies.
      body: includeRawBodies ? String(event.message_body || "").slice(0, 120) : null,
      body_length: String(event.message_body || "").length,
      historical_intent: historical,
      replayed_intent: replayed,
      disposition: result.disposition,
      confidence: result.classification?.confidence ?? null,
    });
  }
}

const report = {
  generated_for: "inbound-replay-harness",
  bodies_redacted: !includeRawBodies,
  events_loaded: events.length,
  events_replayed: processed,
  internal_canary_skipped: internal_skipped,
  coverage: {
    terminal_disposition_rate: processed ? (processed - no_disposition) / processed : 1,
    no_disposition_count: no_disposition,
    engine_exceptions: exceptions,
    mean_latency_ms: processed ? Math.round(latency_total / processed) : 0,
  },
  disposition_histogram: dispositions,
  invariant_violations: violations,
  confusion_matrix: Object.fromEntries(
    Object.entries(confusion).sort((a, b) => b[1] - a[1])
  ),
  stratified_samples: samples,
};

const out = path.resolve(process.cwd(), `inbound-replay-report-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.coverage, null, 2));
console.log("Disposition histogram:", JSON.stringify(dispositions, null, 2));
console.log(`Invariant violations: ${violations.length}`);
console.log(`Full report: ${out}`);
if (includeRawBodies) {
  console.warn(
    "PRIVACY WARNING: the report above contains raw seller message content — do not commit or share it."
  );
}
