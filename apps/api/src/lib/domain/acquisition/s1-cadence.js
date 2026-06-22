// S1 ownership cadence — max 2 active touches, urgency-based timing, long-tail reactivation.

export const S1_MAX_ACTIVE_ATTEMPTS = 2;

export const S1_URGENCY_DELAYS_DAYS = Object.freeze({
  high: 7,
  medium: 14,
  low: 21,
  unknown: 21,
});

export const S1_LONG_TAIL_REACTIVATION_DAYS = Object.freeze({
  min: 45,
  max: 60,
});

function clean(value) {
  return String(value ?? '').trim();
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveS1UrgencyBand(context = {}) {
  const explicit = lower(clean(context.urgency_band));
  if (explicit && S1_URGENCY_DELAYS_DAYS[explicit] !== undefined) return explicit;

  const motivation = asNumber(context.motivation_score ?? context.seller_motivation_score, null);
  if (motivation !== null && motivation >= 75) return 'high';
  if (motivation !== null && motivation <= 35) return 'low';
  if (motivation !== null && motivation >= 50) return 'medium';
  return 'unknown';
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function resolveS1FollowUpDelayDays(context = {}, touchIndex = 1) {
  const touch = Math.max(1, Number(touchIndex) || 1);
  if (touch > S1_MAX_ACTIVE_ATTEMPTS) {
    const min = S1_LONG_TAIL_REACTIVATION_DAYS.min;
    const max = S1_LONG_TAIL_REACTIVATION_DAYS.max;
    return Math.round((min + max) / 2);
  }
  const band = resolveS1UrgencyBand(context);
  return S1_URGENCY_DELAYS_DAYS[band] ?? S1_URGENCY_DELAYS_DAYS.unknown;
}

export function shouldScheduleS1FollowUp(context = {}) {
  const priorTouches = asNumber(context.prior_touch_count ?? context.ownership_touch_count, 0);
  if (priorTouches >= S1_MAX_ACTIVE_ATTEMPTS) {
    return {
      ok: true,
      schedule: 'long_tail_reactivation',
      delay_days: resolveS1FollowUpDelayDays(context, priorTouches + 1),
      touch_number: priorTouches + 1,
      active_attempt: false,
    };
  }
  return {
    ok: true,
    schedule: 'ownership_follow_up',
    delay_days: resolveS1FollowUpDelayDays(context, priorTouches + 1),
    touch_number: priorTouches + 1,
    active_attempt: true,
    remaining_attempts: S1_MAX_ACTIVE_ATTEMPTS - priorTouches,
  };
}

export function shouldStopS1ActiveCadence(context = {}) {
  const priorTouches = asNumber(context.prior_touch_count ?? context.ownership_touch_count, 0);
  return priorTouches >= S1_MAX_ACTIVE_ATTEMPTS;
}

export default {
  S1_MAX_ACTIVE_ATTEMPTS,
  S1_URGENCY_DELAYS_DAYS,
  S1_LONG_TAIL_REACTIVATION_DAYS,
  resolveS1UrgencyBand,
  resolveS1FollowUpDelayDays,
  shouldScheduleS1FollowUp,
  shouldStopS1ActiveCadence,
};