/**
 * IC8 OPERATOR CORRECTIONS (architecture §6; brief rule 6: corrections are
 * gold, never overwrite history).
 *
 * recordCorrection appends one row to intelligence.corrections with the
 * original value AND its source (producer, version, decision id), the
 * corrected value, the operator (x-ops-user-id; null = unknown operator, a
 * weak label), the reason, the time and where the correction came from. It is
 * append-only (DB trigger), idempotent (idempotency_key) and fail-open: it
 * never throws into the route that corrected something.
 *
 * The backfill mappers turn the two tables that keep prior values
 * (acquisition_opportunity_history, universal_lead_state_events) into
 * correction rows -- only rows with positive evidence of a human; machine
 * writes, synthetic/QA rows and unattributed syncs are excluded with a reason.
 */

import { IC8_CORRECTION_NAMESPACE, hashObject, uuidV5 } from "../util/hash.js";
import { toIso, toMs } from "../util/time.js";

export const CORRECTION_SOURCE_PREFIXES = Object.freeze(["route:", "repair:", "backfill:", "operator:", "script:"]);
const OPERATOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/** The operator id the Worker stamps on every authenticated request (x-ops-user-id). */
export function operatorIdFromHeaders(headers) {
  if (!headers) return null;
  let value = null;
  if (typeof headers.get === "function") value = headers.get("x-ops-user-id");
  else {
    for (const [key, v] of Object.entries(headers)) {
      if (key.toLowerCase() === "x-ops-user-id") value = Array.isArray(v) ? v[0] : v;
    }
  }
  const id = clean(value);
  return id && OPERATOR_ID_RE.test(id) ? id : null;
}

/**
 * Normalise a correction into a row. Pure. Returns { row, fatal }.
 * input: { subject: {type, id}, field, original: {value, source: {producer, version, decision_id}},
 *          corrected, operatorId, reason, source, correctedAt, idempotencyKey, metadata }
 */
export function buildCorrectionRow(rawInput = {}, { now = () => Date.now() } = {}) {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const subjectType = clean(input.subject?.type);
  const subjectId = clean(input.subject?.id);
  const field = clean(input.field);
  const source = clean(input.source);
  if (!subjectType || !subjectId) return { row: null, fatal: "subject_required" };
  if (!field) return { row: null, fatal: "field_required" };
  if (!CORRECTION_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix))) return { row: null, fatal: "source_must_be_route_repair_backfill_operator_or_script" };
  if (!input.original || typeof input.original !== "object" || !("value" in input.original)) return { row: null, fatal: "original_required" };
  const correctedMs = input.correctedAt === undefined ? now() : toMs(input.correctedAt);
  if (correctedMs === null) return { row: null, fatal: "invalid_corrected_at" };
  const originalSource = input.original.source && typeof input.original.source === "object" ? input.original.source : {};
  const operatorId = clean(input.operatorId) && OPERATOR_ID_RE.test(clean(input.operatorId)) ? clean(input.operatorId) : null;
  const row = {
    subject_type: subjectType,
    subject_id: subjectId,
    field,
    original_value: json(input.original.value),
    original_source: {
      producer: clean(originalSource.producer) || null,
      version: clean(originalSource.version) || null,
      decision_id: clean(originalSource.decision_id) || null,
    },
    corrected_value: json(input.corrected),
    operator_id: operatorId,
    reason: clean(input.reason).slice(0, 2000) || null,
    corrected_at: toIso(correctedMs),
    source,
    metadata: {
      ...(input.metadata && typeof input.metadata === "object" ? json(input.metadata) : {}),
      weak_label: operatorId === null,
    },
  };
  row.idempotency_key =
    clean(input.idempotencyKey) ||
    uuidV5(
      hashObject({
        s: [row.subject_type, row.subject_id, row.field],
        o: row.original_value,
        c: row.corrected_value,
        at: row.corrected_at,
        src: row.source,
      }),
      IC8_CORRECTION_NAMESPACE,
    );
  return { row, fatal: null };
}

/** A fail-open, append-only writer. deps: { store (insertCorrection), now, logger }. */
export function createCorrectionsWriter({ store, now = () => Date.now(), logger = null } = {}) {
  const stats = { written: 0, invalid: 0, write_errors: 0 };
  async function recordCorrection(input) {
    try {
      const { row, fatal } = buildCorrectionRow(input, { now });
      if (fatal) {
        stats.invalid += 1;
        return { ok: false, reason: fatal };
      }
      const result = store ? await store.insertCorrection(row) : { ok: false, error: { code: "STORE_UNCONFIGURED" } };
      if (!result || result.ok !== true) {
        stats.write_errors += 1;
        try {
          logger?.warn?.("intelligence.corrections.write_failed", { code: result?.error?.code || "unknown" });
        } catch {
          // never let logging break the caller
        }
        return { ok: false, reason: "write_failed", idempotency_key: row.idempotency_key };
      }
      stats.written += 1;
      return { ok: true, idempotency_key: row.idempotency_key };
    } catch {
      stats.write_errors += 1;
      return { ok: false, reason: "internal_error" };
    }
  }
  return Object.freeze({ recordCorrection, stats: () => ({ ...stats }) });
}

// ── backfill mappers (pure) ──

const SYNTHETIC_ACTOR_RE = /(cert|probe|fixture|qa_|test)/i;
const SYNTHETIC_REASON_RE = /(certification|probe|fixture|restore test|regression)/i;
const MACHINE_RE = /(autopilot|orchestrator|seller_inbound|gap_recovery|sweep|backfill_|_sync|automation|cron|feeder)/i;
const HUMAN_SOURCES = new Set(["operator", "manual", "rc71_owner_approved_correction"]);
const HUMAN_ACTOR_RE = /^(owner-approved|operator|ops[:_]|user:)/i;

/** acquisition_opportunity_history row -> { include, reason, correction } */
export function mapOpportunityHistoryRow(h = {}) {
  const actor = clean(h.actor);
  const source = clean(h.source);
  const reason = clean(h.reason);
  if (SYNTHETIC_ACTOR_RE.test(actor) || SYNTHETIC_REASON_RE.test(reason)) return { include: false, reason: "synthetic_or_qa" };
  if (MACHINE_RE.test(`${actor} ${source}`)) return { include: false, reason: "machine_write" };
  const metadataOperator = clean(h.metadata?.operator_id);
  const human = HUMAN_SOURCES.has(lower(source)) || HUMAN_ACTOR_RE.test(actor) || Boolean(metadataOperator);
  if (!human) return { include: false, reason: actor || source ? "no_human_evidence" : "no_actor_evidence" };
  return {
    include: true,
    reason: "human_correction",
    correction: {
      subject: { type: "opportunity", id: clean(h.opportunity_id) },
      field: clean(h.field_name) || clean(h.event_type) || "unknown",
      original: { value: h.previous_value ?? null, source: { producer: "acquisition_opportunity_history", version: null, decision_id: null } },
      corrected: h.new_value ?? null,
      operatorId: metadataOperator || null,
      reason: reason || null,
      source: "backfill:acquisition_opportunity_history",
      correctedAt: h.created_at,
      idempotencyKey: `backfill:aoh:${clean(h.id)}`,
      metadata: {
        actor: actor || null,
        history_source: source || null,
        event_type: clean(h.event_type) || null,
        original_preserved: h.previous_value !== null && h.previous_value !== undefined,
      },
    },
  };
}

/** universal_lead_state_events row -> { include, reason, correction } */
export function mapLeadStateEventRow(e = {}) {
  if (lower(e.change_source) !== "manual") return { include: false, reason: "not_manual" };
  const operatorId = clean(e.operator_id);
  const reason = clean(e.reason);
  // 611 of 623 manual rows carry neither operator nor reason: the opportunity->thread sync, not a person.
  if (!operatorId && !reason) return { include: false, reason: "unattributed_manual_sync" };
  if (SYNTHETIC_REASON_RE.test(reason)) return { include: false, reason: "synthetic_or_qa" };
  const day = clean(e.created_at).slice(0, 10);
  const bulkSuspect =
    (day === "2026-09-08" && !clean(e.source_view)) || (lower(e.source_view) === "inbox_thread_patch" && lower(e.field_name).includes("archive"));
  return {
    include: true,
    reason: "human_correction",
    correction: {
      subject: { type: "thread", id: clean(e.thread_key) },
      field: clean(e.field_name) || "unknown",
      original: { value: e.previous_value ?? null, source: { producer: "universal_lead_state_events", version: null, decision_id: null } },
      corrected: e.new_value ?? null,
      operatorId: operatorId || null,
      reason: reason || null,
      source: "backfill:universal_lead_state_events",
      correctedAt: e.created_at,
      idempotencyKey: `backfill:ulse:${clean(e.id)}`,
      metadata: {
        source_view: clean(e.source_view) || null,
        bulk_suspect: bulkSuspect,
        original_preserved: e.previous_value !== null && e.previous_value !== undefined,
      },
    },
  };
}
