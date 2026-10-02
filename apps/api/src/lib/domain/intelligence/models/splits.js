/**
 * IC8 TIME-AWARE SPLITS (architecture §8). Temporal only: train < T <= test.
 *
 * Purging: a training row whose label window (time + horizon) reaches past T
 * was labeled with information from the test period, so it is moved to
 * `purged` rather than kept. Rows are ordered by (time, id) so a split is
 * deterministic for the same input.
 */

import { toIso, toMs } from "../util/time.js";

export class SplitError extends Error {
  constructor(message) {
    super(message);
    this.name = "SplitError";
    this.code = "SPLIT";
  }
}

function placed(rows, timeOf, idOf) {
  const out = [];
  let untimed = 0;
  for (const row of rows) {
    const t = toMs(timeOf(row));
    if (t === null) {
      untimed += 1;
      continue;
    }
    out.push({ row, t, id: String(idOf ? idOf(row) : "") });
  }
  out.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  return { out, untimed };
}

/**
 * Split at `cutoff`: train = time < cutoff (and, with horizonMs, time +
 * horizon < cutoff); test = time >= cutoff (and < testEnd when given).
 */
export function temporalSplit(rows, { timeOf, cutoff, testEnd = null, horizonMs = 0, idOf = null } = {}) {
  if (typeof timeOf !== "function") throw new SplitError("timeOf is required");
  const cutoffMs = toMs(cutoff);
  if (cutoffMs === null) throw new SplitError("cutoff is required");
  const testEndMs = testEnd === null ? null : toMs(testEnd);
  const { out, untimed } = placed(rows, timeOf, idOf);
  const train = [];
  const test = [];
  const purged = [];
  for (const { row, t } of out) {
    if (t < cutoffMs) {
      if (t + horizonMs >= cutoffMs && horizonMs > 0) purged.push(row);
      else train.push(row);
    } else if (testEndMs === null || t < testEndMs) {
      test.push(row);
    }
  }
  return { cutoff: toIso(cutoffMs), testEnd: toIso(testEndMs), train, test, purged, untimed };
}

/**
 * Rolling-origin evaluation: for each origin T, train on everything before T
 * (purged by horizon) and test on [T, T + testWindowMs). Origins with fewer
 * than minTrain training rows or minTest test rows are reported, not dropped.
 */
export function rollingOriginSplits(rows, { timeOf, origins, testWindowMs, horizonMs = 0, idOf = null, minTrain = 1, minTest = 1 } = {}) {
  if (!Array.isArray(origins) || !origins.length) throw new SplitError("origins are required");
  if (!Number.isFinite(testWindowMs) || testWindowMs <= 0) throw new SplitError("testWindowMs must be > 0");
  return origins
    .map((origin) => toMs(origin))
    .sort((a, b) => a - b)
    .map((originMs) => {
      const split = temporalSplit(rows, { timeOf, cutoff: originMs, testEnd: originMs + testWindowMs, horizonMs, idOf });
      return {
        origin: split.cutoff,
        testEnd: split.testEnd,
        train: split.train,
        test: split.test,
        purged: split.purged,
        sufficient: split.train.length >= minTrain && split.test.length >= minTest,
      };
    });
}

/** First instant of each UTC month in [from, to): convenient rolling origins. */
export function monthlyOrigins(from, to) {
  const fromMs = toMs(from);
  const toEnd = toMs(to);
  if (fromMs === null || toEnd === null) throw new SplitError("monthlyOrigins needs from and to");
  const start = new Date(fromMs);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  if (Date.UTC(year, month, 1) < fromMs) month += 1;
  const out = [];
  for (;;) {
    const t = Date.UTC(year, month, 1);
    if (t >= toEnd) break;
    out.push(new Date(t).toISOString());
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return out;
}

/** Hold out whole segments (e.g. markets) where support allows; time order is kept inside each part. */
export function segmentHoldout(rows, { segmentOf, holdout = [], timeOf = null, idOf = null } = {}) {
  const held = new Set(holdout.map(String));
  const ordered = timeOf ? placed(rows, timeOf, idOf).out.map((entry) => entry.row) : [...rows];
  const train = [];
  const test = [];
  for (const row of ordered) (held.has(String(segmentOf(row))) ? test : train).push(row);
  return { train, test, holdout: [...held].sort() };
}
