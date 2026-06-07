const DEFAULT_BLOCKED_SENDER_NUMBERS = Object.freeze([
  "+14704920588",
  "+14693131600",
]);

const DEFAULT_BLOCKED_TEMPLATE_IDS = Object.freeze([
  "208481",
  "204257",
  "204529",
  "204561",
  "204705",
  "204721",
  "207681",
]);

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

export function isSmsSenderHealthBlocked(
  sender_number,
  { env = process.env, system_control = {} } = {}
) {
  const normalized_sender = normalizePhone(sender_number);
  if (!normalized_sender) return false;
  return getDefaultSmsHealthGuardConfig(env, system_control)
    .blocked_sender_numbers
    .includes(normalized_sender);
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
    ["approved_regional_fallback", "approved_state_fallback"].includes(tier) &&
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
