/**
 * Unified entity timeline for pipeline opportunity detail.
 * Merges opportunity history, messages, and workflow signals.
 */
function clean(value) {
  return String(value ?? '').trim();
}

function eventId(parts) {
  return parts.filter(Boolean).join(':');
}

export async function buildOpportunityActivityTimeline(client, opportunity = {}, deps = {}) {
  const events = [];
  const seen = new Set();
  const threadKey = clean(opportunity.primary_thread_key);

  const push = (event) => {
    const id = eventId([event.source, event.id || event.type, event.timestamp, event.label]);
    if (seen.has(id)) return;
    seen.add(id);
    events.push({ ...event, id });
  };

  for (const row of opportunity.history ?? []) {
    push({
      type: clean(row.event_type) || 'history',
      label: (clean(row.event_type) || 'event').replace(/_/g, ' '),
      timestamp: row.created_at,
      source: 'acquisition_opportunity_history',
      detail: [row.previous_value, row.new_value].filter(Boolean).join(' → ') || row.reason || null,
      actor: row.actor,
    });
  }

  if (threadKey) {
    const { data: messages } = await client
      .from('message_events')
      .select('id, direction, message_body, intent, delivery_status, created_at, event_type')
      .or(`thread_key.eq.${threadKey},from_phone_number.eq.${threadKey},to_phone_number.eq.${threadKey}`)
      .order('created_at', { ascending: false })
      .limit(15);

    for (const msg of messages ?? []) {
      const direction = clean(msg.direction).toLowerCase();
      const isInbound = direction === 'inbound' || direction === 'in';
      push({
        type: isInbound ? 'message_inbound' : 'message_outbound',
        label: isInbound ? 'Inbound message' : 'Outbound message',
        timestamp: msg.created_at,
        source: 'message_events',
        id: clean(msg.id),
        detail: clean(msg.message_body).slice(0, 160) || null,
      });
      if (clean(msg.intent)) {
        push({
          type: 'classification',
          label: `Intent · ${clean(msg.intent).replace(/_/g, ' ')}`,
          timestamp: msg.created_at,
          source: 'message_events',
          id: `${clean(msg.id)}:intent`,
        });
      }
    }

    const enrollmentRes = await client
      .from('workflow_enrollments')
      .select('id, status, workflow_definition_id, updated_at, created_at')
      .eq('subject_id', threadKey)
      .order('updated_at', { ascending: false })
      .limit(5);
    for (const enrollment of enrollmentRes.data ?? []) {
      push({
        type: 'workflow',
        label: `Workflow ${clean(enrollment.status).replace(/_/g, ' ')}`,
        timestamp: enrollment.updated_at || enrollment.created_at,
        source: 'workflow_enrollments',
        id: clean(enrollment.id),
      });
    }
  }

  if (clean(opportunity.acquisition_engine_run_id)) {
    push({
      type: 'engine_run',
      label: 'Acquisition engine analysis',
      timestamp: opportunity.last_activity_at || opportunity.updated_at,
      source: 'acquisition_engine',
      id: clean(opportunity.acquisition_engine_run_id),
    });
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return events.slice(0, 80);
}