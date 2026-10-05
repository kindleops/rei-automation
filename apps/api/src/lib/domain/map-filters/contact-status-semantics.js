/**
 * Canonical property TOUCH state for map filters ("Property universe":
 * All / Uncontacted / Contacted).
 *
 * Source of truth: public.campaign_target_graph.never_contacted — the same
 * column the Campaign Composer, funnel and Build read (one audience truth).
 * The graph derives it daily from the send ledger: last_outbound_at =
 * GREATEST(message_events outbound, send_queue sent) for the row's phone.
 *
 *   contacted   = the property has a graph row with never_contacted = false
 *   uncontacted = NOT contacted (no graph touch known — includes the handful of
 *                 properties without a graph row), so the two buckets always
 *                 partition the universe exactly.
 *
 * NOT public.properties.contact_status: that is a Podio-era import column whose
 * only values are 'No Contact' and NULL. Treating any non-null value as
 * "contacted" labelled 121,182 never-texted properties as Contacted.
 */

export const TOUCH_STATE_FIELD_KEY = "property.touch_state";
export const TOUCH_STATE_DATA_TYPE = "touch_state";
export const TOUCH_STATE_OPERATORS = Object.freeze(["is_contacted", "is_uncontacted"]);
export const TOUCH_STATE_SOURCE = Object.freeze({
  table: "public.campaign_target_graph",
  column: "never_contacted",
  joinKey: "property_id",
});

/**
 * Property history (owner option B, 2026-10-05). When the property-level projection
 * campaign_target_graph.property_ever_contacted exists (migration 20261005161000),
 * set MAP_TOUCH_PROPERTY_LEVEL=1: Contacted then also counts sends logged against
 * the property on a phone that is no longer its best phone. Default off, because
 * the column does not exist until that migration is applied and backfilled.
 */
export function isPropertyLevelTouchEnabled(env = process.env) {
  return String(env?.MAP_TOUCH_PROPERTY_LEVEL ?? "").trim() === "1";
}

/** Row-level "this graph row is touched" condition for alias `tg`. */
export function touchedGraphRowSql(alias = "tg", { propertyLevel = isPropertyLevelTouchEnabled() } = {}) {
  return propertyLevel
    ? `(${alias}.never_contacted IS FALSE OR ${alias}.property_ever_contacted)`
    : `${alias}.never_contacted IS FALSE`;
}

/** Kept for callers that still import the old name; it is the touch field now. */
export const CONTACT_STATUS_FIELD_KEY = TOUCH_STATE_FIELD_KEY;

function touchRule(id, operator) {
  return {
    id,
    type: "rule",
    fieldKey: TOUCH_STATE_FIELD_KEY,
    operator,
    value: true,
    enabled: true,
  };
}

/** Expression: the property has never been sent an SMS (per the campaign graph). */
export function buildUncontactedContactExpression() {
  return {
    id: "preset-uncontacted-root",
    type: "group",
    combinator: "AND",
    negated: false,
    enabled: true,
    children: [touchRule("preset-uncontacted-touch", "is_uncontacted")],
  };
}

/** Expression: the property has been sent at least one SMS (per the campaign graph). */
export function buildContactedContactExpression() {
  return {
    id: "preset-contacted-root",
    type: "group",
    combinator: "AND",
    negated: false,
    enabled: true,
    children: [touchRule("preset-contacted-touch", "is_contacted")],
  };
}

/**
 * Bucket predicates for a property alias. Index-backed: the graph has a btree
 * on property_id, and never_contacted is NOT NULL.
 */
export function buildContactedTouchSql(alias = "p", options = {}) {
  return `EXISTS (
    SELECT 1 FROM public.campaign_target_graph tg
    WHERE tg.property_id = ${alias}.property_id
      AND ${touchedGraphRowSql("tg", options)}
  )`;
}

export function buildUncontactedTouchSql(alias = "p", options = {}) {
  return `NOT ${buildContactedTouchSql(alias, options)}`;
}

export function buildTouchStateSql(operator, alias = "p", options = {}) {
  if (operator === "is_contacted") return buildContactedTouchSql(alias, options);
  if (operator === "is_uncontacted") return buildUncontactedTouchSql(alias, options);
  throw new Error(`invalid_touch_state_operator:${operator}`);
}

/** Map a UI universe value onto the touch operator ("all" → null = no rule). */
export function touchOperatorForMapStatus(mapStatus) {
  if (mapStatus === "contacted") return "is_contacted";
  if (mapStatus === "uncontacted") return "is_uncontacted";
  return null;
}
