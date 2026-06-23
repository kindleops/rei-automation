// Timing node processing for Workflow Studio V2.
// Calculates next_execution_at from timing node config and enrollment context.

import { adjustFollowUpTiming } from '@/lib/domain/workflow-v2/follow-up-service.js';

function asPositiveNumber(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

const UNIT_MS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

function addDuration(from, amount, unit) {
  const msPerUnit = UNIT_MS[clean(unit)] ?? UNIT_MS.hours;
  return new Date(from.getTime() + asPositiveNumber(amount) * msPerUnit);
}

function resolveTimezone(context = {}, config = {}) {
  return (
    clean(config.timezone) ||
    clean(context.timezone) ||
    clean(context.market_timezone) ||
    'america/chicago'
  ).replace(/^america\//, 'America/');
}

function getLocalHour(date, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    return Number(formatter.format(date));
  } catch {
    return date.getUTCHours();
  }
}

function calculateNextLocalContactWindow(from = new Date(), context = {}, config = {}) {
  const timezone = resolveTimezone(context, config);
  const targetHour = asPositiveNumber(config.start_hour ?? config.hour ?? 9, 9);
  const localHour = getLocalHour(from, timezone);

  let hoursUntil = targetHour - localHour;
  if (hoursUntil <= 0) {
    hoursUntil += 24;
  }

  return new Date(from.getTime() + hoursUntil * UNIT_MS.hours);
}

/**
 * Calculate the Date when a timing wait should end.
 * Supports wait_duration, wait_until, wait_for_reply, schedule_follow_up,
 * and wait_for_local_contact_window node types.
 */
export function calculateNextExecutionAt(
  config = {},
  from = new Date(),
  nodeType = '',
  enrollment = {},
) {
  const type = clean(nodeType || config.timing_type || 'timing.wait_duration');
  const context = enrollment?.context && typeof enrollment.context === 'object' ? enrollment.context : {};

  if (type === 'timing.wait_until' || config.until || config.wait_until) {
    const until = config.until ?? config.wait_until;
    const parsed = until ? new Date(until) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  if (type === 'timing.wait_for_reply') {
    const amount = asPositiveNumber(config.timeout ?? config.amount ?? config.hours ?? 48);
    const unit = clean(config.unit ?? (config.days ? 'days' : 'hours'));
    return addDuration(from, amount, unit);
  }

  if (type === 'timing.schedule_follow_up') {
    const baseDays = asPositiveNumber(config.days ?? config.amount ?? config.delay_amount ?? 3);
    const adjustedDays = adjustFollowUpTiming(baseDays, context);
    return addDuration(from, adjustedDays, 'days');
  }

  if (type === 'timing.wait_for_local_contact_window') {
    return calculateNextLocalContactWindow(from, context, config);
  }

  const amount = asPositiveNumber(config.amount ?? config.delay_amount ?? config.value ?? 1);
  const unit = clean(config.unit ?? config.delay_unit ?? 'hours');
  return addDuration(from, amount, unit);
}

/**
 * Returns a human-readable description of the wait.
 */
export function describeWait(config = {}, nodeType = '', enrollment = {}) {
  const type = clean(nodeType || config.timing_type || 'timing.wait_duration');
  const context = enrollment?.context && typeof enrollment.context === 'object' ? enrollment.context : {};

  if (type === 'timing.wait_until' || config.until || config.wait_until) {
    return `until ${config.until ?? config.wait_until ?? 'unknown'}`;
  }

  if (type === 'timing.wait_for_reply') {
    const amount = asPositiveNumber(config.timeout ?? config.amount ?? config.hours ?? 48);
    const unit = clean(config.unit ?? 'hours');
    return `wait_for_reply ${amount} ${unit}`;
  }

  if (type === 'timing.schedule_follow_up') {
    const baseDays = asPositiveNumber(config.days ?? config.amount ?? 3);
    const adjustedDays = adjustFollowUpTiming(baseDays, context);
    return `schedule_follow_up ${adjustedDays} days`;
  }

  if (type === 'timing.wait_for_local_contact_window') {
    const hour = asPositiveNumber(config.start_hour ?? config.hour ?? 9, 9);
    return `wait_for_local_contact_window until ${hour}:00 local`;
  }

  const amount = asPositiveNumber(config.amount ?? config.delay_amount ?? config.value ?? 1);
  const unit = clean(config.unit ?? config.delay_unit ?? 'hours');
  return `${amount} ${unit}`;
}