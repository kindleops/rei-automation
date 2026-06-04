export const suppressionRules = [
  {
    rule_key: "suppression.stop_dnc",
    event_type: "inbound_message_received",
    action_type: "suppress_phone",
    priority: 10,
    dry_run_default: false,
    description:
      "STOP, unsubscribe, DNC, and do-not-contact inbound language suppresses the phone and cancels pending queue work.",
    condition: { matcher: "stop_or_dnc" },
    actions: [
      {
        action_type: "suppress_phone",
        params: {
          suppression_type: "opt_out",
          suppression_reason: "stop_or_dnc_keyword",
        },
      },
      {
        action_type: "cancel_pending_queue",
        params: { reason: "stop_or_dnc_keyword" },
      },
      {
        action_type: "create_alert",
        params: {
          severity: "warning",
          notification_type: "automation_suppression",
          title: "Automation suppression applied",
        },
      },
    ],
  },
  {
    rule_key: "suppression.wrong_number",
    event_type: "inbound_message_received",
    action_type: "suppress_phone",
    priority: 11,
    dry_run_default: false,
    description:
      "Wrong-number inbound language suppresses the phone, lowers contact confidence, and cancels pending queue work.",
    condition: { matcher: "wrong_number" },
    actions: [
      {
        action_type: "suppress_phone",
        params: {
          suppression_type: "wrong_number",
          suppression_reason: "wrong_number_keyword",
        },
      },
      {
        action_type: "mark_bad_contact",
        params: { reason: "wrong_number", contact_confidence: "low" },
      },
      {
        action_type: "cancel_pending_queue",
        params: { reason: "wrong_number_keyword" },
      },
    ],
  },
  {
    rule_key: "suppression.not_owner_bad_contact",
    event_type: "inbound_message_received",
    action_type: "mark_bad_contact",
    priority: 12,
    dry_run_default: false,
    description:
      "Not-owner, tenant, and does-not-own signals mark the contact as bad or review-needed and stop pending touches.",
    condition: { matcher: "not_owner_or_tenant" },
    actions: [
      {
        action_type: "mark_bad_contact",
        params: { reason: "not_owner_or_tenant", contact_confidence: "low" },
      },
      {
        action_type: "cancel_pending_queue",
        params: { reason: "not_owner_or_tenant" },
      },
      {
        action_type: "patch_thread_state",
        params: {
          stage: "wrong_number",
          priority: "low",
          metadata: { automation_stage: "bad_contact" },
        },
      },
    ],
  },
];

export default suppressionRules;
