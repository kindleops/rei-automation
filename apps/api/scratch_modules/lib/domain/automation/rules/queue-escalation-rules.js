export const queueEscalationRules = [
  {
    rule_key: "queue.outbound_failed_alert",
    event_type: "outbound_message_failed",
    action_type: "create_alert",
    priority: 30,
    dry_run_default: false,
    description: "Failed outbound delivery creates an operations alert only.",
    condition: { matcher: "outbound_failed" },
    actions: [
      {
        action_type: "create_alert",
        params: {
          severity: "warning",
          notification_type: "outbound_failure",
          title: "Outbound message failed",
        },
      },
    ],
  },
  {
    rule_key: "queue.item_failed_alert",
    event_type: "queue_item_failed",
    action_type: "create_alert",
    priority: 31,
    dry_run_default: false,
    description: "Failed queue items create an operations alert only.",
    condition: { matcher: "queue_item_failed" },
    actions: [
      {
        action_type: "create_alert",
        params: {
          severity: "warning",
          notification_type: "queue_item_failed",
          title: "Queue item failed",
        },
      },
    ],
  },
  {
    rule_key: "queue.hot_lead_untouched_alert",
    event_type: "hot_lead_untouched",
    action_type: "create_alert",
    priority: 32,
    dry_run_default: false,
    description: "Hot leads that cross the untouched threshold create a notification.",
    condition: { matcher: "hot_lead_untouched" },
    actions: [
      {
        action_type: "create_alert",
        params: {
          severity: "warning",
          notification_type: "hot_lead_untouched",
          title: "Hot lead waiting",
        },
      },
    ],
  },
];

export default queueEscalationRules;
