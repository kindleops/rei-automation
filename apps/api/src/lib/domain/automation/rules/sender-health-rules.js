export const senderHealthRules = [
  {
    rule_key: "sender.failure_spike_review",
    event_type: "sender_health_changed",
    action_type: "mark_sender_health",
    priority: 60,
    dry_run_default: true,
    description:
      "Sender failure spikes are marked review/pause-candidate only unless live pausing is explicitly enabled.",
    condition: { matcher: "sender_failure_spike" },
    actions: [
      {
        action_type: "mark_sender_health",
        dry_run: true,
        params: { recommendation: "REVIEW", reason: "delivery_failure_spike" },
      },
    ],
  },
];

export default senderHealthRules;
