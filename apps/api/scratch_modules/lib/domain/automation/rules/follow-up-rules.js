export const followUpRules = [
  {
    rule_key: "followup.delivered_no_reply_once",
    event_type: "outbound_message_delivered",
    action_type: "schedule_follow_up",
    priority: 40,
    dry_run_default: true,
    description:
      "Delivered/no-reply follow-up planning is idempotent and dry-run by default.",
    condition: { matcher: "delivered_no_reply" },
    actions: [
      {
        action_type: "schedule_follow_up",
        dry_run: true,
        params: {
          intent: "unclear",
          reason: "delivered_no_reply",
        },
      },
    ],
  },
];

export default followUpRules;
