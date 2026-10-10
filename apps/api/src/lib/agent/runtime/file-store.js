// Durable LOCAL-DEV agent store (S3). Same interface as the in-memory adapter
// (runtime/store.js): transaction(fn) / read() / onCommit(cb) / kind.
//
// Why: real Quick Scan runs must survive UI navigation, page reload AND an API
// process restart in local dev, without a production database and without
// applying the PROPOSED agent schema. This adapter is NOT a production store:
//   * one JSON file per namespace under a gitignored directory
//     (default apps/api/.agent-dev-store/<namespace>/state.json)
//   * every committed transaction is persisted atomically (write tmp → fsync →
//     rename) BEFORE the transaction resolves and before listeners run, so a
//     crash after commit never loses an event the client already saw
//   * a failed persist rolls the in-memory state back and rethrows
//   * the namespace is stamped in the file: a 'live' store refuses to open a
//     'fixtures' file and vice versa (fixtures and live data never mix)
//   * if another process (or a second module instance in Next dev) wrote the
//     file, the next transaction reloads it first (mtime/size/ino check)
//   * production runtime refuses to create it at all
import fs from 'node:fs'
import path from 'node:path'
import { emptyState, AgentError } from './store.js'
import { isProductionRuntime } from '../config/agent-config.js'

export const FILE_STORE_FORMAT = 'lc-agent-dev-store/v1'
export const FILE_STORE_NAMESPACES = Object.freeze(['live', 'fixtures', 'test'])

function replacer(_key, value) {
  if (value instanceof Map) return { __map: [...value.entries()] }
  if (value instanceof Set) return { __set: [...value.values()] }
  return value
}

function reviver(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.__map) && Object.keys(value).length === 1) return new Map(value.__map)
    if (Array.isArray(value.__set) && Object.keys(value).length === 1) return new Set(value.__set)
  }
  return value
}

function serialize(namespace, state) {
  return JSON.stringify({ format: FILE_STORE_FORMAT, namespace, fixture: namespace === 'fixtures', saved_at: new Date().toISOString(), state }, replacer)
}

function hydrate(raw, namespace, file) {
  const doc = JSON.parse(raw, reviver)
  if (doc?.format !== FILE_STORE_FORMAT) throw new AgentError('FILE_STORE_FORMAT', `${file}: unknown format`)
  if (doc.namespace !== namespace) throw new AgentError('FILE_STORE_NAMESPACE_MISMATCH', `${file} belongs to namespace "${doc.namespace}", not "${namespace}"`)
  // forward-compatible: tables added after the file was written start empty
  const base = emptyState()
  const state = { ...base, ...doc.state, counters: { ...base.counters, ...(doc.state?.counters || {}) } }
  for (const [k, v] of Object.entries(base)) if (v instanceof Map && !(state[k] instanceof Map)) state[k] = new Map()
  return state
}

function statKey(file) {
  try {
    const st = fs.statSync(file)
    return `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * @param {{ dir?: string, namespace?: 'live'|'fixtures'|'test', env?: Record<string,string|undefined> }} [opts]
 * @returns {import('./store.js').AgentStore & { file: string, namespace: string, reopen: () => void }}
 */
export function createFileAgentStore({ dir, namespace = 'live', env = process.env } = {}) {
  if (isProductionRuntime(env)) throw new AgentError('FILE_STORE_REFUSED_IN_PRODUCTION', 'the file-backed agent store is local-dev only')
  if (!FILE_STORE_NAMESPACES.includes(namespace)) throw new AgentError('FILE_STORE_NAMESPACE_INVALID', String(namespace))
  if (!dir) throw new AgentError('FILE_STORE_DIR_REQUIRED', 'dir required')
  const nsDir = path.join(dir, namespace)
  fs.mkdirSync(nsDir, { recursive: true })
  const file = path.join(nsDir, 'state.json')

  let state = emptyState()
  let known = null
  function load() {
    if (fs.existsSync(file)) {
      state = hydrate(fs.readFileSync(file, 'utf8'), namespace, file)
    } else {
      state = emptyState()
      persist(state)
    }
    known = statKey(file)
  }
  function persist(next) {
    const tmp = `${file}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, serialize(namespace, next))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    known = statKey(file)
  }
  load()

  let chain = Promise.resolve()
  const listeners = new Set()

  async function transaction(fn) {
    const run = async () => {
      if (statKey(file) !== known) load() // written by another instance since our last commit
      const before = structuredClone(state)
      const eventCountBefore = state.events.length
      try {
        const result = await fn(state)
        persist(state)
        const committed = state.events.slice(eventCountBefore)
        if (committed.length) for (const cb of listeners) {
          try { cb(committed) } catch { /* listener errors never roll back a commit */ }
        }
        return result
      } catch (error) {
        state = before
        throw error
      }
    }
    const p = chain.then(run, run)
    chain = p.then(() => undefined, () => undefined)
    return p
  }

  return {
    kind: 'file',
    namespace,
    file,
    transaction,
    read() {
      if (statKey(file) !== known) load()
      return state
    },
    onCommit(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    /** Drop in-memory state and re-read the file (what a process restart does). */
    reopen: load,
  }
}
