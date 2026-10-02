import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __boardTest,
  activeLayout,
  bootBoard,
  commitActive,
  deleteLayout,
  flushSaves,
  getBoard,
  newLayoutFromPreset,
  restoreLayout,
  saveLayoutAs,
  setDefaultLayout,
  type BoardDeps,
} from './board-store'
import { layoutFromPreset, migrateLayout, removeInstance, type HomeLayout } from './home-layout-model'
import type { HomeLayoutApi, ListResult, SaveResult } from './home-layout-api'

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, raw: m }
}

function fakeApi(opts: { list?: ListResult; conflictWith?: HomeLayout | null } = {}) {
  const saved: HomeLayout[] = []
  const removed: string[] = []
  let list: ListResult = opts.list ?? { ok: true, layouts: [] }
  const api: HomeLayoutApi & { saved: HomeLayout[]; removed: string[]; setList: (l: ListResult) => void } = {
    saved,
    removed,
    setList: (l) => { list = l },
    async list() { return list },
    async save(layout): Promise<SaveResult> {
      if (opts.conflictWith && opts.conflictWith.id === layout.id) return { ok: false, reason: 'conflict', current: opts.conflictWith }
      saved.push(structuredClone(layout))
      return { ok: true, revision: layout.revision }
    },
    async remove(id) { removed.push(id); return { ok: true } },
  }
  return api
}

const UNAVAILABLE: ListResult = { ok: false, reason: 'store_unavailable', message: 'Layouts are saved on this device until server storage is enabled.' }

let storage: ReturnType<typeof memoryStorage>
const deps = (api: HomeLayoutApi): BoardDeps => ({ api, storage, now: () => Date.parse('2026-10-02T15:00:00Z'), saveDelayMs: 0 })

beforeEach(() => { __boardTest.reset(); storage = memoryStorage() })
afterEach(() => { __boardTest.reset() })

describe('home board store', () => {
  it('opens a new operator on the Command preset, never an empty canvas', async () => {
    await bootBoard('op-1', deps(fakeApi({ list: UNAVAILABLE })))
    const b = getBoard()
    expect(b.layouts).toHaveLength(1)
    expect(activeLayout()?.preset).toBe('command')
    expect(activeLayout()?.isDefault).toBe(true)
    expect(activeLayout()!.widgets.length).toBeGreaterThan(4)
    expect(b.persistence).toBe('local')
    expect(b.note).toMatch(/this device/)
  })

  it('persists locally keyed by operator and survives a reload; removed widgets stay removed', async () => {
    const api = fakeApi({ list: UNAVAILABLE })
    await bootBoard('op-1', deps(api))
    const first = activeLayout()!.widgets[0].id
    const firstType = activeLayout()!.widgets[0].type
    commitActive((l) => removeInstance(l, first))
    expect(storage.raw.has('lc.home.board.v1:op-1')).toBe(true)
    __boardTest.reset()
    await bootBoard('op-1', deps(api))
    expect(activeLayout()!.widgets.some((w) => w.id === first)).toBe(false)
    // another operator on the same device has their own board
    __boardTest.reset()
    await bootBoard('op-2', deps(api))
    expect(activeLayout()!.widgets.some((w) => w.type === firstType)).toBe(true)
  })

  it('migrates local layouts to the server the first time it is available', async () => {
    const api = fakeApi({ list: UNAVAILABLE })
    await bootBoard('op-1', deps(api))
    newLayoutFromPreset('closings')
    expect(getBoard().layouts).toHaveLength(2)
    __boardTest.reset()
    api.setList({ ok: true, layouts: [] })
    await bootBoard('op-1', deps(api))
    expect(getBoard().persistence).toBe('server')
    await flushSaves()
    expect(api.saved.map((l) => l.name).sort()).toEqual(['Closings', 'Command'])
  })

  it('takes the server copy when it is newer and keeps a newer local edit', async () => {
    const local = layoutFromPreset('minimal', { isDefault: true })
    storage.setItem('lc.home.board.v1:op-1', JSON.stringify({ v: 1, activeId: local.id, layouts: [{ ...local, revision: 3, name: 'Local' }], synced: [local.id] }))
    const api = fakeApi({ list: { ok: true, layouts: [{ ...local, revision: 5, name: 'Server' }] } })
    await bootBoard('op-1', deps(api))
    expect(activeLayout()!.name).toBe('Server')
    __boardTest.reset()
    storage.setItem('lc.home.board.v1:op-1', JSON.stringify({ v: 1, activeId: local.id, layouts: [{ ...local, revision: 9, name: 'Local newer' }], synced: [local.id] }))
    await bootBoard('op-1', deps(api))
    expect(activeLayout()!.name).toBe('Local newer')
    await flushSaves()
    expect(api.saved.at(-1)?.name).toBe('Local newer')
  })

  it('does not let the starter board displace layouts already on the server', async () => {
    const remote = layoutFromPreset('intelligence', { isDefault: true })
    await bootBoard('op-1', deps(fakeApi({ list: { ok: true, layouts: [remote] } })))
    expect(getBoard().layouts.map((l) => l.id)).toEqual([remote.id])
    expect(activeLayout()!.id).toBe(remote.id)
  })

  it('adopts the server copy on a revision conflict instead of overwriting it', async () => {
    const mine = layoutFromPreset('minimal', { isDefault: true })
    storage.setItem('lc.home.board.v1:op-1', JSON.stringify({ v: 1, activeId: mine.id, layouts: [mine], synced: [mine.id] }))
    const theirs = { ...mine, revision: 12, name: 'Edited elsewhere' }
    const api = fakeApi({ list: { ok: true, layouts: [mine] }, conflictWith: theirs })
    await bootBoard('op-1', deps(api))
    commitActive((l) => ({ ...l, name: 'Mine' }))
    await flushSaves()
    expect(activeLayout()!.name).toBe('Edited elsewhere')
    expect(getBoard().adoptedAt).not.toBeNull()
  })

  it('bumps the revision on every change and restores a previous copy for Undo', async () => {
    await bootBoard('op-1', deps(fakeApi({ list: UNAVAILABLE })))
    const before = activeLayout()!
    const after = commitActive((l) => removeInstance(l, l.widgets[0].id))!
    expect(after.revision).toBe(before.revision + 1)
    restoreLayout(before)
    expect(activeLayout()!.widgets.map((w) => w.id)).toEqual(before.widgets.map((w) => w.id))
  })

  it('manages layouts: save as, default, delete (never the last one)', async () => {
    const api = fakeApi()
    await bootBoard('op-1', deps(api))
    const copy = saveLayoutAs('Ultrawide wall')!
    expect(activeLayout()!.id).toBe(copy.id)
    setDefaultLayout(copy.id)
    expect(getBoard().layouts.filter((l) => l.isDefault).map((l) => l.id)).toEqual([copy.id])
    expect(deleteLayout(copy.id)).toBe(true)
    expect(getBoard().layouts).toHaveLength(1)
    expect(getBoard().layouts[0].isDefault).toBe(true)
    expect(deleteLayout(getBoard().layouts[0].id)).toBe(false)
    await flushSaves()
  })

  it('keeps unknown widget types and drops malformed instances when reading a stored layout', () => {
    const l = migrateLayout({
      id: 'l_abcdef', name: 'Old', schemaVersion: 1,
      widgets: [
        { id: 'w_known1', type: 'inbox.replies', size: 'medium', geometry: { standard: { x: 0, y: 0, w: 4, h: 4 } } },
        { id: 'w_gone01', type: 'retired.widget', size: 'huge', geometry: { standard: { x: 'a' } } },
        { id: 'bad id!', type: 'inbox.replies' },
        { id: 'w_known1', type: 'duplicate' },
        { id: 'w_pinned', type: 'campaign.engine', context: { mode: 'pinned' } },
      ],
    })!
    expect(l.widgets.map((w) => w.id)).toEqual(['w_known1', 'w_gone01', 'w_pinned'])
    expect(l.widgets[1].size).toBe('medium')
    expect(l.widgets[1].geometry).toEqual({})
    // pinned without a subject is honestly global
    expect(l.widgets[2].context.mode).toBe('global')
  })

  it('lifts a v0 draft layout into the current schema', () => {
    const l = migrateLayout({ id: 'l_v0draft', items: [{ id: 'w_aaaa01', type: 'home.focus', cell: { x: 1, y: 2, w: 4, h: 4 } }] })!
    expect(l.schemaVersion).toBe(1)
    expect(l.widgets[0].geometry.standard).toEqual({ x: 1, y: 2, w: 4, h: 4 })
  })
})
