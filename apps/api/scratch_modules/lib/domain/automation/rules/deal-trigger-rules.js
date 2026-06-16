export const dealTriggerRules = [
  {
    rule_key: "deal.buyer_match_candidate",
    event_type: "deal_intelligence_changed",
    action_type: "create_alert",
    priority: 80,
    dry_run_default: false,
    description:
      "High-confidence buyer/deal intelligence signals create a review notification only.",
    condition: { matcher: "buyer_match_candidate" },
    actions: [
      {
        action_type: "create_alert",
        params: {
          severity: "info",
          notification_type: "buyer_match_candidate",
          title: "Buyer match candidate",
        },
      },
    ],
  },
];

export default dealTriggerRules;
