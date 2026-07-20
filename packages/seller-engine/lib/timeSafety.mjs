// P2-3 time-safety law: source_event_timestamp <= scoring_as_of_timestamp for
// every feature input; outcome events may label AFTER as-of but never feed the
// feature vector. Violations throw in strict mode so leakage fails loudly (T-10).

export class LeakageError extends Error {}

export function assertAsOfSafe(sourceTimestamp, asOf, { context = '' } = {}) {
  if (sourceTimestamp === null || sourceTimestamp === undefined) return true;
  const src = toMs(sourceTimestamp);
  const cut = toMs(asOf);
  if (src === null || cut === null) return true; // undated evidence handled by caller state
  if (src > cut) {
    throw new LeakageError(`future input rejected: ${context} source=${new Date(src).toISOString()} > as_of=${new Date(cut).toISOString()}`);
  }
  return true;
}

export function isWithinWindow(eventTs, asOf, horizonDays) {
  const ev = toMs(eventTs);
  const start = toMs(asOf);
  if (ev === null || start === null) return false;
  return ev > start && ev <= start + horizonDays * 86_400_000;
}

// Censoring (P2-1): a row is only a valid negative when the observation window
// is fully covered by data through observed_through.
export function labelState(eventTs, asOf, horizonDays, observedThrough) {
  if (eventTs !== null && isWithinWindow(eventTs, asOf, horizonDays)) return 'positive';
  const windowEnd = toMs(asOf) + horizonDays * 86_400_000;
  if (toMs(observedThrough) !== null && toMs(observedThrough) >= windowEnd) return 'negative';
  return 'censored';
}

export function toMs(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}
