export const WORKFLOW_CHANNELS = Object.freeze([
  "sms",
  "email",
  "rvm",
  "direct_mail",
  "multichannel",
]);

export const WORKFLOW_TYPES = Object.freeze([
  "outbound",
  "follow_up",
  "auto_reply",
  "nurture",
  "reactivation",
  "deal_execution",
]);

export const WORKFLOW_STATUSES = Object.freeze([
  "draft",
  "active",
  "paused",
  "archived",
]);

export const WORKFLOW_NODE_TYPES = Object.freeze([
  "trigger_new_lead",
  "trigger_inbound_sms_received",
  "trigger_inbound_email_received",
  "trigger_sms_delivered",
  "trigger_sms_failed",
  "trigger_no_reply_after_delay",
  "trigger_follow_up_due",
  "trigger_seller_replied",
  "trigger_seller_positive_reply",
  "trigger_seller_negative_reply",
  "trigger_seller_price_reply",
  "trigger_seller_opted_out",
  "trigger_wrong_number_detected",
  "trigger_status_changed",
  "trigger_stage_changed",
  "trigger_temperature_changed",
  "trigger_buyer_match_found",
  "trigger_comp_confidence_high",
  "trigger_offer_approved",
  "trigger_contract_signed",
  "trigger_title_issue_detected",
  "trigger_queue_item_failed",
  "trigger_sender_health_dropped",
  "trigger_template_performance_changed",
  "trigger_market_health_changed",
  "send_sms",
  "send_email",
  "send_rvm",
  "send_direct_mail",
  "send_offer",
  "wait",
  "wait_until_business_hours",
  "wait_until_local_time_window",
  "wait_until_weekday",
  "wait_until_follow_up_due",
  "condition",
  "condition_seller_replied",
  "condition_no_reply",
  "condition_language",
  "condition_market",
  "condition_state",
  "condition_property_type",
  "condition_asset_type",
  "condition_equity_above",
  "condition_motivation_score_above",
  "condition_temperature",
  "condition_stage",
  "condition_buyer_demand_above",
  "condition_offer_approved",
  "condition_contract_signed",
  "branch",
  "update_status",
  "update_stage",
  "update_temperature",
  "schedule_followup",
  "cancel_queue",
  "suppress_phone",
  "assign_operator",
  "create_task",
  "create_notification",
  "trigger_comp_pull",
  "trigger_buyer_match",
  "run_comps",
  "run_buyer_match",
  "calculate_offer",
  "push_to_underwriting",
  "require_approval",
  "generate_contract",
  "send_contract",
  "email_title_company",
  "move_to_closing",
  "suppress_owner",
  "pause_workflow",
  "stop_workflow",
]);

export const SEND_NODE_TYPES = Object.freeze([
  "send_sms",
  "send_email",
  "send_rvm",
  "send_direct_mail",
  "send_offer",
  "send_contract",
  "email_title_company",
]);

export const APPROVAL_NODE_TYPES = Object.freeze([
  "require_approval",
  "generate_contract",
  "send_contract",
  "send_offer",
]);

export const TRANSLATION_LANGUAGES = Object.freeze([
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese" },
  { code: "vi", label: "Vietnamese" },
  { code: "tl", label: "Tagalog" },
  { code: "ht", label: "Haitian Creole" },
  { code: "custom", label: "Custom" },
]);

export const PERSONALIZATION_TOKENS = Object.freeze([
  "first_name",
  "seller_display_name",
  "property_address",
  "city",
  "state",
  "zip",
  "market",
  "agent_name",
  "property_type",
  "unit_count",
  "asking_price",
  "offer_price",
]);

export function cleanWorkflowValue(value) {
  return String(value ?? "").trim();
}

export function normalizeWorkflowKey(value) {
  return cleanWorkflowValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function isSupportedNodeType(nodeType) {
  return WORKFLOW_NODE_TYPES.includes(cleanWorkflowValue(nodeType));
}

export function isSendNodeType(nodeType) {
  return SEND_NODE_TYPES.includes(cleanWorkflowValue(nodeType));
}

export function isApprovalNodeType(nodeType) {
  return APPROVAL_NODE_TYPES.includes(cleanWorkflowValue(nodeType));
}

export function isSupportedWorkflowStatus(status) {
  return WORKFLOW_STATUSES.includes(cleanWorkflowValue(status));
}

export function isSupportedWorkflowChannel(channel) {
  return WORKFLOW_CHANNELS.includes(cleanWorkflowValue(channel));
}

export function isSupportedWorkflowType(type) {
  return WORKFLOW_TYPES.includes(cleanWorkflowValue(type));
}
