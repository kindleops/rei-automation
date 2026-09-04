// ─── coverage-graph-audit.js ─────────────────────────────────────────────────
// Phase 14: executable automation coverage-audit guard.
//
// This is the manual Phase 11 graph audit turned into a deterministic, CI-run
// assertion. It reuses the REAL production registries and decision functions
// (imported below) to build a plain data graph, then `auditCoverageGraph`
// walks that graph and reports any "reachable path with no destination":
//
//   1. intent with no route            5. follow-up use case with no candidate
//   2. route with no autonomous action 6. retryable send with no bounded recovery
//   3. immediate-send with no template 7. terminal outcome with no durable artifact
//   4. active stage with no follow-up  8. successful orchestration -> nothing
//
// Intentional terminal outcomes (STOP / DNC / wrong number / genuine terminal
// disposition / human review) are PRESERVED — they are covered destinations,
// not gaps.
//
// Design: `loadProductionCoverageGraph()` reads the real exported registries
// into a plain, serializable graph. `auditCoverageGraph(graph)` is a PURE
// function over that data — so the guard test can inject a graph with one node
// removed and prove the guard fails. There is no hand-written duplicate matrix:
// remove a real route/template/policy/terminal and the audit sees it.
//
// TEMPLATE-EXISTENCE BOUNDARY (honest): the broad sms_templates catalog lives
// in the database, not in version control (only the Tier-1 offer/accept seed +
// the code-level LOCAL_TEMPLATE_CANDIDATES are committed). CI cannot query the
// DB, so template checks are: (a) HARD — every immediate-send route / nurture
// intent must NAME >=1 candidate use case, and every required code-level
// fallback use case must exist in LOCAL_TEMPLATE_CANDIDATES; (b) REPORT — any
// candidate use case not in a committed source is surfaced as db_backed (not a
// failure, because absence cannot be proven in CI). A missing DB template is
// itself never a silent dead end — the live path degrades it to human review
// (see Phase 11), which is a durable artifact.

import { INTENT_PRIORITY } from "@/lib/domain/classification/classify.js";
import {
  INBOUND_INTENT_ONTOLOGY,
  normalizeToCanonicalIntent,
  getIntentDefinition,
} from "@/lib/domain/classification/inbound-intent-ontology.js";
import {
  ROUTE_PROFILES,
  REVIEW_ONLY_OBJECTIONS,
  CLARIFIER_INTENTS,
  LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { LOCAL_TEMPLATE_CANDIDATES } from "@/lib/domain/templates/local-template-registry.js";
import {
  FOLLOWUP_POLICY_BY_STAGE,
} from "@/lib/domain/seller-flow/followup-policy-registry.js";
import { LIFECYCLE_STAGE_ORDER } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { NURTURE_TEMPLATE_CANDIDATES } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { TERMINAL_DISPOSITION_SET, PENDING_DISPOSITION_SET } from "@/lib/domain/inbound/terminal-disposition.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import { deriveOperationalStatus } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";
import { OPERATIONAL_STATUS_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

// Terminal_hint values that represent an INTENTIONAL terminal outcome for which
// no autonomous reply is expected (STOP/DNC/wrong number/genuine no-reply).
export const INTENTIONAL_TERMINAL_HINTS = Object.freeze([
  "suppressed_opt_out",
  "suppressed_wrong_number",
  "suppressed_policy",
  "no_reply_required",
  "reply_deferred_compliance",
  "duplicate_ignored",
]);

const HUMAN_REVIEW_HINT = "human_review_required";

// Route next_action values that put a message on the wire immediately and so
// REQUIRE a template. (schedule_* actions defer to the follow-up scheduler,
// which resolves its template later and is covered by the nurture checks.)
export const IMMEDIATE_SEND_ACTIONS = Object.freeze(["queue_auto_reply", "send_message_now"]);

// A route "does nothing autonomously" when its action is absent or an explicit
// none. `do_not_reply` is NOT a no-op — it is a deliberate soft-close decision
// (e.g. not_interested: no immediate reply now, nurture follow-up later), a real
// autonomous outcome with a durable record. Everything else (queue reply,
// schedule follow-up, mark review, ...) is likewise a real autonomous action.
const NO_OP_ACTIONS = new Set(["none", "", null, undefined]);

// Routes that intentionally carry no template candidates because they re-render
// the CURRENT stage's message rather than select a new use case. Marked in the
// real registry by route_hint (data-driven, not a hand-kept name list): a
// language switch continues the active conversation in the new language.
const TEMPLATELESS_CONTINUITY_HINTS = new Set(["language_continuity"]);

// The representative provider failure classes the send path can produce. Each
// is exercised through the REAL classifier so the recovery table is derived,
// not asserted. (Numeric retry bound / same-body exhaustion is proven by the
// Phase 8 same-stage-transport-failover suite; here we require every class to
// yield a DEFINED, bounded queue disposition rather than an unhandled state.)
const REPRESENTATIVE_PROVIDER_ERRORS = [
  ["content_filter", { message: "Message blocked by content filter" }],
  ["recipient_opted_out", { message: "blocked", code: "21610" }],
  ["invalid_number", { message: "invalid 'to' phone number" }],
  ["transient_credit", { message: "account out of credit" }],
  ["unknown_transient", { message: "some transient glitch" }],
  // The canonical RETRY-SAFE class: the socket was refused, so no request left
  // this process and no SMS can exist. Without a transport case the graph could
  // not represent bounded retryable recovery at all.
  ["transport_connect_refused", { message: "fetch failed", cause: { code: "ECONNREFUSED" } }],
  // The canonical AMBIGUOUS class: a timeout after the request may have been
  // written. Must be terminal and non-retryable.
  ["transport_ambiguous_timeout", { name: "TimeoutError", message: "The operation was aborted due to timeout" }],
];

// Queue dispositions that represent a bounded, durable outcome of a send
// failure (a terminal record or a bounded re-queue). Anything outside this set
// (or null/undefined) is an unhandled send failure.
const BOUNDED_QUEUE_DISPOSITIONS = new Set([
  "failed",
  "invalid_number",
  "opted_out",
  "queued",
]);

function clean(v) {
  return String(v ?? "").trim();
}

/**
 * Read the real production registries into a plain, serializable coverage
 * graph. Everything here is imported from production modules — no values are
 * authored in this file — so the guard cannot drift from what production does.
 */
export function loadProductionCoverageGraph() {
  // Per-intent ontology facts (the intended handling for each producible label).
  const ontologyByIntent = {};
  for (const label of INTENT_PRIORITY) {
    const slug = normalizeToCanonicalIntent(label);
    const def = slug ? getIntentDefinition(slug) : null;
    ontologyByIntent[label] = def
      ? {
          slug,
          terminal_hint: def.terminal_hint || null,
          escalate: Boolean(def.reply_policy?.escalate_to_human),
          reply_required: Boolean(def.reply_policy?.reply_required),
        }
      : { slug: slug || null, terminal_hint: null, escalate: false, reply_required: false, missing: true };
  }

  // Route profiles → the fields the audit needs (action + template candidates).
  const routeProfiles = {};
  for (const [intent, profile] of Object.entries(ROUTE_PROFILES)) {
    routeProfiles[intent] = {
      next_action: profile.next_action || null,
      route_hint: profile.route_hint || null,
      template_use_case_candidates: Array.isArray(profile.template_use_case_candidates)
        ? [...profile.template_use_case_candidates]
        : [],
    };
  }

  // Follow-up policy per lifecycle stage.
  const followupPolicyByStage = {};
  for (const stage of LIFECYCLE_STAGE_ORDER) {
    const p = FOLLOWUP_POLICY_BY_STAGE[stage];
    followupPolicyByStage[stage] = p
      ? { present: true, enabled: Boolean(p.enabled), no_reply_delay_days: p.no_reply_delay_days ?? null }
      : { present: false };
  }

  // Nurture (follow-up use case) → candidate template use cases.
  const nurtureCandidates = {};
  for (const [intent, cands] of Object.entries(NURTURE_TEMPLATE_CANDIDATES)) {
    nurtureCandidates[intent] = Array.isArray(cands) ? [...cands] : [];
  }

  // Committed template use cases (the only CI-visible template sources).
  const localTemplateUseCases = [
    ...new Set(LOCAL_TEMPLATE_CANDIDATES.map((t) => clean(t.use_case)).filter(Boolean)),
  ];

  // Retry/recovery table, derived by exercising the REAL provider classifier.
  const failureRecovery = REPRESENTATIVE_PROVIDER_ERRORS.map(([label, err]) => {
    const c = classifyTextGridProviderError(err, {});
    return {
      label,
      failure_class: c.failure_class || null,
      is_terminal: Boolean(c.is_terminal),
      retryable: Boolean(c.retryable),
      queue_disposition: c.queue_disposition || null,
    };
  });

  return {
    intents: [...INTENT_PRIORITY],
    ontologyByIntent,
    routeProfiles,
    reviewOnlyIntents: [...REVIEW_ONLY_OBJECTIONS],
    clarifierIntents: [...CLARIFIER_INTENTS],
    stages: [...LIFECYCLE_STAGE_ORDER],
    followupPolicyByStage,
    nurtureCandidates,
    requiredLocalFallbackUseCases: [...LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES],
    localTemplateUseCases,
    terminalDispositions: [...TERMINAL_DISPOSITION_SET],
    pendingDispositions: [...PENDING_DISPOSITION_SET],
    failureRecovery,
    operationalStatuses: Object.values(OPERATIONAL_STATUS_CODES),
    // #8: a completely empty (no-op) decision must still derive a durable status.
    noopOperationalStatus: deriveOperationalStatus({}),
    ontologyIntentCount: Object.keys(INBOUND_INTENT_ONTOLOGY).length,
  };
}

/**
 * Pure coverage audit. Returns { ok, gaps, report }. `gaps` is empty when every
 * reachable path has a destination. `report.db_backed_template_use_cases` lists
 * candidate use cases that exist only in the DB (not a failure — see boundary
 * note above).
 */
export function auditCoverageGraph(graph = {}) {
  const gaps = [];
  const add = (code, node, detail) => gaps.push({ code, node, detail });

  const routeProfiles = graph.routeProfiles || {};
  const reviewOnly = new Set(graph.reviewOnlyIntents || []);
  const clarifier = new Set(graph.clarifierIntents || []);
  const intentionalTerminal = new Set(INTENTIONAL_TERMINAL_HINTS);
  const terminalDispositions = new Set(graph.terminalDispositions || []);
  const pendingDispositions = new Set(graph.pendingDispositions || []);
  const immediateSend = new Set(IMMEDIATE_SEND_ACTIONS);
  const localTemplates = new Set(graph.localTemplateUseCases || []);
  const operationalStatuses = new Set(graph.operationalStatuses || []);
  const db_backed = new Set();

  // ── 1) intent with no route + 7) terminal outcome durable ──────────────────
  for (const intent of graph.intents || []) {
    const onto = (graph.ontologyByIntent || {})[intent] || {};
    if (onto.missing || !onto.slug) {
      add("intent_no_ontology", intent, "producible intent has no ontology entry (classifier/ontology drift)");
      continue;
    }
    const hint = onto.terminal_hint;

    const coveredByRoute = Boolean(routeProfiles[intent]);
    const coveredByClarifier = clarifier.has(intent);
    const coveredByReview = reviewOnly.has(intent) || onto.escalate || hint === HUMAN_REVIEW_HINT;
    const coveredByTerminal = intentionalTerminal.has(hint);

    if (!coveredByRoute && !coveredByClarifier && !coveredByReview && !coveredByTerminal) {
      add("intent_no_route", intent, `intent (terminal_hint=${hint}) has no route, clarifier, review, or terminal destination`);
    }

    // 7) whatever terminal_hint the intent declares must be a real durable
    // disposition (terminal or a parked pending one), or the "outcome" names a
    // record that does not exist.
    if (hint && !terminalDispositions.has(hint) && !pendingDispositions.has(hint)) {
      add("terminal_hint_not_durable", intent, `terminal_hint '${hint}' is not in the terminal or pending disposition registries`);
    }
  }

  // ── 2) route with no autonomous action + 3) immediate-send with no template ─
  for (const [intent, profile] of Object.entries(routeProfiles)) {
    const action = profile.next_action;
    if (NO_OP_ACTIONS.has(action)) {
      add("route_no_action", intent, `route resolves to a no-op action (${action})`);
      continue;
    }
    if (immediateSend.has(action)) {
      const cands = profile.template_use_case_candidates || [];
      const isContinuity = TEMPLATELESS_CONTINUITY_HINTS.has(profile.route_hint);
      if (cands.length === 0 && !isContinuity) {
        add("immediate_send_no_template", intent, `immediate-send action '${action}' names zero template use cases`);
      }
      for (const uc of cands) {
        if (!localTemplates.has(uc)) db_backed.add(uc);
      }
    }
  }

  // ── 4) active stage with no follow-up policy ───────────────────────────────
  for (const stage of graph.stages || []) {
    const p = (graph.followupPolicyByStage || {})[stage];
    if (!p || p.present !== true) {
      add("stage_no_followup_policy", stage, "lifecycle stage has no follow-up policy entry");
      continue;
    }
    // An "active" (enabled) stage must additionally declare a real cadence.
    if (p.enabled && !(Number(p.no_reply_delay_days) > 0)) {
      add("active_stage_no_cadence", stage, "enabled follow-up stage has no positive no_reply_delay_days");
    }
  }

  // ── 5) follow-up use case with no eligible template candidate ───────────────
  for (const [intent, cands] of Object.entries(graph.nurtureCandidates || {})) {
    if (!Array.isArray(cands) || cands.length === 0) {
      add("followup_no_template", intent, "nurture follow-up intent names zero candidate use cases");
      continue;
    }
    for (const uc of cands) {
      if (!localTemplates.has(uc)) db_backed.add(uc);
    }
  }

  // Required code-level fallback templates must all exist in the committed
  // LOCAL_TEMPLATE_CANDIDATES registry (fully CI-verifiable, drift-proof).
  for (const uc of graph.requiredLocalFallbackUseCases || []) {
    if (!localTemplates.has(uc)) {
      add("local_fallback_missing", uc, "required negotiation use case has no committed LOCAL_TEMPLATE_CANDIDATES entry");
    }
  }

  // ── 6) retryable send with no bounded recovery path ────────────────────────
  for (const f of graph.failureRecovery || []) {
    const bounded = BOUNDED_QUEUE_DISPOSITIONS.has(f.queue_disposition);
    if (!bounded) {
      add("retryable_no_bounded_recovery", f.failure_class || f.label, `failure class resolves to an unbounded/undefined queue disposition (${f.queue_disposition})`);
      continue;
    }
    if (f.retryable && f.queue_disposition !== "queued") {
      add("retryable_no_bounded_recovery", f.failure_class || f.label, `retryable failure does not re-queue (disposition=${f.queue_disposition})`);
    }
    if (!f.retryable && !f.is_terminal) {
      add("retryable_no_bounded_recovery", f.failure_class || f.label, "failure is neither terminal nor retryable (undefined lifecycle)");
    }
  }

  // ── 8) successful orchestration capable of silently producing nothing ──────
  const noop = clean(graph.noopOperationalStatus);
  if (!noop || !operationalStatuses.has(noop)) {
    add("silent_success_possible", "deriveOperationalStatus", `a no-op decision derives no durable operational status (got '${graph.noopOperationalStatus}')`);
  }

  return {
    ok: gaps.length === 0,
    gaps,
    report: {
      db_backed_template_use_cases: [...db_backed].sort(),
      intent_count: (graph.intents || []).length,
      route_count: Object.keys(routeProfiles).length,
    },
  };
}

export default auditCoverageGraph;
