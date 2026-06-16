import { suppressionRules } from "../lib/domain/automation/rules/suppression-rules.js";
import { followUpRules } from "../lib/domain/automation/rules/follow-up-rules.js";
import { stageTemperatureRules } from "../lib/domain/automation/rules/stage-temperature-rules.js";
import { queueEscalationRules } from "../lib/domain/automation/rules/queue-escalation-rules.js";
import { templateHealthRules } from "../lib/domain/automation/rules/template-health-rules.js";
import { senderHealthRules } from "../lib/domain/automation/rules/sender-health-rules.js";
import { marketHealthRules } from "../lib/domain/automation/rules/market-health-rules.js";
import { dealTriggerRules } from "../lib/domain/automation/rules/deal-trigger-rules.js";
import { getDefaultSupabaseClient } from "../lib/supabase/default-client.js";

export const DEFAULT_AUTOMATION_RULES = [
  ...suppressionRules,
  ...stageTemperatureRules,
  ...queueEscalationRules,
  ...followUpRules,
  ...templateHealthRules,
  ...senderHealthRules,
  ...marketHealthRules,
  ...dealTriggerRules,
].map((rule) => ({
  ...rule,
  status: rule.status || "active",
  is_active: rule.is_active !== false,
  condition: rule.condition || {},
  actions: Array.isArray(rule.actions) ? rule.actions : [],
}));

const DEFAULT_RULES_BY_KEY = new Map(
  DEFAULT_AUTOMATION_RULES.map((rule) => [rule.rule_key, rule])
);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function payloadOf(event = {}) {
  return event?.payload && typeof event.payload === "object" ? event.payload : {};
}

function classificationOf(event = {}) {
  const payload = payloadOf(event);
  return payload.classification && typeof payload.classification === "object"
    ? payload.classification
    : {};
}

function textOf(event = {}) {
  const payload = payloadOf(event);
  return clean(
    payload.message_body ||
      payload.body ||
      payload.text ||
      payload.message ||
      payload.raw?.message ||
      payload.raw?.body ||
      ""
  );
}

function termsOf(event = {}) {
  const payload = payloadOf(event);
  const classification = classificationOf(event);
  return [
    textOf(event),
    payload.detected_intent,
    payload.intent,
    payload.inbound_intent,
    payload.compliance_flag,
    payload.objection,
    payload.route_stage,
    payload.stage,
    classification.detected_intent,
    classification.inbound_intent,
    classification.primary_intent,
    classification.compliance_flag,
    classification.objection,
    classification.source,
    classification.category,
  ]
    .map(lower)
    .filter(Boolean)
    .join(" ");
}

function hasText(event = {}, pattern) {
  return pattern.test(termsOf(event));
}

function metric(event = {}, key, fallback = 0) {
  const payload = payloadOf(event);
  const metrics = payload.metrics && typeof payload.metrics === "object" ? payload.metrics : {};
  return asNumber(payload[key] ?? metrics[key], fallback);
}

function matchEventType(rule = {}, event = {}) {
  const event_type = clean(event.event_type);
  const rule_event_type = clean(rule.event_type);
  const event_types = asArray(rule.event_types).map(clean);

  if (rule_event_type && rule_event_type !== event_type) return false;
  if (event_types.length && !event_types.includes(event_type)) return false;
  return true;
}

const MATCHERS = {
  any_inbound_reply(event) {
    return {
      matched: clean(event.event_type) === "inbound_message_received" && Boolean(textOf(event)),
      reason: "inbound_reply_present",
    };
  },

  stop_or_dnc(event) {
    const matched =
      hasText(
        event,
        /\b(stop|unsubscribe|dnc|do not contact|do not text|don't text|remove me|opt[-\s]?out|stop_texting|do_not_contact)\b/i
      ) || lower(classificationOf(event).compliance_flag) === "stop_texting";
    return { matched, reason: "stop_or_dnc_language" };
  },

  wrong_number(event) {
    const matched = hasText(
      event,
      /\b(wrong number|wrong person|wrong_person|wrong_number|not my number|you have the wrong|deceased)\b/i
    );
    return { matched, reason: "wrong_number_language" };
  },

  not_owner_or_tenant(event) {
    const matched = hasText(
      event,
      /\b(not (the )?owner|do not own|don't own|does not own|doesn't own|tenant|renter|i rent|not mine|wrong owner)\b/i
    );
    return { matched, reason: "bad_contact_language" };
  },

  not_interested(event) {
    const matched = hasText(
      event,
      /\b(not interested|no thanks|not selling|not for sale|do not want|don't want|leave me alone|already sold)\b/i
    );
    return { matched, reason: "not_interested_language" };
  },

  asking_price(event) {
    const matched = hasText(
      event,
      /\b(asking price|how much|what('s| is)? (your )?offer|offer\?|price|cash offer|paying|valuation|number in mind)\b/i
    );
    return { matched, reason: "asking_price_language" };
  },

  ownership_confirmed(event) {
    const matched = hasText(
      event,
      /\b(i own|i am the owner|i'm the owner|my property|ownership_confirmed|yes.*owner|owner here)\b/i
    );
    return { matched, reason: "ownership_confirmed_language" };
  },

  outbound_failed(event) {
    return {
      matched: clean(event.event_type) === "outbound_message_failed",
      reason: "outbound_message_failed",
    };
  },

  queue_item_failed(event) {
    return {
      matched: clean(event.event_type) === "queue_item_failed",
      reason: "queue_item_failed",
    };
  },

  hot_lead_untouched(event) {
    return {
      matched: clean(event.event_type) === "hot_lead_untouched",
      reason: "hot_lead_untouched",
    };
  },

  delivered_no_reply(event) {
    const payload = payloadOf(event);
    return {
      matched:
        clean(event.event_type) === "outbound_message_delivered" &&
        payload.has_reply_since_delivery !== true,
      reason: "delivered_no_reply",
    };
  },

  high_opt_out_template(event) {
    const opt_out_rate = metric(event, "opt_out_rate", 0);
    const threshold = metric(event, "opt_out_rate_threshold", 0.012);
    return {
      matched: clean(event.event_type) === "template_performance_changed" && opt_out_rate >= threshold,
      reason: "high_opt_out_template",
      details: { opt_out_rate, threshold },
    };
  },

  scale_template(event) {
    const reply_rate = metric(event, "reply_rate", 0);
    const opt_out_rate = metric(event, "opt_out_rate", 0);
    return {
      matched:
        clean(event.event_type) === "template_performance_changed" &&
        reply_rate >= metric(event, "reply_rate_scale_threshold", 0.08) &&
        opt_out_rate <= metric(event, "opt_out_rate_scale_ceiling", 0.005),
      reason: "scale_template",
      details: { reply_rate, opt_out_rate },
    };
  },

  sender_failure_spike(event) {
    const failure_rate = metric(event, "failure_rate", 0);
    const recent_failed_count = metric(event, "recent_failed_count", 0);
    return {
      matched:
        clean(event.event_type) === "sender_health_changed" &&
        (failure_rate >= metric(event, "failure_rate_threshold", 0.05) ||
          recent_failed_count >= metric(event, "recent_failed_count_threshold", 3)),
      reason: "sender_failure_spike",
      details: { failure_rate, recent_failed_count },
    };
  },

  market_opt_out_pressure(event) {
    const opt_out_rate = metric(event, "opt_out_rate", 0);
    return {
      matched:
        clean(event.event_type) === "market_health_changed" &&
        opt_out_rate >= metric(event, "opt_out_rate_threshold", 0.012),
      reason: "market_opt_out_pressure",
      details: { opt_out_rate },
    };
  },

  buyer_match_candidate(event) {
    const match_score = metric(event, "buyer_match_score", 0);
    return {
      matched:
        clean(event.event_type) === "deal_intelligence_changed" &&
        match_score >= metric(event, "buyer_match_score_threshold", 85),
      reason: "buyer_match_candidate",
      details: { match_score },
    };
  },
};

function hydrateRule(row = {}) {
  const base = DEFAULT_RULES_BY_KEY.get(row.rule_key) || {};
  return {
    ...base,
    ...row,
    condition: row.condition || base.condition || {},
    actions: Array.isArray(row.actions) ? row.actions : base.actions || [],
    dry_run_default:
      typeof row.dry_run_default === "boolean"
        ? row.dry_run_default
        : base.dry_run_default !== false,
  };
}

export async function loadActiveAutomationRules(options = {}) {
  const db = options.supabaseClient || options.supabase || getDefaultSupabaseClient();
  const fallback_rules = DEFAULT_AUTOMATION_RULES.filter((rule) => rule.is_active !== false);

  if (!db?.from || options.useDefaultsOnly) {
    return fallback_rules.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  try {
    const { data, error } = await db
      .from("automation_rules")
      .select("*")
      .eq("is_active", true)
      .eq("status", "active")
      .order("priority", { ascending: true });

    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length && options.fallbackToDefaults !== false) {
      return fallback_rules.sort((a, b) => (a.priority || 100) - (b.priority || 100));
    }
    return rows.map(hydrateRule).sort((a, b) => (a.priority || 100) - (b.priority || 100));
  } catch {
    if (options.fallbackToDefaults === false) return [];
    return fallback_rules.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }
}

export function matchAutomationRule(rule = {}, event = {}) {
  if (!matchEventType(rule, event)) {
    return { matched: false, reason: "event_type_mismatch" };
  }

  if (rule.is_active === false || lower(rule.status || "active") !== "active") {
    return { matched: false, reason: "rule_inactive" };
  }

  const matcher_key = clean(rule.condition?.matcher || rule.matcher || "");
  const matcher = MATCHERS[matcher_key];
  if (!matcher) {
    return { matched: false, reason: matcher_key ? "unknown_matcher" : "missing_matcher" };
  }

  const result = matcher(event);
  return {
    matched: Boolean(result?.matched),
    reason: result?.reason || matcher_key,
    matcher: matcher_key,
    details: result?.details || {},
  };
}

export async function listAutomationRules(options = {}) {
  return loadActiveAutomationRules(options);
}

export function getDefaultAutomationRule(rule_key) {
  return DEFAULT_RULES_BY_KEY.get(rule_key) || null;
}
