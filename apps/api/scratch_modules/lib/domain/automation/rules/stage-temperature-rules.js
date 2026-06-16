export const stageTemperatureRules = [
  {
    rule_key: "stage.inbound_new_reply",
    event_type: "inbound_message_received",
    action_type: "patch_thread_state",
    priority: 20,
    dry_run_default: false,
    description: "Any inbound reply marks the thread as needing attention.",
    condition: { matcher: "any_inbound_reply" },
    actions: [
      {
        action_type: "patch_thread_state",
        params: {
          status: "open",
          stage: "new_reply",
          priority: "high",
          metadata: { automation_status: "new_reply" },
        },
      },
    ],
  },
  {
    rule_key: "stage.asking_price_hot",
    event_type: "inbound_message_received",
    action_type: "patch_thread_state",
    priority: 21,
    dry_run_default: false,
    description:
      "Asking-price language escalates the thread to hot priority without sending a response.",
    condition: { matcher: "asking_price" },
    actions: [
      {
        action_type: "patch_thread_state",
        params: {
          status: "open",
          stage: "needs_offer",
          priority: "urgent",
          is_urgent: true,
          metadata: {
            automation_stage: "asking_price_received",
            lead_temperature: "hot",
          },
        },
      },
    ],
  },
  {
    rule_key: "stage.not_interested_cold",
    event_type: "inbound_message_received",
    action_type: "patch_thread_state",
    priority: 22,
    dry_run_default: false,
    description:
      "Not-interested language cools the thread and cancels pending queue work.",
    condition: { matcher: "not_interested" },
    actions: [
      {
        action_type: "patch_thread_state",
        params: {
          status: "open",
          stage: "not_interested",
          priority: "low",
          metadata: { lead_temperature: "cold" },
        },
      },
      {
        action_type: "cancel_pending_queue",
        params: { reason: "not_interested" },
      },
    ],
  },
  {
    rule_key: "stage.ownership_verified",
    event_type: "inbound_message_received",
    action_type: "patch_thread_state",
    priority: 23,
    dry_run_default: false,
    description: "Ownership-confirmed replies mark the thread verified.",
    condition: { matcher: "ownership_confirmed" },
    actions: [
      {
        action_type: "patch_thread_state",
        params: {
          status: "open",
          stage: "interested",
          priority: "high",
          metadata: { automation_stage: "ownership_verified" },
        },
      },
    ],
  },
];

export default stageTemperatureRules;
