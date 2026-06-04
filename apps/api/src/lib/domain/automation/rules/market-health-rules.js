export const marketHealthRules = [
  {
    rule_key: "market.opt_out_pressure_alert",
    event_type: "market_health_changed",
    action_type: "create_alert",
    priority: 70,
    dry_run_default: false,
    description: "Market-level opt-out pressure creates an ops notification.",
    condition: { matcher: "market_opt_out_pressure" },
    actions: [
      {
        action_type: "create_alert",
        params: {
          severity: "warning",
          notification_type: "market_opt_out_pressure",
          title: "Market opt-out pressure rising",
        },
      },
    ],
  },
];

export default marketHealthRules;
