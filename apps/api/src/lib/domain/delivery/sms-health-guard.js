// This module stays import-pure (proof scripts load it under plain `node`);
// the system_control reader is imported lazily on the async path below.

// Hardcoded blocklists are deliberately EMPTY (disposition 2026-09-09).
// The former literals entered via ff571386 ("WIP integration checkpoint",
// 2026-06-03, unreviewed) with no recorded rationale; the file's own doc called
// them "emergency defaults ... to be moved into managed system-control values".
// Provenance + production-data review, per entry:
//   templates 204529 / 208481 -> BLOCK_OBSOLETE. Governance had both `testing`
//     since 2026-05-16 and they delivered at/above the fleet; the only
//     reconstructable trigger (a >=20% all-time failure cut) was never recorded
//     and never applied to open peers with worse numbers. Authority:
//     ownership_template_rotation_control (rotation_status, min_delivery_rate).
//   templates 204257 / 204561 / 204705 / 204721 / 207681 -> unchanged in effect:
//     governance `pause` or no governance row, AND system_control.sms_blocked_template_ids.
//   senders ••0588 (Atlanta) / ••1600 (Dallas) -> BLOCK PRESERVED as an operator
//     decision pending a canary (re-affirmed in the SQL twin three days after the
//     JS), carried by system_control.sms_blocked_sender_numbers -- not by code.
// Rule: no template or sender may be blocked by a literal in this file. Blocks are
// operator-visible only: system_control.sms_blocked_* or SMS_BLOCKED_* env.
// Enforced by tests/critical/sms-health-guard-defaults-empty.test.mjs.
const DEFAULT_BLOCKED_SENDER_NUMBERS = Object.freeze([]);
const DEFAULT_BLOCKED_TEMPLATE_IDS = Object.freeze([]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizePhone(value) {
  const raw = clean(value);
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value)
    .split(",")
    .map((entry) => clean(entry))
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function mergeLists(...lists) {
  return [...new Set(lists.flat().map(clean).filter(Boolean))];
}

export function getDefaultSmsHealthGuardConfig(env = process.env, system_control = {}) {
  return {
    blocked_sender_numbers: mergeLists(
      DEFAULT_BLOCKED_SENDER_NUMBERS,
      parseList(env.SMS_BLOCKED_SENDER_NUMBERS),
      parseList(system_control.sms_blocked_sender_numbers)
    ).map(normalizePhone),
    blocked_template_ids: mergeLists(
      DEFAULT_BLOCKED_TEMPLATE_IDS,
      parseList(env.SMS_BLOCKED_TEMPLATE_IDS),
      parseList(system_control.sms_blocked_template_ids)
    ),
    require_local_routing: parseBoolean(
      system_control.require_local_routing ?? env.SMS_REQUIRE_LOCAL_ROUTING,
      false
    ),
    allow_regional_fallback_for_first_touch: parseBoolean(
      system_control.allow_regional_fallback_for_first_touch ??
        env.SMS_ALLOW_REGIONAL_FALLBACK_FOR_FIRST_TOUCH,
      false
    ),
  };
}

/**
 * ONE ANSWER to "can this template / sender participate in production sending?"
 *
 * Dispatch refuses via evaluateSmsHealthGuard(). Until 2026-09-09 nothing
 * upstream (template assignment, campaign enqueue, manual sender fallback)
 * consulted the same lists, so assignment produced rows that dispatch then
 * deterministically refused (24 blocked_template_id refusals on the first
 * live day). These helpers expose the guard's OWN merged config so every
 * selector sees exactly what dispatch will enforce. No new registry: the
 * durable authority stays canonical governance (ownership_template_rotation_control)
 * and the sender registry (textgrid_numbers); the guard remains a runtime layer
 * for dynamic env / system_control lists.
 */
async function defaultSystemValueReader() {
  const [{ hasSupabaseConfig }, { getSystemValue }] = await Promise.all([
    import("../../supabase/client.js"),
    import("../../system-control.js"),
  ]);
  return hasSupabaseConfig() ? getSystemValue : async () => null;
}

export async function loadSmsHealthGuardSystemControl(getSystemValueImpl = null) {
  const read = typeof getSystemValueImpl === "function"
    ? getSystemValueImpl
    : await defaultSystemValueReader();
  return {
    sms_blocked_sender_numbers: await read("sms_blocked_sender_numbers"),
    sms_blocked_template_ids: await read("sms_blocked_template_ids"),
    require_local_routing: await read("require_local_routing"),
    allow_regional_fallback_for_first_touch: await read("allow_regional_fallback_for_first_touch"),
  };
}

export function getDispatchBlockedSets(env = process.env, system_control = {}) {
  const config = getDefaultSmsHealthGuardConfig(env, system_control);
  return {
    template_ids: new Set(config.blocked_template_ids.map(clean)),
    sender_numbers: new Set(config.blocked_sender_numbers.map(normalizePhone).filter(Boolean)),
  };
}

export async function loadDispatchBlockedSets({ getSystemValue: getSystemValueImpl = null, env = process.env } = {}) {
  const system_control = await loadSmsHealthGuardSystemControl(getSystemValueImpl);
  return getDispatchBlockedSets(env, system_control);
}

export function isTemplateDispatchBlocked(templateId, sets) {
  return Boolean(sets?.template_ids?.has(clean(templateId)));
}

export function isSenderDispatchBlocked(phoneNumber, sets) {
  const normalized = normalizePhone(phoneNumber);
  return Boolean(normalized && sets?.sender_numbers?.has(normalized));
}

export function evaluateSmsHealthGuard({
  from_phone_number = null,
  sender_number = null,
  template_id = null,
  selected_template_id = null,
  routing_tier = null,
  first_touch = false,
  require_local_routing = null,
  allow_regional_fallback_for_first_touch = null,
  metadata = {},
  env = process.env,
  system_control = {},
  now = new Date().toISOString(),
} = {}) {
  const config = getDefaultSmsHealthGuardConfig(env, system_control);
  const normalized_sender = normalizePhone(from_phone_number || sender_number);
  const resolved_template_id = clean(
    template_id ||
      selected_template_id ||
      metadata?.selected_template_id ||
      metadata?.template_id ||
      metadata?.template?.id ||
      metadata?.selected_template?.id
  );
  const tier = lower(routing_tier || metadata?.routing_tier || metadata?.selected_sender_diagnostics?.routing_tier);
  const is_first_touch = parseBoolean(
    first_touch ?? metadata?.is_first_touch,
    Number(metadata?.touch_number || 0) === 1
  );
  const local_required = parseBoolean(
    require_local_routing,
    parseBoolean(config.require_local_routing, false)
  );
  const allow_first_touch_regional = parseBoolean(
    allow_regional_fallback_for_first_touch,
    parseBoolean(config.allow_regional_fallback_for_first_touch, false)
  );

  const diagnostics = {
    checked_at: now,
    sender_number: normalized_sender || null,
    template_id: resolved_template_id || null,
    routing_tier: tier || null,
    first_touch: is_first_touch,
    require_local_routing: local_required,
    allow_regional_fallback_for_first_touch: allow_first_touch_regional,
    blocked_sender_numbers: config.blocked_sender_numbers,
    blocked_template_ids: config.blocked_template_ids,
  };

  if (normalized_sender && config.blocked_sender_numbers.includes(normalized_sender)) {
    return {
      allowed: false,
      reason: "blocked_sender_number",
      block_class: "sender_health_block",
      cooldown_until: null,
      diagnostics,
    };
  }

  if (resolved_template_id && config.blocked_template_ids.includes(resolved_template_id)) {
    return {
      allowed: false,
      reason: "blocked_template_id",
      block_class: "template_health_block",
      cooldown_until: null,
      diagnostics,
    };
  }

  if (
    tier === "approved_regional_fallback" &&
    (local_required || (is_first_touch && !allow_first_touch_regional))
  ) {
    return {
      allowed: false,
      reason: local_required
        ? "regional_fallback_blocked_require_local_routing"
        : "regional_fallback_blocked_first_touch",
      block_class: "routing_health_block",
      cooldown_until: null,
      diagnostics,
    };
  }

  return {
    allowed: true,
    reason: "sms_health_guard_passed",
    block_class: null,
    cooldown_until: null,
    diagnostics,
  };
}

export const DEFAULT_SMS_HEALTH_GUARD_BLOCKLISTS = {
  blocked_sender_numbers: DEFAULT_BLOCKED_SENDER_NUMBERS,
  blocked_template_ids: DEFAULT_BLOCKED_TEMPLATE_IDS,
};

export default evaluateSmsHealthGuard;
