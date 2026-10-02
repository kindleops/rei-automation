/**
 * IC8 POINT-IN-TIME FEATURE HARNESS (architecture §3.1, §3.2, §3.2b).
 *
 * A feature's compute() never sees raw rows. It receives `read(collection)`,
 * an as-of-bounded reader over an injected bundle, and the reader:
 *   - places every row by its TRUE event time (inbound = message_events
 *     .created_at, never received_at/event_timestamp; sends =
 *     coalesce(sent_at, created_at); recorded documents = end of their date)
 *     and returns only rows strictly before `asOf`;
 *   - drops rows whose true time is missing (they cannot be proven past);
 *   - projects each row onto an allowlist of fields and masks every time field
 *     that is not strictly before `asOf` (e.g. delivered_at of a prior send
 *     whose receipt arrived after the decision);
 *   - refuses collections the feature's PIT class or fairness class may not
 *     read (a programming error, so it throws): restricted_targeting
 *     collections only for restricted_targeting (or protected_analysis_only)
 *     features, protected_analysis_only collections only for
 *     protected_analysis_only features, message text only for
 *     conversation_only features;
 *   - tracks max_input_time across everything it returned.
 * computeFeatureVector() then asserts max_input_time < asOf (assertNoLeakage).
 *
 * Fields that never enter a feature vector (names, phones, emails, blobs that
 * embed them, demographic composition, legacy scores, mutable status columns)
 * are simply absent from every allowlist below; a feature cannot request what
 * the reader does not project.
 */

import { coalesceMs, dateOnlyEndMs, MINUTE_MS, toIso, toMs } from "../util/time.js";

export class PitViolationError extends Error {
  constructor(message, code = "PIT_VIOLATION") {
    super(message);
    this.name = "PitViolationError";
    this.code = code;
  }
}

export class LeakageError extends Error {
  constructor(message, { asOf = null, maxInputTime = null } = {}) {
    super(message);
    this.name = "LeakageError";
    this.code = "PIT_LEAKAGE";
    this.asOf = asOf;
    this.maxInputTime = maxInputTime;
  }
}

/** How long a decision-time capture stays usable for the decision it was taken for. */
export const DECISION_CAPTURE_TOLERANCE_MS = 5 * MINUTE_MS;

/**
 * Collections a feature may read. `fields` is the projection allowlist:
 *   key | value   copied as-is
 *   time          an instant; masked to null unless strictly before asOf
 *   time_date     a DATE; placed at the end of its UTC day, masked likewise
 *   capture_time  decision captures only: kept (it is the capture instant)
 */
export const PIT_COLLECTIONS = Object.freeze({
  sends: {
    pitClass: "event_time",
    source: "public.send_queue (attempts; placed by coalesce(sent_at, created_at))",
    time: (row) => coalesceMs(row.sent_at, row.created_at),
    fields: {
      id: "key",
      thread_key: "key",
      property_id: "key",
      campaign_id: "key",
      template_id: "value",
      use_case_template: "value",
      sent_at: "time",
      created_at: "time",
      delivered_at: "time",
    },
  },
  inbound_messages: {
    pitClass: "event_time",
    source: "public.message_events inbound (created_at is the only true receive time)",
    time: (row) => toMs(row.created_at),
    fields: { id: "key", thread_key: "key", direction: "value", event_type: "value", created_at: "time" },
  },
  inbound_message_text: {
    pitClass: "event_time",
    requiresFairnessClass: "conversation_only",
    source: "public.message_events inbound bodies (conversation-understanding families only)",
    time: (row) => toMs(row.created_at),
    fields: { id: "key", thread_key: "key", created_at: "time", message_body: "value" },
  },
  outbound_failures: {
    pitClass: "event_time",
    source: "public.message_events outbound failures (failure_bucket)",
    time: (row) => toMs(row.created_at),
    fields: { id: "key", queue_id: "key", failure_bucket: "value", created_at: "time" },
  },
  property: {
    pitClass: "static_fact",
    static: true,
    source: "public.properties (structural facts; table re-imported 2026-08, documented as_of caveat)",
    fields: {
      property_id: "key",
      canonical_market_id: "value",
      market: "value",
      property_address_state: "value",
      property_address_zip: "value",
      property_type: "value",
      asset_class: "value",
      units_count: "value",
      building_square_feet: "value",
      total_bedrooms: "value",
      total_baths: "value",
      year_built: "value",
      lot_square_feet: "value",
    },
  },
  owner_profile: {
    pitClass: "static_fact",
    static: true,
    source: "public.master_owners (import 2026-04-24/25, +8,055 owners 2026-05-30; frozen since)",
    fields: { master_owner_id: "key", owner_type_guess: "value" },
  },
  prospect_person: {
    pitClass: "static_fact",
    static: true,
    requiresFairnessClass: "restricted_targeting",
    source: "public.prospects via phones.primary_prospect_id (import 2026-04-24/25; frozen since). restricted_targeting fields only.",
    fields: { prospect_id: "key", mob: "value", est_household_income: "value", education_model: "value", occupation_group: "value" },
  },
  prospect_protected: {
    pitClass: "static_fact",
    static: true,
    requiresFairnessClass: "protected_analysis_only",
    source: "public.prospects via phones.primary_prospect_id (import 2026-04-24/25). protected_analysis_only: research and fairness reports, never live decisions.",
    fields: { prospect_id: "key", gender: "value", marital_status: "value", language_preference: "value" },
  },
  owner_protected: {
    pitClass: "static_fact",
    static: true,
    requiresFairnessClass: "protected_analysis_only",
    source: "public.master_owners (import 2026-04-24/25). protected_analysis_only: research and fairness reports, never live decisions.",
    fields: { master_owner_id: "key", best_language: "value", agent_persona: "value", agent_family: "value" },
  },
  recorded_sales: {
    pitClass: "event_time",
    source: "seller.property_sale (2026-08-31 vendor snapshot; dated by event_date)",
    time: (row) => dateOnlyEndMs(row.event_date),
    fields: { property_id: "key", event_date: "time_date", event_date_kind: "value", doc_type: "value", is_arms_length: "value" },
  },
  recorded_mortgages: {
    pitClass: "event_time",
    source: "seller.property_mortgage (2026-08-31 vendor snapshot; dated by recording_date; ~16% undated rows are invisible)",
    time: (row) => dateOnlyEndMs(row.recording_date),
    fields: { property_id: "key", recording_date: "time_date", lien_position: "value", loan_type: "value", financing_type: "value" },
  },
  opportunity_history: {
    pitClass: "history_reconstructed",
    validFromMs: Date.UTC(2026, 5, 21),
    source: "public.acquisition_opportunity_history (stage rows from 2026-06-21)",
    time: (row) => toMs(row.created_at),
    fields: {
      id: "key",
      opportunity_id: "key",
      event_type: "value",
      field_name: "value",
      previous_value: "value",
      new_value: "value",
      created_at: "time",
    },
  },
  lead_state_events: {
    pitClass: "history_reconstructed",
    validFromMs: Date.UTC(2026, 6, 12),
    source: "public.universal_lead_state_events (from 2026-07-12)",
    time: (row) => toMs(row.created_at),
    fields: { id: "key", thread_key: "key", field_name: "value", previous_value: "value", new_value: "value", created_at: "time" },
  },
  decision_state: {
    pitClass: "decision_snapshot_only",
    capture: true,
    source: "mutable current state captured AT decision time (online only; never reconstructed)",
    time: (row) => toMs(row.captured_at),
    fields: {
      captured_at: "capture_time",
      out_of_state_owner: "value",
      owner_address_state: "value",
      owner_address_zip: "value",
      property_address_state: "value",
      property_address_zip: "value",
      lien_count: "value",
      active_lien: "value",
    },
  },
});

/** Which feature fairness classes may read a collection that requires a class. */
const CLASS_MAY_READ = Object.freeze({
  conversation_only: ["conversation_only"],
  restricted_targeting: ["restricted_targeting", "protected_analysis_only"],
  protected_analysis_only: ["protected_analysis_only"],
});

const READABLE_PIT_CLASSES = Object.freeze({
  static_fact: ["static_fact"],
  event_time: ["event_time", "static_fact"],
  history_reconstructed: ["history_reconstructed", "event_time", "static_fact"],
  decision_snapshot_only: ["decision_snapshot_only"],
});

/** Decision-time fields of an entity. Outcome columns are never projected. */
export const ENTITY_DECISION_FIELDS = Object.freeze({
  send: Object.freeze([
    "id",
    "thread_key",
    "property_id",
    "master_owner_id",
    "prospect_id",
    "campaign_id",
    "template_id",
    "use_case_template",
    "sent_at",
    "created_at",
  ]),
});

/** Columns that carry what happened AFTER the decision. Stripped from every entity. */
export const OUTCOME_FIELDS = Object.freeze([
  "delivered_at",
  "queue_status",
  "failed_at",
  "failure_bucket",
  "failure_reason",
  "delivery_status",
  "delivery_confirmed",
  "provider_status",
  "detected_intent",
  "replied_at",
  "is_opt_out",
  "updated_at",
]);

export function projectEntity(entityType, entity = {}) {
  const allowed = ENTITY_DECISION_FIELDS[entityType];
  if (!allowed) throw new PitViolationError(`no decision-field allowlist for entity type "${entityType}"`, "UNKNOWN_ENTITY_TYPE");
  const out = {};
  for (const field of allowed) {
    if (OUTCOME_FIELDS.includes(field)) continue;
    const value = entity?.[field];
    out[field] = value === undefined ? null : value;
  }
  return Object.freeze(out);
}

function projectRow(row, spec, asOfMs, track) {
  const out = {};
  for (const [field, kind] of Object.entries(spec.fields)) {
    const value = row[field];
    if (kind === "time" || kind === "time_date") {
      const ms = kind === "time" ? toMs(value) : dateOnlyEndMs(value);
      if (ms !== null && ms < asOfMs) {
        out[field] = value;
        track(ms);
      } else {
        out[field] = null;
      }
    } else {
      out[field] = value === undefined ? null : value;
    }
  }
  return Object.freeze(out);
}

/**
 * The as-of-bounded reader handed to compute(). `bundle` maps collection names
 * to raw rows (arrays; a single object is accepted for static collections).
 */
export function createAsOfReader(
  bundle,
  {
    asOf,
    pitClass,
    fairnessClass = "permitted",
    featureKey = null,
    collections = PIT_COLLECTIONS,
    captureToleranceMs = DECISION_CAPTURE_TOLERANCE_MS,
  } = {},
) {
  const asOfMs = toMs(asOf);
  if (asOfMs === null) throw new PitViolationError("as_of is required", "AS_OF_MISSING");
  if (!READABLE_PIT_CLASSES[pitClass]) throw new PitViolationError(`unknown pit class ${pitClass}`, "UNKNOWN_PIT_CLASS");
  let maxInputTime = null;
  const stats = { dropped_future: 0, dropped_untimed: 0, history_unavailable: 0, reads: 0 };
  const track = (ms) => {
    if (maxInputTime === null || ms > maxInputTime) maxInputTime = ms;
  };

  function read(name, where = null) {
    const spec = collections[name];
    if (!spec) throw new PitViolationError(`${featureKey || "feature"} read unknown collection "${name}"`, "UNKNOWN_COLLECTION");
    if (!READABLE_PIT_CLASSES[pitClass].includes(spec.pitClass)) {
      throw new PitViolationError(
        `${featureKey || "feature"} (${pitClass}) may not read ${name} (${spec.pitClass})`,
        "PIT_CLASS_VIOLATION",
      );
    }
    if (spec.requiresFairnessClass && !CLASS_MAY_READ[spec.requiresFairnessClass].includes(fairnessClass)) {
      throw new PitViolationError(
        `${featureKey || "feature"} (${fairnessClass}) may not read ${name} (requires ${spec.requiresFairnessClass})`,
        "FAIRNESS_CLASS_VIOLATION",
      );
    }
    stats.reads += 1;
    const raw = bundle ? bundle[name] : undefined;
    let rows;
    if (spec.static) {
      const list = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw.slice(0, 1) : [raw];
      rows = list.filter((row) => row && typeof row === "object").map((row) => projectRow(row, spec, asOfMs, track));
    } else {
      if (spec.validFromMs !== undefined && asOfMs < spec.validFromMs) {
        stats.history_unavailable += 1;
        return [];
      }
      const list = Array.isArray(raw) ? raw : [];
      const visible = [];
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const t = spec.time(row);
        if (t === null) {
          stats.dropped_untimed += 1;
          continue;
        }
        if (spec.capture) {
          // A decision-time capture is usable only for the decision it was
          // taken for: at or just before asOf, never after.
          if (t > asOfMs || asOfMs - t > captureToleranceMs) {
            stats.dropped_future += t > asOfMs ? 1 : 0;
            continue;
          }
          const maxInput = toMs(row.max_input_time);
          if (maxInput !== null) track(maxInput);
        } else if (t >= asOfMs) {
          stats.dropped_future += 1;
          continue;
        } else {
          track(t);
        }
        visible.push({ t, row: projectRow(row, spec, asOfMs, track) });
      }
      visible.sort((a, b) => a.t - b.t || String(a.row.id ?? "").localeCompare(String(b.row.id ?? "")));
      rows = visible.map((entry) => entry.row);
    }
    return typeof where === "function" ? rows.filter(where) : rows;
  }

  return Object.freeze({
    read,
    get maxInputTime() {
      return maxInputTime;
    },
    stats,
  });
}

/** Hard leakage check: every input must be strictly older than the decision. */
export function assertNoLeakage({ asOf, maxInputTime }) {
  const asOfMs = toMs(asOf);
  const maxMs = toMs(maxInputTime);
  if (asOfMs === null) throw new LeakageError("as_of missing", { asOf, maxInputTime });
  if (maxMs !== null && maxMs >= asOfMs) {
    throw new LeakageError(`max_input_time ${toIso(maxMs)} is not before as_of ${toIso(asOfMs)}`, {
      asOf: toIso(asOfMs),
      maxInputTime: toIso(maxMs),
    });
  }
  return true;
}

function checkValue(def, value) {
  if (value === null || value === undefined) return true;
  switch (def.valueType) {
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "categorical":
      return typeof value === "string" && value.length > 0 && value.length <= 200;
    default:
      return false;
  }
}

/**
 * Compute one feature set for one entity as of `asOf`. Throws on PIT
 * violations and leakage (programming errors); a feature whose compute fails
 * or returns an invalid type is reported missing with an error code.
 */
export function computeFeatureVector({
  registry,
  featureSetId,
  entityType = "send",
  entity,
  asOf,
  bundle,
  collections = PIT_COLLECTIONS,
}) {
  const set = registry.getSet(featureSetId);
  const asOfMs = toMs(asOf);
  if (asOfMs === null) throw new PitViolationError("as_of is required", "AS_OF_MISSING");
  const projected = projectEntity(entityType, entity);
  const values = {};
  const missing = [];
  const errors = [];
  let maxInputTime = null;
  for (const member of set.members) {
    const def = registry.get(member.key, member.version);
    const reader = createAsOfReader(bundle, {
      asOf: asOfMs,
      pitClass: def.pitClass,
      fairnessClass: def.fairnessClass,
      featureKey: def.id,
      collections,
    });
    let value = null;
    try {
      value = def.compute({ asOf: asOfMs, entity: projected, read: reader.read });
    } catch (error) {
      if (error instanceof PitViolationError) throw error;
      errors.push({ feature: def.key, code: "compute_error", message: String(error?.message || error).slice(0, 200) });
      value = null;
    }
    if (value && typeof value.then === "function") {
      errors.push({ feature: def.key, code: "async_compute_not_supported" });
      value = null;
    }
    if (!checkValue(def, value)) {
      errors.push({ feature: def.key, code: "invalid_value_type", valueType: def.valueType });
      value = null;
    }
    if (value === null || value === undefined) missing.push(def.key);
    else values[def.key] = value;
    const readerMax = reader.maxInputTime;
    if (readerMax !== null && (maxInputTime === null || readerMax > maxInputTime)) maxInputTime = readerMax;
  }
  assertNoLeakage({ asOf: asOfMs, maxInputTime });
  return {
    feature_set_id: set.featureSetId,
    feature_set_hash: set.definitionHash,
    as_of: toIso(asOfMs),
    max_input_time: toIso(maxInputTime),
    values,
    missing,
    errors,
  };
}

/** Row for intelligence.feature_snapshots (the DB CHECK repeats max_input_time < as_of). */
export function toFeatureSnapshotRow(vector, { entityType, entityId, origin = "online" }) {
  return {
    feature_set_id: vector.feature_set_id,
    entity_type: entityType,
    entity_id: String(entityId),
    as_of: vector.as_of,
    max_input_time: vector.max_input_time,
    values: vector.values,
    missing: vector.missing,
    origin,
  };
}
