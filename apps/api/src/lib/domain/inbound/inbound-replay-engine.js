// ─── inbound-replay-engine.js ────────────────────────────────────────────────
// No-send replay of one inbound event through the LIVE decision engine:
// classify (deterministic heuristics only) → executeInboundAutomationDecision
// (dry run) → latest-intent precedence → canonical terminal disposition.
// Used by the adversarial-corpus coverage test and the historical replay
// harness (scripts/ops/inbound-replay-harness.mjs). Never inserts queue rows,
// never sends, never mutates state: the injected Supabase double serves prior
// suppression state and swallows writes.

import { classify } from "@/lib/domain/classification/classify.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { TERMINAL_DISPOSITIONS } from "@/lib/domain/inbound/terminal-disposition.js";
import { buildInboundAnalysis } from "@/lib/domain/inbound/inbound-analysis-contract.js";

export const REPLAY_ENGINE_VERSION = "inbound_replay_engine_v1";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Read-only Supabase double: serves the case's prior suppression rows and
 * returns empty results for everything else. Update chains resolve without
 * touching anything.
 */
export function makeReplaySupabase({ suppressions = [] } = {}) {
  function makeChain(table) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      gte: () => chain,
      lte: () => chain,
      lt: () => chain,
      or: () => chain,
      order: () => chain,
      update: () => chain,
      insert: () => chain,
      upsert: () => chain,
      limit: async () => ({
        data: table === "sms_suppression_list" ? suppressions : [],
        error: null,
      }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve) => resolve({ data: [], error: null }),
    };
    return chain;
  }
  return { from: (table) => makeChain(table) };
}

/**
 * Map a dry-run execution to the canonical terminal disposition. Replay-side
 * counterpart of resolveInboundTerminalDisposition (which maps live webhook
 * results): in replay the DECISION is authoritative because dry-run never
 * actually queues.
 */
export function resolveReplayDisposition(execution, classification = {}) {
  const decision = execution?.automation_decision || {};
  const audit = lower(execution?.audit_reason || decision.audit_reason);
  const primary_intent = lower(classification.primary_intent);
  const compliance_flag = lower(classification.compliance_flag);

  if (audit === "seller_initiated_after_stop") {
    return TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED;
  }
  if (decision.should_suppress_contact === true || audit.includes("suppress")) {
    if (compliance_flag.includes("stop") || primary_intent === "opt_out") {
      return TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT;
    }
    if (primary_intent === "wrong_number" || lower(decision.suppression_reason) === "wrong_number") {
      return TERMINAL_DISPOSITIONS.SUPPRESSED_WRONG_NUMBER;
    }
    return TERMINAL_DISPOSITIONS.SUPPRESSED_POLICY;
  }
  if (decision.should_mark_human_review === true) {
    return TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED;
  }
  if (decision.should_queue_reply === true) {
    return TERMINAL_DISPOSITIONS.REPLY_SENT;
  }
  return TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED;
}

/**
 * Replay one case. Returns { ok, disposition, classification, execution,
 * precedence, detail } and NEVER throws: an engine exception is itself a
 * finding (ok:false, disposition failed_retriable) so the coverage metric can
 * count it instead of the harness dying.
 */
export async function replayInboundCase(test_case = {}, deps = {}) {
  const started = Date.now();
  const body = clean(test_case.message_body);
  const prior = test_case.prior_context || {};
  const quirks = test_case.provider_quirks || {};

  try {
    if (quirks.duplicate_of) {
      // Durable dedupe is enforced by the idempotency layer before the
      // decision engine; replay records the contract outcome.
      return {
        ok: true,
        disposition: TERMINAL_DISPOSITIONS.DUPLICATE_IGNORED,
        detail: { duplicate_of: quirks.duplicate_of },
        latency_ms: Date.now() - started,
      };
    }

    if (!body) {
      // Empty or media-only inbound: terminal human review, mirroring the
      // live handler's empty_inbound_body exit mapping.
      return {
        ok: true,
        disposition: TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED,
        detail: {
          empty_or_media_only: true,
          media_count: Array.isArray(test_case.media_urls) ? test_case.media_urls.length : 0,
        },
        latency_ms: Date.now() - started,
      };
    }

    // classify(message, brain_item, options) — heuristicOnly must ride in the
    // options slot so replay stays deterministic (no AI-assist attempts).
    const classification = await (deps.classify || classify)(body, null, { heuristicOnly: true });

    const suppressions = prior.suppressed
      ? [
          {
            id: "replay-suppression",
            suppression_reason: prior.suppression_reason || "unknown",
            is_active: true,
          },
        ]
      : [];

    // Out-of-order arrival: model the message as predating the thread's
    // newest recorded inbound so send-time precedence (not arrival order)
    // decides supersession.
    const out_of_order = quirks.out_of_order === true;
    const execution = await (deps.executeInboundAutomationDecision ||
      executeInboundAutomationDecision)({
      message: body,
      threadKey: "+16125550100",
      inboundFrom: "+16125550100",
      inboundTo: "+16125550001",
      ownerId: "replay_owner",
      inboundReceivedAt: out_of_order ? "2026-07-01T00:00:00.000Z" : "2026-07-02T00:00:00.000Z",
      latestThreadContext: {
        disposition: prior.prior_disposition || null,
        last_intent: prior.prior_intent || null,
        last_inbound_at: out_of_order ? "2026-07-01T12:00:00.000Z" : null,
      },
      classification,
      dryRun: true,
      autoReplyMode: "dry_run",
      supabaseClient: makeReplaySupabase({ suppressions }),
    });

    const disposition = resolveReplayDisposition(execution, classification);
    const precedence = execution?.automation_decision?.latest_intent_precedence || null;
    return {
      ok: true,
      disposition,
      classification,
      execution,
      precedence,
      analysis: buildInboundAnalysis({
        raw_text: body,
        classification,
        precedence,
        decision: execution?.automation_decision || null,
      }),
      detail: {
        audit_reason: execution?.audit_reason || null,
        should_queue_reply: execution?.automation_decision?.should_queue_reply === true,
      },
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      disposition: TERMINAL_DISPOSITIONS.FAILED_RETRIABLE,
      detail: { engine_exception: error?.message || "unknown" },
      latency_ms: Date.now() - started,
    };
  }
}

export default replayInboundCase;
