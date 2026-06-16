export const NODE_KINDS = Object.freeze(['trigger', 'action', 'condition', 'timing', 'guard']);

// ─────────────────────────────────────────────
// Node visibility policy
//
// is_system: true  → backend automation internals only; never shown in the
//                    Workflow Studio palette or the /api/workflows/node-types
//                    endpoint. These nodes are resolved by the runner or
//                    dispatched by internal services without operator intent.
//
// is_system: false → user-facing. Appear in the Studio palette and in the
//                    node-types API response. Names must never reference
//                    internal plumbing (brain, Podio, master_owner, etc.).
// ─────────────────────────────────────────────

export const NODE_TYPE_REGISTRY = Object.freeze([

  // ── Triggers ────────────────────────────────────────────────────────────

  {
    node_type: 'trigger.lead_entered_workflow',
    node_kind: 'trigger',
    label: 'Lead Entered Workflow',
    description: 'Fires when a lead is enrolled into this workflow.',
    category: 'triggers',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },
  {
    node_type: 'trigger.inbound_sms_received',
    node_kind: 'trigger',
    label: 'Inbound SMS Received',
    description: 'Fires when the lead sends an inbound SMS reply.',
    category: 'triggers',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },

  // ── Timing ──────────────────────────────────────────────────────────────

  {
    node_type: 'timing.wait_duration',
    node_kind: 'timing',
    label: 'Wait Duration',
    description: 'Pauses execution for a specified duration before continuing.',
    category: 'timing',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },

  // ── Messaging ───────────────────────────────────────────────────────────

  {
    node_type: 'action.send_sms',
    node_kind: 'action',
    label: 'Send SMS',
    description: 'Sends an SMS to the lead. Requires live_send_enabled on the workflow.',
    category: 'messaging',
    is_communication: true,
    requires_guard_before: true,
    is_terminal: false,
    is_system: false,
  },
  {
    node_type: 'action.send_email',
    node_kind: 'action',
    label: 'Send Email',
    description: 'Sends a transactional email to the lead. Requires live_send_enabled on the workflow.',
    category: 'messaging',
    is_communication: true,
    requires_guard_before: true,
    is_terminal: false,
    is_system: false,
  },

  // ── Conditions ──────────────────────────────────────────────────────────

  {
    node_type: 'condition.seller_replied',
    node_kind: 'condition',
    label: 'Seller Replied',
    description: 'Branches true if the lead has replied since the last outbound message.',
    category: 'conditions',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },
  {
    node_type: 'condition.no_reply_after',
    node_kind: 'condition',
    label: 'No Reply After',
    description: 'Branches true if no reply has been received after a configured duration.',
    category: 'conditions',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },
  {
    node_type: 'condition.inbound_intent',
    node_kind: 'condition',
    label: 'Check Seller Intent',
    description: 'Branches based on the classified intent of the latest inbound message.',
    category: 'conditions',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },

  // ── Guards ──────────────────────────────────────────────────────────────

  {
    node_type: 'guard.stop_suppression',
    node_kind: 'guard',
    label: 'Stop If Suppressed',
    description: 'Halts the workflow if the contact has opted out or is on the DNC list.',
    category: 'guards',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: true,
    is_system: false,
  },
  {
    node_type: 'guard.quiet_hours',
    node_kind: 'guard',
    label: 'Quiet Hours',
    description: 'Blocks outbound communication outside of the configured contact window.',
    category: 'guards',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },
  {
    node_type: 'guard.max_touches',
    node_kind: 'guard',
    label: 'Max Touches',
    description: 'Halts the workflow if the lead has exceeded the maximum outreach attempt limit.',
    category: 'guards',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },

  // ── CRM (platform-level) ─────────────────────────────────────────────────

  {
    node_type: 'action.update_stage',
    node_kind: 'action',
    label: 'Update Stage',
    description: 'Sets the lead pipeline stage to a configured value.',
    category: 'crm',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },
  {
    node_type: 'action.update_status',
    node_kind: 'action',
    label: 'Update Status',
    description: 'Sets the lead contact status to a configured value.',
    category: 'crm',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },

  // ── Notifications ────────────────────────────────────────────────────────

  {
    node_type: 'action.notify_agent',
    node_kind: 'action',
    label: 'Notify Agent',
    description: 'Creates an internal notification or task for the assigned agent.',
    category: 'notifications',
    is_communication: false,
    requires_guard_before: false,
    is_terminal: false,
    is_system: false,
  },

]);

const BY_TYPE = Object.fromEntries(NODE_TYPE_REGISTRY.map((n) => [n.node_type, n]));

export function isValidNodeType(nodeType) {
  return Object.prototype.hasOwnProperty.call(BY_TYPE, String(nodeType ?? '').trim());
}

export function isValidNodeKind(nodeKind) {
  return NODE_KINDS.includes(String(nodeKind ?? '').trim());
}

export function getNodeMeta(nodeType) {
  return BY_TYPE[String(nodeType ?? '').trim()] ?? null;
}

export function isCommunicationNode(nodeType) {
  return getNodeMeta(nodeType)?.is_communication === true;
}

export function requiresGuardBefore(nodeType) {
  return getNodeMeta(nodeType)?.requires_guard_before === true;
}

export function isGuardNode(nodeType) {
  return getNodeMeta(nodeType)?.node_kind === 'guard';
}

export function isTriggerNode(nodeType) {
  return getNodeMeta(nodeType)?.node_kind === 'trigger';
}

export function isSystemNode(nodeType) {
  return getNodeMeta(nodeType)?.is_system === true;
}

// Returns only nodes that should appear in the Workflow Studio palette.
// Never includes is_system: true nodes.
export function getVisibleNodes() {
  return NODE_TYPE_REGISTRY.filter((n) => n.is_system !== true);
}

// Returns visible nodes grouped by category.
export function getVisibleNodesByCategory() {
  const visible = getVisibleNodes();
  const groups = {};
  for (const node of visible) {
    if (!groups[node.category]) groups[node.category] = [];
    groups[node.category].push(node);
  }
  return groups;
}
