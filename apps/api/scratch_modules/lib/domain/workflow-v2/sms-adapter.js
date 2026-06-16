// Placeholder SMS adapter for Workflow Studio V2.
// This module intentionally does NOT send real messages.
// Replace the body of sendSmsPlaceholder when live execution is enabled.

export async function sendSmsPlaceholder(input = {}) {
  return {
    ok: false,
    sent: false,
    adapter: 'placeholder',
    live_send_blocked: true,
    reason: 'workflow_v2_sms_adapter_placeholder',
    input: {
      to: input.to ?? null,
      body_preview: typeof input.body === 'string' ? input.body.slice(0, 80) : null,
      workflow_definition_id: input.workflow_definition_id ?? null,
      node_id: input.node_id ?? null,
      enrollment_id: input.enrollment_id ?? null,
    },
  };
}
