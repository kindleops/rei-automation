function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pick(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && clean(value) !== "") return value;
  }
  return null;
}

/** PostgREST-safe column projections verified against production schema. */
export const SEND_QUEUE_HISTORY_SELECT =
  "template_id,metadata,to_phone_number,created_at,scheduled_for,use_case_template,selected_template_id,pipeline_stage";

export const MESSAGE_EVENTS_HISTORY_SELECT =
  "template_id,metadata,to_phone_number,created_at,sent_at,event_timestamp,master_owner_id";

/**
 * Normalize a send_queue or message_events row for template/stage history evaluation.
 * stage_code and use_case live in metadata when not top-level columns.
 */
export function normalizeOutreachHistoryRow(row = {}) {
  const metadata = ensureObject(row.metadata);
  return {
    template_id: clean(
      pick(row.template_id, row.selected_template_id, metadata.template_id, metadata.selected_template_id, metadata.template?.id)
    ) || null,
    to_phone_number: clean(pick(row.to_phone_number, row.phone_number, row.recipient_phone)) || null,
    created_at: pick(row.created_at, row.sent_at, row.scheduled_for, row.event_timestamp, row.inserted_at) || null,
    use_case: clean(
      pick(row.use_case_template, metadata.template_use_case, row.template_use_case, metadata.use_case, row.use_case)
    ) || null,
    stage_code: clean(
      pick(metadata.template_stage_code, metadata.selected_template_stage_code, row.pipeline_stage, row.stage_code, metadata.stage_code)
    ) || null,
    metadata,
  };
}

export function historyRowMatchesSelector(row = {}, selector = {}, normalizedPhoneFn = (v) => clean(v)) {
  const normalized = normalizeOutreachHistoryRow(row);
  const phone = normalizedPhoneFn(selector.canonical_e164 || selector.to_phone_number);
  const row_phone = normalizedPhoneFn(normalized.to_phone_number);
  if (phone && row_phone && phone !== row_phone) return false;

  const use_case = clean(selector.use_case);
  if (use_case && normalized.use_case && lower(normalized.use_case) !== lower(use_case)) return false;

  const stage_code = clean(selector.stage_code);
  if (stage_code && normalized.stage_code && lower(normalized.stage_code) !== lower(stage_code)) return false;

  return Boolean(normalized.template_id);
}

export function collectRecentTemplateIdsFromRows(rows = [], { cutoff_ms, selector, normalizePhoneFn } = {}) {
  const recent_template_ids = new Set();
  const normalizePhone = normalizePhoneFn || ((v) => clean(v));

  for (const row of rows) {
    const normalized = normalizeOutreachHistoryRow(row);
    const created_at_ms = normalized.created_at ? Date.parse(String(normalized.created_at)) : 0;
    if (!Number.isFinite(created_at_ms) || created_at_ms < cutoff_ms) continue;
    if (!historyRowMatchesSelector(row, selector, normalizePhone)) continue;
    if (normalized.template_id) recent_template_ids.add(normalized.template_id);
  }

  return [...recent_template_ids];
}

export function isPostgrestQueryError(result) {
  return Boolean(result?.error);
}