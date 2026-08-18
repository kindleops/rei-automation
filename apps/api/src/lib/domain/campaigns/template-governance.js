/**
 * Outbound template governance.
 *
 * `ownership_template_rotation_control` is the system of record for whether a
 * template may go out on the wire. Until now nothing in the campaign assignment
 * path consulted it, so assignment and governance were two disconnected
 * systems that happened to share a table of templates.
 *
 * Production state that motivated this (measured 2026-08-17, read-only), across
 * the 1,331 ready targets that carried a template_id:
 *
 *     rotation_status = 'pause' (daily_cap 0) ....... 593 targets
 *     absent from rotation control entirely ......... 699 targets
 *     rotation-approved ('testing') .................  39 targets
 *
 * So ~97% of assigned templates were ones governance either paused outright or
 * had never seen. Those targets were still presented as send-ready.
 *
 * POLICY: FAIL CLOSED
 * A template absent from rotation control is NOT eligible.
 *
 * This is the deliberate choice, not an accident of implementation. The
 * alternative — treating "ungoverned" as "allowed" — makes the control table
 * a denylist, which means any of the 8,715 active templates is sendable until
 * somebody remembers to pause it. That inverts the safety property: the default
 * for an unreviewed template becomes "ship it".
 *
 * The cost is visible and bounded: governance currently covers 21 templates, so
 * fail-closed sharply narrows the eligible pool. That is the correct signal —
 * it reports the true size of the reviewed catalog instead of masking it. The
 * remedy is to govern more templates, not to loosen the gate.
 *
 * This applies where the governance system applies: the ownership-check
 * rotation surface. `governanceApplies()` is the single place that decides
 * that, so the blast radius of the policy is explicit rather than implied.
 */

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

/**
 * Rotation states that permit outbound send. Anything not listed here blocks,
 * including unknown/new states — an unrecognised status is not a licence.
 */
const SENDABLE_ROTATION_STATUSES = new Set(["active", "testing", "promote"]);

/** Reason codes. Stable strings — they land in target metadata and logs. */
export const GOVERNANCE_REASONS = {
  OK: "governed_ok",
  ABSENT: "governance_absent",
  PAUSED: "governance_paused",
  INACTIVE: "template_inactive",
  NO_CAP: "governance_daily_cap_zero",
  CAP_EXHAUSTED: "governance_daily_cap_exhausted",
  NO_BODY: "template_body_empty",
  UNMEASURABLE: "governance_unmeasurable",
};

/**
 * Does the rotation-control system govern this template surface at all?
 *
 * Rotation control is scoped to the ownership-check outbound surface. Applying
 * it to unrelated use cases would block traffic it was never designed to
 * describe, so the scope is stated once, here.
 */
export function governanceApplies(useCase) {
  return lower(useCase) === "ownership_check";
}

/**
 * Index rotation-control rows by template_id for O(1) lookup.
 */
export function indexGovernance(rows = []) {
  const byId = new Map();
  for (const row of rows) {
    const id = clean(row?.template_id);
    if (id) byId.set(id, row);
  }
  return byId;
}

/**
 * Decide whether one template may be selected for outbound send.
 *
 * @returns {{ok: boolean, reason: string, detail?: string}}
 */
export function evaluateTemplateGovernance(template, governanceRow, options = {}) {
  const applies = options.applies !== false;
  const templateId = clean(template?.template_id || template?.id);

  // Properties of the template itself are checked regardless of governance
  // scope — an inactive template or one with no body can never be sent, and a
  // body we cannot read is content we cannot audit.
  if (template?.is_active !== true) {
    return { ok: false, reason: GOVERNANCE_REASONS.INACTIVE, detail: templateId };
  }
  if (!clean(template?.template_body)) {
    return { ok: false, reason: GOVERNANCE_REASONS.NO_BODY, detail: templateId };
  }

  if (!applies) return { ok: true, reason: GOVERNANCE_REASONS.OK };

  if (!governanceRow) {
    return { ok: false, reason: GOVERNANCE_REASONS.ABSENT, detail: templateId };
  }

  const status = lower(governanceRow.rotation_status);
  if (!SENDABLE_ROTATION_STATUSES.has(status)) {
    return {
      ok: false,
      reason: GOVERNANCE_REASONS.PAUSED,
      detail: `${templateId}:${status || "unset"}`,
    };
  }

  // Cap arithmetic. `null`/`undefined` mean "not measured", which is not the
  // same as zero — coercing an unreadable cap to 0 would block, and coercing it
  // to Infinity would allow. Neither guess is honest, so an unmeasurable cap is
  // its own outcome.
  const rawCap = governanceRow.daily_cap;
  if (rawCap === null || rawCap === undefined || rawCap === "") {
    return { ok: false, reason: GOVERNANCE_REASONS.UNMEASURABLE, detail: `${templateId}:daily_cap` };
  }
  const cap = Number(rawCap);
  if (!Number.isFinite(cap)) {
    return { ok: false, reason: GOVERNANCE_REASONS.UNMEASURABLE, detail: `${templateId}:daily_cap` };
  }
  if (cap <= 0) {
    return { ok: false, reason: GOVERNANCE_REASONS.NO_CAP, detail: templateId };
  }

  // Usage against the cap, when the control row reports it. Absent usage is
  // treated as zero used — the cap itself is the binding rail, and this field
  // is a rolling counter rather than a guarantee.
  const used = Number(governanceRow.last_40d_total_sent ?? 0);
  if (Number.isFinite(used) && used >= cap) {
    return {
      ok: false,
      reason: GOVERNANCE_REASONS.CAP_EXHAUSTED,
      detail: `${templateId}:${used}/${cap}`,
    };
  }

  return { ok: true, reason: GOVERNANCE_REASONS.OK };
}

/**
 * Canonical ordering for the eligible pool.
 *
 * Deterministic selection hashes a seed and indexes into this list, so the list
 * must have one stable order for a given set of templates — otherwise the same
 * target can resolve to different templates on different runs purely because
 * the database returned rows in a different sequence.
 *
 * Order is by governance rank first (so the pool's shape reflects the system's
 * own intent), then language, then stage, then template_id as the unique
 * tiebreak. template_id alone would be sufficient for stability; the leading
 * keys make the ordering semantically meaningful rather than arbitrary.
 */
const ROTATION_RANK = { promote: 0, active: 1, testing: 2 };

export function canonicalTemplateOrder(templates = [], governanceById = new Map()) {
  const rank = (row) => {
    const g = governanceById.get(clean(row?.template_id || row?.id));
    const status = lower(g?.rotation_status);
    return ROTATION_RANK[status] ?? 99;
  };

  return [...templates].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;

    const byLang = lower(left?.language).localeCompare(lower(right?.language));
    if (byLang !== 0) return byLang;

    const byStage = lower(left?.stage_code).localeCompare(lower(right?.stage_code));
    if (byStage !== 0) return byStage;

    // Unique, always-present tiebreak. Guarantees a total order, which is what
    // makes selection reproducible.
    return clean(left?.template_id || left?.id).localeCompare(
      clean(right?.template_id || right?.id)
    );
  });
}

/**
 * Filter a pool to templates governance permits, preserving canonical order.
 *
 * @returns {{eligible: Array, rejected: Array<{template_id: string, reason: string}>}}
 */
export function applyGovernance(templates = [], governanceById = new Map(), useCase = "") {
  const applies = governanceApplies(useCase);
  const eligible = [];
  const rejected = [];

  for (const template of canonicalTemplateOrder(templates, governanceById)) {
    const id = clean(template?.template_id || template?.id);
    const verdict = evaluateTemplateGovernance(template, governanceById.get(id), { applies });
    if (verdict.ok) eligible.push(template);
    else rejected.push({ template_id: id, reason: verdict.reason, detail: verdict.detail });
  }

  return { eligible, rejected, governed: applies };
}

/**
 * Load rotation-control rows. Small table (tens of rows), so a single read is
 * sufficient — but it is still ordered and bounded rather than unbounded.
 */
export async function loadGovernance(supabase) {
  const { data, error } = await supabase
    .from("ownership_template_rotation_control")
    .select("template_id, rotation_status, language, daily_cap, traffic_weight, block_reason, last_40d_total_sent")
    .order("template_id", { ascending: true })
    .range(0, 999);

  if (error) throw error;
  return indexGovernance(Array.isArray(data) ? data : []);
}
