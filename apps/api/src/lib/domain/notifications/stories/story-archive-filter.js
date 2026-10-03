/**
 * [8.3] ARCHIVED SUBJECTS LEAVE THE STORIES.
 *
 * A story's subject is its partition: `seller:<thread_key>` or
 * `campaign:<id>` (system/other partitions are never archivable). When the
 * operator archives the conversation (inbox_thread_state.is_archived) or the
 * campaign (campaigns.status='archived'), its stories leave every lens and
 * every count — the badge included — at READ time, for the snapshot and the
 * persisted projection alike. Nothing is deleted: unarchiving brings the
 * stories back on the next read. A failed lookup filters nothing (and says
 * so in `degraded`) — it never hides stories it cannot justify hiding.
 */

const CHUNK = 200

export function parsePartition(key) {
  const k = String(key || '')
  if (k.startsWith('seller:')) {
    const threadKey = k.slice(7).split('|')[0]
    return threadKey ? { type: 'seller', id: threadKey } : null
  }
  if (k.startsWith('campaign:')) {
    const id = k.slice(9)
    return id ? { type: 'campaign', id } : null
  }
  return null
}

const chunks = (list) => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The subset of `partitionKeys` whose subject is archived. Throws on a read error. */
export async function loadArchivedPartitions(db, partitionKeys) {
  const threads = new Set()
  const campaigns = new Set()
  for (const key of partitionKeys) {
    const p = parsePartition(key)
    if (p?.type === 'seller') threads.add(p.id)
    else if (p?.type === 'campaign' && UUID.test(p.id)) campaigns.add(p.id)
  }
  const archived = new Set()
  const reads = []
  for (const part of chunks([...threads])) {
    reads.push(db.from('inbox_thread_state').select('thread_key').in('thread_key', part).eq('is_archived', true).then(({ data, error }) => {
      if (error) throw error
      for (const r of data || []) archived.add(`seller:${r.thread_key}`)
    }))
  }
  for (const part of chunks([...campaigns])) {
    reads.push(db.from('campaigns').select('id').in('id', part).eq('status', 'archived').then(({ data, error }) => {
      if (error) throw error
      for (const r of data || []) archived.add(`campaign:${r.id}`)
    }))
  }
  await Promise.all(reads)
  return archived
}

/** Is this partition (or a seller partition with a property suffix) archived? */
export function isArchivedPartition(archived, key) {
  if (!archived?.size || !key) return false
  const p = parsePartition(key)
  return Boolean(p && archived.has(`${p.type}:${p.id}`))
}

/** Load the archived set for `keys`; on failure an empty set plus a degraded marker. */
export async function archivedFor(db, keys, deps = {}) {
  const load = deps.loadArchivedPartitions || loadArchivedPartitions
  try {
    return { archived: await load(db, [...new Set(keys.filter(Boolean))]), degraded: null }
  } catch (error) {
    return { archived: new Set(), degraded: `archive_filter:${error?.message || 'failed'}` }
  }
}
