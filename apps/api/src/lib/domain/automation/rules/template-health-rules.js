export const templateHealthRules = [
  {
    rule_key: "template.high_opt_out_review",
    event_type: "template_performance_changed",
    action_type: "mark_template_recommendation",
    priority: 50,
    dry_run_default: false,
    description: "High opt-out templates are marked for review; no template is deleted.",
    condition: { matcher: "high_opt_out_template" },
    actions: [
      {
        action_type: "mark_template_recommendation",
        params: { recommendation: "REVIEW", reason: "high_opt_out_rate" },
      },
    ],
  },
  {
    rule_key: "template.scale_candidate",
    event_type: "template_performance_changed",
    action_type: "mark_template_recommendation",
    priority: 51,
    dry_run_default: false,
    description:
      "High-reply and low-opt-out templates are marked as scale candidates.",
    condition: { matcher: "scale_template" },
    actions: [
      {
        action_type: "mark_template_recommendation",
        params: { recommendation: "SCALE", reason: "high_reply_low_opt_out" },
      },
    ],
  },
];

export default templateHealthRules;
