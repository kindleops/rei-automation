/**
 * Scheduling core — reminders.
 *
 * The core decides WHEN (the event type's reminder_offsets_minutes); the brand
 * adapter decides WHAT (its own template); the existing communication plane
 * delivers (email_queue rows, source 'scheduling', sent by email dispatch with
 * its suppression, sender and kill-switch checks).
 *
 * A reminder is bound to one appointment at one start time. At send time the
 * revalidator below drops it when the appointment was cancelled, rescheduled
 * (rescheduling creates a new appointment with its own reminders) or moved —
 * so a stale reminder can never go out.
 *
 * Google is not used to remind customers (they are never invited to the
 * Google event), so customers get exactly one set of reminders. The team
 * member's own Google notifications are theirs to configure.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { registerEmailRevalidator } from '@/lib/domain/email/email-dispatch.js';

const MIN = 60_000;
const LIVE = ['scheduled', 'confirmed'];

export async function scheduleReminders({ appointment, eventType, adapter, now, deps = {} }) {
  const to = appointment.customer?.email;
  if (!to || !LIVE.includes(appointment.status)) return { scheduled: 0 };
  const enqueue = deps.enqueueEmail ?? defaultEnqueue(deps);
  let scheduled = 0;
  for (const offset of eventType.reminder_offsets_minutes || []) {
    const at = Date.parse(appointment.start_at) - offset * MIN;
    if (at < new Date(now).getTime() + 5 * MIN) continue; // too close to be useful
    const content = adapter.reminder?.({ appointment, eventType, offsetMinutes: offset });
    if (!content) continue;
    const r = await enqueue({
      queue_key: `scheduling:reminder:${appointment.id}:${offset}`,
      queue_status: 'scheduled',
      scheduled_for: new Date(at).toISOString(),
      to_email: to,
      subject: content.subject,
      email_body: content.html,
      html_body: content.html,
      text_body: content.text,
      brand_key: appointment.brand_key,
      source: 'scheduling',
      source_ref: `appointment:${appointment.id}:reminder:${offset}`,
      action_key: `scheduling.reminder.${offset}`,
      requested_by: 'scheduling_core',
      origin: 'automation',
      metadata: { appointment_id: appointment.id, start_at: appointment.start_at },
      reason: { why: 'Appointment reminder', offset_minutes: offset },
    });
    if (r?.ok !== false) scheduled++;
  }
  return { scheduled };
}

function defaultEnqueue(deps) {
  const db = () => deps.db ?? getDefaultSupabaseClient();
  return async (row) => {
    const { error } = await db().from('email_queue').insert(row);
    if (error && error.code !== '23505') return { ok: false, reason: error.message };
    return { ok: true };
  };
}

/** Send-time check used by email dispatch for source 'scheduling'. */
export async function revalidateSchedulingEmail(db, row) {
  const id = row?.metadata?.appointment_id;
  if (!id) return { state: 'cancelled', reason: 'appointment_unknown' };
  const { data, error } = await db.from('scheduling_appointments').select('status, start_at').eq('id', id).maybeSingle();
  if (error) return { state: 'error', reason: 'appointment_read_failed' };
  if (!data || !LIVE.includes(data.status)) return { state: 'cancelled', reason: 'appointment_not_active' };
  if (Date.parse(data.start_at) !== Date.parse(row.metadata.start_at)) return { state: 'cancelled', reason: 'appointment_moved' };
  return { state: 'still_needed' };
}

registerEmailRevalidator('scheduling', revalidateSchedulingEmail);
