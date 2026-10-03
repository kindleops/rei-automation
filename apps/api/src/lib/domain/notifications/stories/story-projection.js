/**
 * NOTIFICATION STORIES — the projection (pure; no I/O).
 *
 * The snapshot builder rebuilt every story from the whole 7-day window on each
 * cold read (10–15s, sources timing out). The projection keeps the SAME stories
 * persisted and updates only the part of the window an event can change.
 *
 *   input      one story-relevant source fact (an envelope event, or a
 *              notification_events row) — a window-bounded working copy, keyed by
 *              the same canonical id the builder dedupes on (`me:…`, `ne:<id>`, …).
 *              Never an authority: rebuildable from the sources at any time.
 *   partition  the unit a story can depend on. Every grouping rule in
 *              story-builder (bursts, open conditions, causal joins, late morphs,
 *              property fill-in, display names, supersede) reads only items of one
 *              seller THREAD or one non-seller SUBJECT — so rebuilding a partition
 *              with the builder itself gives exactly the stories the full build
 *              gives for it. A Signal fired by a specific event joins that event's
 *              story, so it is projected in the host event's partition.
 *
 * Grouping and morph semantics are NOT re-implemented here: a partition's stories
 * are `buildStories()` over that partition's inputs.
 */
import { createHash } from 'node:crypto'
import { itemFromEvent, itemFromNotification, subjectKey } from './story-grammar.js'
import { buildStories, countStories, AGE_INTO_HISTORY_MS } from './story-builder.js'

const clean = (v) => String(v ?? '').trim()
const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : NaN }

/** seller → the thread (both of a phone's conversations: names + property fill-in are thread-wide); else the subject. */
export function partitionOfSubject(s) {
  if (!s) return null
  if (s.type === 'seller') return clean(s.thread_key) ? `seller:${clean(s.thread_key)}` : null
  return subjectKey(s)
}

/**
 * Raw source facts → projection inputs (null-item facts are Machine Feed only and
 * are not kept). `hostOf(eventId)` resolves a Signal's source event to its
 * partition when that event is not in the same batch.
 */
export function toInputs({ events = [], notifications = [] }, hostOf = () => null) {
  const out = new Map()
  const partOf = new Map()
  const pending = []
  for (const e of events) {
    const it = itemFromEvent(e)
    if (!it || out.has(e.event_id)) continue
    const p = partitionOfSubject(it.subject)
    if (!p) continue
    out.set(e.event_id, { input_id: e.event_id, kind: 'event', partition_key: p, occurred_at: it.at, payload: e })
    partOf.set(e.event_id, p)
  }
  for (const r of notifications) {
    const it = itemFromNotification(r)
    const id = `ne:${r?.id}`
    if (!it || out.has(id)) continue // an envelope copy of the same row wins, exactly as the builder dedupes
    const own = partitionOfSubject(it.subject)
    if (!own) continue
    // occurred_at is the WINDOW clock, exactly as the builder reads the sources: an alert row is in the
    // window while its own updated_at is (a grouped row created 9 days ago but re-fired today still counts)
    const windowAt = [it.at, r.updated_at, r.created_at].filter((v) => Number.isFinite(Date.parse(v || ''))).sort().pop() || it.at
    const row = { input_id: id, kind: 'notification', partition_key: own, occurred_at: new Date(Date.parse(windowAt)).toISOString(), payload: r }
    out.set(id, row)
    partOf.set(id, own)
    if (it.signal && it.causal?.source_event_id) pending.push([row, it.causal.source_event_id])
  }
  for (const [row, src] of pending) {
    const host = partOf.get(src) || hostOf(src)
    if (host) row.partition_key = host
  }
  return [...out.values()]
}

/** Inputs of one or more partitions → the builder's own inputs. */
export function sourcesOf(inputs) {
  const events = []
  const notifications = []
  for (const i of inputs) (i.kind === 'event' ? events : notifications).push(i.payload)
  return { events, notifications }
}

/** The partition a built story belongs to (its subject; a host-joined signal shares the host's). */
export function partitionOfStory(s) {
  if (!s?.subject) return null
  return s.subject.type === 'seller' ? partitionOfSubject({ type: 'seller', thread_key: s.subject.thread_key }) : subjectKey({ type: s.subject.type, id: s.subject.id })
}

const hashOf = (story) => createHash('sha1').update(JSON.stringify({ ...story, aged: undefined })).digest('base64url').slice(0, 16)

/** One built story → one projection row (the read path filters/pages/counts on the columns). */
export function storyRow(s, projectedAt) {
  return {
    story_id: s.id,
    partition_key: partitionOfStory(s),
    subject_key: s.subject_key,
    lens: s.lens,
    priority: s.priority,
    requires_operator: Boolean(s.requires_operator),
    resolved: Boolean(s.resolved),
    is_read: Boolean(s.read),
    badge: countStories([s]).badge === 1,
    updated_at: s.updated_at,
    last_trigger_at: s.last_trigger_at,
    resolved_at: s.resolved_at || null,
    content_hash: hashOf(s),
    story: { ...s, aged: undefined },
    projected_at: projectedAt,
  }
}

/** A projection row → the API story (time-relative fields are recomputed at read). */
export function storyFromRow(row, now = Date.now()) {
  const s = { ...(row.story || {}) }
  s.aged = Boolean(s.resolved) && now - ms(s.resolved_at || s.updated_at) > AGE_INTO_HISTORY_MS
  return s
}

/**
 * Rebuild the given partitions' stories with the builder (two passes: the second
 * applies persisted operator state for the ids the first produced).
 *   loadState(ids) → Map<story_id, state row>
 */
export async function projectPartitions(inputs, { now = Date.now(), loadState = async () => new Map() } = {}) {
  const src = sourcesOf(inputs)
  const first = buildStories({ ...src, state: new Map(), now })
  const state = first.stories.length ? await loadState(first.stories.map((s) => s.id)) : new Map()
  const built = state.size ? buildStories({ ...src, state, now }) : first
  return { stories: built.stories, stats: built.stats, state }
}

/**
 * Diff a partition rebuild against what the projection holds.
 *   existing: [{ story_id, content_hash }] of the same partitions
 * → { upserts (changed or new rows), deletes (ids the rebuild no longer produces) }
 */
export function diffProjection(stories, existing, projectedAt) {
  const prev = new Map(existing.map((r) => [r.story_id, r.content_hash]))
  const upserts = []
  const keep = new Set()
  for (const s of stories) {
    const row = storyRow(s, projectedAt)
    keep.add(row.story_id)
    if (prev.get(row.story_id) !== row.content_hash) upserts.push(row)
  }
  const deletes = [...prev.keys()].filter((id) => !keep.has(id))
  return { upserts, deletes }
}

export const PROJECTION_COLS = 'story_id, partition_key, lens, priority, requires_operator, resolved, is_read, badge, updated_at, resolved_at'

/** Counts from the narrow projection columns — the builder's own countStories (same badge rule). */
export function countRows(rows) {
  return countStories(rows.map((r) => ({ lens: r.lens, read: r.is_read, resolved: r.resolved, requires_operator: r.requires_operator, priority: r.priority })))
}
