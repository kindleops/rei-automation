import { beforeEach, describe, expect, it } from 'vitest'
import { __inspectorTest, closeInspector, inspectorBack, openInspector, setInspectorPinned } from './inspector-store'

const top = () => { const s = __inspectorTest.read(); return s.stack[s.stack.length - 1] ?? null }

describe('universal inspector stack', () => {
  beforeEach(() => __inspectorTest.reset())

  it('inspects, stacks related objects, and steps back', () => {
    openInspector({ type: 'seller', id: 'T1', label: 'Wendy' })
    openInspector({ type: 'property', id: 'P1', label: '3025 Sunbeam' })
    expect(top()?.id).toBe('P1')
    inspectorBack()
    expect(top()?.id).toBe('T1')
  })

  it('re-inspecting the current object is a no-op; replace starts a fresh stack', () => {
    openInspector({ type: 'seller', id: 'T1' })
    openInspector({ type: 'seller', id: 'T1' })
    expect(__inspectorTest.read().stack).toHaveLength(1)
    openInspector({ type: 'property', id: 'P1' })
    openInspector({ type: 'campaign', id: 'C1' }, { replace: true })
    expect(__inspectorTest.read().stack.map((r) => r.id)).toEqual(['C1'])
  })

  it('close clears the stack and the pin; references only, never a copy of the entity', () => {
    openInspector({ type: 'closing', id: 'K1', hint: { property_id: 'P1' } })
    setInspectorPinned(true)
    closeInspector()
    expect(__inspectorTest.read()).toEqual({ stack: [], pinned: false })
  })

  it('ignores refs without an id', () => {
    openInspector({ type: 'buyer', id: '' })
    expect(__inspectorTest.read().stack).toHaveLength(0)
  })
})
