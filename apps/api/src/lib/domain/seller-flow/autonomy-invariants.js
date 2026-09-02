// ─── autonomy-invariants.js ─────────────────────────────────────────────────
// AUTONOMOUS INCIDENT DETECTION (supersprint §18).
//
// A PURE evaluator that turns impossible or dangerous cross-entity states into
// machine-readable invariant violations. It takes bounded windows of the
// canonical tables as plain arrays and returns a deterministic list of
// violations. No I/O, no side effects, fully fixture-testable. A read-only scan
// lane feeds it from the database; nothing here ever writes.
//
// Every violation carries:
//   code        — stable machine-readable identifier
//   severity    — 'fatal' | 'error' | 'warn'
//   fatal       — true for monetary / identity violations (§18: fail closed)
//   entity_type — the primary entity the violation is anchored to
//   entity_id   — its id
//   detail      — the concrete evidence (ids + values), never prose-only
//
// The evaluator is TOTAL over its inputs: a clean estate produces []; a
// malformed row never throws, it is skipped or reported as a violation.

export const AUTONOMY_INVARIANTS_VERSION = "autonomy_invariants_v1";

export const INVARIANT_CODES = Object.freeze({
  MONETARY_QUEUE_ROW_WITHOUT_OFFER: "monetary_queue_row_without_seller_offer",
  OFFER_WITHOUT_ADE_SNAPSHOT: "seller_offer_without_ade_snapshot",
  MULTIPLE_ACCEPTED_OFFERS: "multiple_accepted_offers_for_opportunity",
  MULTIPLE_ACTIVE_OFFERS: "multiple_active_offers_for_opportunity",
  CLOSING_TERMS_MISMATCH: "closing_case_terms_mismatch_accepted_offer",
  CLOSING_WITHOUT_ACCEPTED_OFFER: "closing_case_without_accepted_offer",
  QUEUE_RECIPIENT_MISMATCH: "send_queue_recipient_differs_from_opportunity_seller",
  STAGE_WITHOUT_NEXT_ACTION: "active_stage_without_next_action",
  FOLLOWUP_DUE_NOT_SCHEDULED: "followup_due_but_none_scheduled",
  DUPLICATE_PROVIDER_SEND: "duplicate_provider_send_for_logical_decision",
  RENDERED_AMOUNT_MISMATCH: "rendered_amount_differs_from_persisted_price",
  OFFER_EXCEEDS_CEILING: "offer_exceeds_authorized_ceiling",
  OFFER_BELOW_MINIMUM_MARGIN: "offer_violates_minimum_margin",
  WRONG_PROPERTY_CONTEXT: "queue_row_property_differs_from_opportunity",
  ACCEPTED_OFFER_WITHOUT_CLOSING: "accepted_offer_without_closing_case",
});

const MONETARY_USE_CASES = new Set([
  "initial_offer",
  "conditional_offer",
  "counter_offer",
  "final_offer",
  "offer_reveal_cash",
]);

// Lifecycle stages past which no automated next action is expected.
const TERMINAL_STAGES = new Set(["closed", "dead", "suppressed", "lost", "cancelled"]);
const SENT_STATUSES = new Set(["sent", "delivered"]);

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function digits(value) {
  return clean(value).replace(/\D+/g, "");
}

function violation({ code, severity, fatal, entity_type, entity_id, detail }) {
  return Object.freeze({
    code,
    severity,
    fatal: Boolean(fatal),
    entity_type,
    entity_id: clean(entity_id) || null,
    detail: detail && typeof detail === "object" ? detail : {},
    version: AUTONOMY_INVARIANTS_VERSION,
  });
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/**
 * Evaluate every autonomy invariant over bounded windows of canonical state.
 *
 * @param {object} estate
 * @param {Array} [estate.offers]        seller_offers rows
 * @param {Array} [estate.closing_cases] closing_cases rows
 * @param {Array} [estate.queue_rows]    send_queue rows (with metadata)
 * @param {Array} [estate.opportunities] acquisition_opportunities rows
 * @param {Array} [estate.followups]     follow-up rows ({ thread_key, status, due_at })
 * @param {string} [estate.now]          ISO instant for due-date checks
 * @returns {Array<object>} deterministic list of violations (empty when clean)
 */
export function evaluateAutonomyInvariants({
  offers = [],
  closing_cases = [],
  queue_rows = [],
  opportunities = [],
  followups = [],
  // inbox_thread_state rows: suppression/archival lives on the projection, not
  // the canonical opportunity, so it is needed to avoid flagging a terminal
  // (suppressed / archived) thread as a missing-next-action dead end.
  thread_states = [],
  now = null,
} = {}) {
  const out = [];
  const nowMs = now ? new Date(now).getTime() : Date.now();

  // TOTALITY: every input is normalized to an array of plain objects. A null,
  // undefined, or scalar entry is dropped rather than allowed to throw, so a
  // malformed window can never take the incident detector down with it.
  const rows = (arr) => (Array.isArray(arr) ? arr : []).filter((r) => r && typeof r === "object");
  offers = rows(offers);
  closing_cases = rows(closing_cases);
  queue_rows = rows(queue_rows);
  opportunities = rows(opportunities);
  followups = rows(followups);
  thread_states = rows(thread_states);
  const terminalThreads = new Set(
    thread_states
      .filter((t) => t.is_suppressed === true || t.is_archived === true)
      .map((t) => clean(t.thread_key))
      .filter(Boolean)
  );

  const offerById = new Map((offers || []).map((o) => [clean(o.offer_id), o]));
  const oppById = new Map((opportunities || []).map((o) => [clean(o.id), o]));
  const offersByOpp = groupBy(offers, (o) => clean(o.opportunity_id));
  const closingByOpp = groupBy(closing_cases, (c) => clean(c.opportunity_id));

  // ── 1. monetary queue row with no seller_offer ────────────────────────────
  for (const row of queue_rows || []) {
    const useCase = clean(row.use_case_template || row.message_type || row.metadata?.use_case).toLowerCase();
    if (!MONETARY_USE_CASES.has(useCase)) continue;
    const offerId = clean(row.metadata?.offer_id || row.offer_id);
    if (!offerId || !offerById.has(offerId)) {
      out.push(violation({
        code: INVARIANT_CODES.MONETARY_QUEUE_ROW_WITHOUT_OFFER,
        severity: "fatal", fatal: true,
        entity_type: "send_queue", entity_id: row.id,
        detail: { use_case: useCase, offer_id: offerId || null, to_phone_number: clean(row.to_phone_number) || null },
      }));
    }
  }

  // ── 9. rendered amount differs from persisted purchase price ──────────────
  // ── 14. wrong property context ────────────────────────────────────────────
  // ── 5. queue recipient differs from opportunity seller ────────────────────
  for (const row of queue_rows || []) {
    const offerId = clean(row.metadata?.offer_id || row.offer_id);
    const offer = offerId ? offerById.get(offerId) : null;
    const renderedPrice = num(row.metadata?.offer_price ?? row.offer_price);
    if (offer && renderedPrice !== null && num(offer.purchase_price) !== null && renderedPrice !== num(offer.purchase_price)) {
      out.push(violation({
        code: INVARIANT_CODES.RENDERED_AMOUNT_MISMATCH,
        severity: "fatal", fatal: true,
        entity_type: "send_queue", entity_id: row.id,
        detail: { offer_id: offerId, rendered_price: renderedPrice, persisted_price: num(offer.purchase_price) },
      }));
    }

    const oppId = clean(row.campaign_opportunity_id || row.opportunity_id || row.metadata?.opportunity_id);
    const opp = oppId ? oppById.get(oppId) : null;
    if (opp) {
      const rowProp = clean(row.property_id);
      const oppProp = clean(opp.primary_property_id);
      if (rowProp && oppProp && rowProp !== oppProp) {
        out.push(violation({
          code: INVARIANT_CODES.WRONG_PROPERTY_CONTEXT,
          severity: "fatal", fatal: true,
          entity_type: "send_queue", entity_id: row.id,
          detail: { opportunity_id: oppId, row_property_id: rowProp, opportunity_property_id: oppProp },
        }));
      }
      const to = digits(row.to_phone_number);
      const seller = digits(opp.primary_thread_key);
      if (to && seller && to !== seller) {
        out.push(violation({
          code: INVARIANT_CODES.QUEUE_RECIPIENT_MISMATCH,
          severity: "fatal", fatal: true,
          entity_type: "send_queue", entity_id: row.id,
          detail: { opportunity_id: oppId, to_phone_number: clean(row.to_phone_number), opportunity_seller: clean(opp.primary_thread_key) },
        }));
      }
    }
  }

  // ── 2/10/11. per-offer monetary lineage + authority bounds ────────────────
  for (const offer of offers || []) {
    const isOutbound = clean(offer.direction || "outbound") === "outbound";
    const price = num(offer.purchase_price);
    if (isOutbound && !clean(offer.ade_snapshot_id)) {
      out.push(violation({
        code: INVARIANT_CODES.OFFER_WITHOUT_ADE_SNAPSHOT,
        severity: "error", fatal: false,
        entity_type: "seller_offers", entity_id: offer.offer_id,
        detail: { opportunity_id: clean(offer.opportunity_id) || null, offer_version: offer.offer_version ?? null },
      }));
    }
    const ceiling = num(offer.authorized_ceiling);
    if (isOutbound && price !== null && ceiling !== null && price > ceiling) {
      out.push(violation({
        code: INVARIANT_CODES.OFFER_EXCEEDS_CEILING,
        severity: "fatal", fatal: true,
        entity_type: "seller_offers", entity_id: offer.offer_id,
        detail: { purchase_price: price, authorized_ceiling: ceiling, over_by: price - ceiling },
      }));
    }
    const minMargin = num(offer.metadata?.minimum_margin);
    if (isOutbound && price !== null && ceiling !== null && minMargin !== null && ceiling - price < minMargin) {
      out.push(violation({
        code: INVARIANT_CODES.OFFER_BELOW_MINIMUM_MARGIN,
        severity: "fatal", fatal: true,
        entity_type: "seller_offers", entity_id: offer.offer_id,
        detail: { purchase_price: price, authorized_ceiling: ceiling, margin: ceiling - price, minimum_margin: minMargin },
      }));
    }
  }

  // ── 3. multiple accepted / multiple active per opportunity ────────────────
  // ── 15. accepted offer without closing case ───────────────────────────────
  for (const [oppId, rows] of offersByOpp.entries()) {
    const accepted = rows.filter((o) => clean(o.status) === "accepted");
    const active = rows.filter((o) => clean(o.status) === "active");
    if (accepted.length > 1) {
      out.push(violation({
        code: INVARIANT_CODES.MULTIPLE_ACCEPTED_OFFERS,
        severity: "fatal", fatal: true,
        entity_type: "acquisition_opportunities", entity_id: oppId,
        detail: { accepted_offer_ids: accepted.map((o) => o.offer_id) },
      }));
    }
    if (active.length > 1) {
      out.push(violation({
        code: INVARIANT_CODES.MULTIPLE_ACTIVE_OFFERS,
        severity: "fatal", fatal: true,
        entity_type: "acquisition_opportunities", entity_id: oppId,
        detail: { active_offer_ids: active.map((o) => o.offer_id) },
      }));
    }
    if (accepted.length === 1 && !(closingByOpp.get(oppId) || []).length) {
      out.push(violation({
        code: INVARIANT_CODES.ACCEPTED_OFFER_WITHOUT_CLOSING,
        severity: "error", fatal: false,
        entity_type: "seller_offers", entity_id: accepted[0].offer_id,
        detail: { opportunity_id: oppId, accepted_at: accepted[0].accepted_at || null },
      }));
    }
  }

  // ── 4. closing_case terms must match the accepted offer ───────────────────
  for (const c of closing_cases || []) {
    const oppId = clean(c.opportunity_id);
    const accepted = (offersByOpp.get(oppId) || []).filter((o) => clean(o.status) === "accepted");
    if (!accepted.length) {
      out.push(violation({
        code: INVARIANT_CODES.CLOSING_WITHOUT_ACCEPTED_OFFER,
        severity: "fatal", fatal: true,
        entity_type: "closing_cases", entity_id: c.closing_case_id || c.id,
        detail: { opportunity_id: oppId || null },
      }));
      continue;
    }
    const offer = accepted[0];
    const contractPrice = num(c.seller_contract_price);
    const acceptedPrice = num(offer.accepted_price ?? offer.purchase_price);
    const priceMismatch = contractPrice !== null && acceptedPrice !== null && contractPrice !== acceptedPrice;
    const offerIdMismatch = clean(c.offer_id) && clean(c.offer_id) !== clean(offer.offer_id);
    if (priceMismatch || offerIdMismatch) {
      out.push(violation({
        code: INVARIANT_CODES.CLOSING_TERMS_MISMATCH,
        severity: "fatal", fatal: true,
        entity_type: "closing_cases", entity_id: c.closing_case_id || c.id,
        detail: {
          closing_offer_id: clean(c.offer_id) || null, accepted_offer_id: clean(offer.offer_id),
          seller_contract_price: contractPrice, accepted_price: acceptedPrice,
        },
      }));
    }
  }

  // ── 6. active stage with no next action ───────────────────────────────────
  for (const opp of opportunities || []) {
    const stage = clean(opp.acquisition_stage).toLowerCase();
    const status = clean(opp.opportunity_status).toLowerCase();
    if (TERMINAL_STAGES.has(stage) || TERMINAL_STAGES.has(status)) continue;
    // A suppressed / archived thread is terminal for the seller; no next action
    // is expected and it is not a dead end.
    if (terminalThreads.has(clean(opp.primary_thread_key))) continue;
    if (!clean(opp.next_action)) {
      out.push(violation({
        code: INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION,
        severity: "error", fatal: false,
        entity_type: "acquisition_opportunities", entity_id: opp.id,
        detail: { acquisition_stage: stage || null, opportunity_status: status || null },
      }));
    }
  }

  // ── 7. follow-up due but none scheduled ───────────────────────────────────
  const scheduledByThread = groupBy(
    (followups || []).filter((f) => ["scheduled", "pending", "queued"].includes(clean(f.status).toLowerCase())),
    (f) => clean(f.thread_key)
  );
  for (const opp of opportunities || []) {
    const due = opp.next_action_due || opp.next_action_at || opp.follow_up_due_at;
    const dueMs = due ? new Date(due).getTime() : NaN;
    const wantsFollowup = clean(opp.next_action).toLowerCase().includes("follow");
    if (!wantsFollowup || !Number.isFinite(dueMs) || dueMs > nowMs) continue;
    if (terminalThreads.has(clean(opp.primary_thread_key))) continue;
    const thread = clean(opp.primary_thread_key);
    if (!(scheduledByThread.get(thread) || []).length) {
      out.push(violation({
        code: INVARIANT_CODES.FOLLOWUP_DUE_NOT_SCHEDULED,
        severity: "error", fatal: false,
        entity_type: "acquisition_opportunities", entity_id: opp.id,
        detail: { thread_key: thread || null, due_at: due, next_action: clean(opp.next_action) },
      }));
    }
  }

  // ── 8. duplicate provider send for one logical decision ───────────────────
  const sentByDecision = groupBy(
    (queue_rows || []).filter((r) => SENT_STATUSES.has(clean(r.queue_status).toLowerCase())),
    (r) => clean(r.metadata?.inbound_message_event_id || r.inbound_message_event_id || r.metadata?.decision_id)
  );
  for (const [eventId, rows] of sentByDecision.entries()) {
    const sids = new Set(rows.map((r) => clean(r.provider_message_sid)).filter(Boolean));
    if (rows.length > 1 && sids.size > 1) {
      out.push(violation({
        code: INVARIANT_CODES.DUPLICATE_PROVIDER_SEND,
        severity: "fatal", fatal: true,
        entity_type: "send_queue", entity_id: rows[0].id,
        detail: { inbound_message_event_id: eventId, queue_row_ids: rows.map((r) => r.id), provider_message_sids: [...sids] },
      }));
    }
  }

  return out;
}

/** Summary rollup for reporting / alerting: counts by code and fatal flag. */
export function summarizeInvariantViolations(violations = []) {
  const byCode = {};
  let fatal = 0;
  for (const v of violations || []) {
    byCode[v.code] = (byCode[v.code] || 0) + 1;
    if (v.fatal) fatal += 1;
  }
  return {
    version: AUTONOMY_INVARIANTS_VERSION,
    total: (violations || []).length,
    fatal,
    ok: (violations || []).length === 0,
    fail_closed: fatal > 0,
    by_code: byCode,
  };
}

export default evaluateAutonomyInvariants;
