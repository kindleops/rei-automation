import { describe, expect, it } from 'vitest'
import { ENTITY_GRAPH_SELECTION_EVENT as AGENT_EVENT, ENTITY_GRAPH_SELECTION_KEY as AGENT_KEY } from '../../agent/context/agent-context'
import { ENTITY_GRAPH_SELECTION_EVENT, ENTITY_GRAPH_SELECTION_KEY, buildSelectionDetail, publishSelection, selectionSignature } from './desk-selection'

describe('Entity Graph publishes its selection for the agent', () => {
  it('uses exactly the agent’s event + storage key', () => {
    expect(ENTITY_GRAPH_SELECTION_EVENT).toBe(AGENT_EVENT)
    expect(ENTITY_GRAPH_SELECTION_KEY).toBe(AGENT_KEY)
  })
  it('v1 shape: ≤ 200 ids, true count, focused property, instance id', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `P${i}`)
    const d = buildSelectionDetail({ scope: 'properties', selectedPropertyIds: [...ids, 'P1'], focused: { property_id: 'P7', address: '12 Elm St, Dallas, TX' }, instanceId: 'inst_1', now: 5 })
    expect(d).toMatchObject({ v: 1, scope: 'properties', count: 250, focused: { property_id: 'P7', address: '12 Elm St, Dallas, TX' }, instance_id: 'inst_1', at: 5 })
    expect(d.property_ids).toHaveLength(200)
    expect(buildSelectionDetail({ scope: 'master_owners', selectedPropertyIds: ['x'], focused: null, instanceId: null }).property_ids).toEqual([])
    expect(selectionSignature(d)).toBe(selectionSignature({ ...d, at: 99 }))
  })
  it('writes sessionStorage and dispatches the event; never throws', () => {
    const store = new Map<string, string>()
    const events: Array<{ type: string; detail: unknown }> = []
    const w = { sessionStorage: { setItem: (k: string, v: string) => { store.set(k, v) } }, dispatchEvent: (e: Event) => { events.push({ type: e.type, detail: (e as CustomEvent).detail }); return true } }
    const d = buildSelectionDetail({ scope: 'properties', selectedPropertyIds: ['P1'], focused: null, instanceId: null, now: 1 })
    publishSelection(d, w)
    expect(JSON.parse(store.get(ENTITY_GRAPH_SELECTION_KEY)!)).toEqual(d)
    expect(events).toEqual([{ type: ENTITY_GRAPH_SELECTION_EVENT, detail: d }])
    expect(() => publishSelection(d, { dispatchEvent: () => { throw new Error('x') }, sessionStorage: { setItem: () => { throw new Error('quota') } } })).not.toThrow()
  })
})
