/**
 * Scheduling core — availability. Pure: no I/O, no clock, no brand knowledge.
 *
 * A start time is offered for a resource only when EVERY rule allows it:
 *   1. it falls inside the resource's working hours (in the resource's zone)
 *      and the whole meeting ends inside the same working interval;
 *   2. it is at least `min_notice_minutes` after now;
 *   3. it starts within `horizon_days` of now;
 *   4. the held block — start minus buffer_before to end plus buffer_after —
 *      overlaps nothing the resource is busy with: live appointments of ANY
 *      brand (their own held blocks), time off, and connected-calendar busy.
 *
 * Starts sit on a grid of `slot_interval_minutes` from the beginning of each
 * working interval, in the resource's wall-clock time.
 */

import { TIME, isoWeekday, localDatesBetween, wallTimeToInstant } from './scheduling-time.js';

const { MIN, DAY } = TIME;

/** Wall time, or the first valid instant after it when it falls in a DST gap. */
function wallOrNext(date, time, tz) {
  const exact = wallTimeToInstant(date, time, tz);
  if (exact) return exact.getTime();
  const [h, m] = time.split(':').map(Number);
  for (let step = 15; step <= 120; step += 15) {
    const total = h * 60 + m + step;
    if (total >= 24 * 60) break;
    const t = wallTimeToInstant(date, `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`, tz);
    if (t) return t.getTime();
  }
  return null;
}

/** Working intervals [startMs, endMs) for a resource between two instants. */
export function workingIntervals(resource, fromMs, toMs) {
  const out = [];
  const hours = resource.weekly_hours || {};
  for (const date of localDatesBetween(fromMs - DAY, toMs + DAY, resource.timezone)) {
    for (const [a, b] of hours[String(isoWeekday(date))] || []) {
      const start = wallOrNext(date, a, resource.timezone);
      // "24:00" closes at the next midnight.
      const end = b === '24:00'
        ? wallOrNext(new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10), '00:00', resource.timezone)
        : wallOrNext(date, b, resource.timezone);
      if (start == null || end == null || end <= start) continue;
      if (end <= fromMs || start >= toMs) continue;
      out.push([start, end]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function overlapsAny(sortedBusy, s, e) {
  // Busy intervals are half-open [start, end); touching ends do not overlap.
  for (const [bs, be] of sortedBusy) {
    if (bs >= e) return false;
    if (be > s) return true;
  }
  return false;
}

function normalizeBusy(list = []) {
  return list
    .map((b) => [new Date(b.start ?? b.start_at ?? b[0]).getTime(), new Date(b.end ?? b.end_at ?? b[1]).getTime()])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((x, y) => x[0] - y[0]);
}

/**
 * @param {object} input
 * @param {object} input.eventType  duration/interval/buffer/notice/horizon minutes
 * @param {Array<{id:string,timezone:string,weekly_hours:object}>} input.resources
 * @param {Record<string, Array>} input.busy  per resource id: [{start,end}]
 * @param {number|Date} input.now
 * @param {number|Date} input.from
 * @param {number|Date} input.to
 * @returns {Array<{start_at:string,end_at:string,resource_ids:string[]}>}
 */
export function computeAvailability({ eventType, resources, busy = {}, now, from, to }) {
  const nowMs = new Date(now).getTime();
  const dur = eventType.duration_minutes * MIN;
  const step = (eventType.slot_interval_minutes || eventType.duration_minutes) * MIN;
  const before = (eventType.buffer_before_minutes || 0) * MIN;
  const after = (eventType.buffer_after_minutes || 0) * MIN;
  const earliest = Math.max(new Date(from ?? nowMs).getTime(), nowMs + (eventType.min_notice_minutes || 0) * MIN);
  const latest = Math.min(new Date(to ?? nowMs + eventType.horizon_days * DAY).getTime(), nowMs + eventType.horizon_days * DAY);
  // from === to asks about exactly one start (booking-time validation).
  if (latest < earliest || !(dur > 0) || !(step > 0)) return [];

  const byStart = new Map();
  for (const resource of resources) {
    const blocks = normalizeBusy(busy[resource.id]);
    for (const [ws, we] of workingIntervals(resource, earliest, latest + dur)) {
      for (let t = ws; t + dur <= we; t += step) {
        if (t < earliest || t > latest) continue;
        if (overlapsAny(blocks, t - before, t + dur + after)) continue;
        const key = t;
        if (!byStart.has(key)) byStart.set(key, []);
        byStart.get(key).push(resource.id);
      }
    }
  }
  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, ids]) => ({ start_at: new Date(t).toISOString(), end_at: new Date(t + dur).toISOString(), resource_ids: ids }));
}

/** The block a booking holds, buffers included. */
export function heldBlock(eventType, startAt) {
  const t = new Date(startAt).getTime();
  return {
    start_at: new Date(t).toISOString(),
    end_at: new Date(t + eventType.duration_minutes * MIN).toISOString(),
    block_start_at: new Date(t - (eventType.buffer_before_minutes || 0) * MIN).toISOString(),
    block_end_at: new Date(t + (eventType.duration_minutes + (eventType.buffer_after_minutes || 0)) * MIN).toISOString(),
  };
}
