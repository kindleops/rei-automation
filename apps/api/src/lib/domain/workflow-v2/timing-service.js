// Timing node processing for Workflow Studio V2.
// Calculates next_execution_at from a timing node's config and pauses
// the enrollment. Supports minutes, hours, days.

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

/**
 * Calculate the Date when a timing wait should end.
 * Config: { amount: N, unit: 'minutes' | 'hours' | 'days' }
 */
export function calculateNextExecutionAt(config = {}, from = new Date()) {
  const amount = asPositiveNumber(config.amount ?? config.delay_amount ?? config.value ?? 1);
  const unit = clean(config.unit ?? config.delay_unit ?? 'hours');
  const msPerUnit = UNIT_MS[unit] ?? UNIT_MS.hours;
  return new Date(from.getTime() + amount * msPerUnit);
}

/**
 * Returns a human-readable description of the wait.
 */
export function describeWait(config = {}) {
  const amount = asPositiveNumber(config.amount ?? config.delay_amount ?? config.value ?? 1);
  const unit = clean(config.unit ?? config.delay_unit ?? 'hours');
  return `${amount} ${unit}`;
}
