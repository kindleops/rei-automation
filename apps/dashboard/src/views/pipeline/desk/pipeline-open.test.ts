import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../modules/desktop/workspace/workspace-store', () => ({ announceWorkspace: vi.fn(), isWorkspaceRunning: () => true, openApp: vi.fn() }))
vi.mock('../../../modules/mobile/mobile-inbox-bridge', () => ({ stageInboxThread: vi.fn() }))
vi.mock('../../../domain/locator/property-locator', () => ({ setPropertyLocator: vi.fn() }))
vi.mock('../../../app/router', () => ({ pushRoutePath: vi.fn() }))

import { openFromPipeline, pipelineTargetPath, type OpenDeps } from './pipeline-open'
import { RETURN_KEY, RETURN_TTL_MS, clearReturnState, peekReturnState, saveReturnState } from './pipeline-return'

const card = { id: 'O1', propertyId: 'P1', threadKey: 'T1', masterOwnerId: 'M1', address: '1 Main St' }

function deps(over: Partial<OpenDeps> = {}) {
  return {
    running: vi.fn(() => true),
    openBeside: vi.fn(() => 'opened' as const),
    navigate: vi.fn(),
    publish: vi.fn(),
    stageThread: vi.fn(),
    announce: vi.fn(),
    saveReturn: vi.fn(),
    ...over,
  }
}

describe('pipeline cross-app paths', () => {
  it('Deal Intelligence is the real app, aimed by property first', () => {
    expect(pipelineTargetPath('deal_intelligence', card)).toBe('/deal-intelligence?property_id=P1')
    expect(pipelineTargetPath('deal_intelligence', { id: 'O', threadKey: 'T9' })).toBe('/deal-intelligence?thread_key=T9')
    expect(pipelineTargetPath('deal_intelligence', { id: 'O' })).toBeNull()
  })
  it('every target carries the canonical subject', () => {
    expect(pipelineTargetPath('conversation', card)).toBe('/inbox?thread=T1')
    expect(pipelineTargetPath('entity_graph', card)).toBe('/entity-graph/property/P1')
    expect(pipelineTargetPath('buyer_match', card)).toBe('/buyer-match?property_id=P1')
    expect(pipelineTargetPath('comps', card)).toBe('/comp-intelligence?property_id=P1')
    expect(pipelineTargetPath('closing', card)).toBe('/closing-desk?property_id=P1&master_owner_id=M1')
    expect(pipelineTargetPath('conversation', { id: 'O' })).toBeNull()
  })
})

describe('openFromPipeline — never traps the operator', () => {
  it('opens beside Pipeline and never navigates this pane', () => {
    const d = deps()
    expect(openFromPipeline('deal_intelligence', card, d)).toBe('beside')
    expect(d.openBeside).toHaveBeenCalledWith('/deal-intelligence?property_id=P1')
    expect(d.publish).toHaveBeenCalledWith(card)
    expect(d.navigate).not.toHaveBeenCalled()
    expect(d.saveReturn).not.toHaveBeenCalled()
  })
  it('an app already open is focused and re-aimed (one instance per app)', () => {
    const d = deps({ openBeside: vi.fn(() => 'focused' as const) })
    expect(openFromPipeline('entity_graph', card, d)).toBe('focused')
    expect(d.navigate).not.toHaveBeenCalled()
  })
  it('Open conversation stages exactly that thread for the Inbox pane', () => {
    const d = deps()
    openFromPipeline('conversation', card, d)
    expect(d.stageThread).toHaveBeenCalledWith('T1', 'P1')
    expect(d.openBeside).toHaveBeenCalledWith('/inbox?thread=T1')
  })
  it('a full workspace takes this pane through history, after saving the return state', () => {
    const order: string[] = []
    const d = deps({ openBeside: vi.fn(() => 'refused' as const), saveReturn: vi.fn(() => { order.push('save') }), navigate: vi.fn(() => { order.push('nav') }) })
    expect(openFromPipeline('buyer_match', card, d)).toBe('navigated')
    expect(order).toEqual(['save', 'nav'])
    expect(d.announce).toHaveBeenCalled()
  })
  it('no shell: a real navigation with a return snapshot', () => {
    const d = deps({ running: vi.fn(() => false) })
    expect(openFromPipeline('comps', card, d)).toBe('navigated')
    expect(d.openBeside).not.toHaveBeenCalled()
    expect(d.saveReturn).toHaveBeenCalled()
  })
  it('a deal with no identifier for the target does nothing', () => {
    const d = deps()
    expect(openFromPipeline('entity_graph', { id: 'O' }, d)).toBe('unavailable')
    expect(d.publish).not.toHaveBeenCalled()
  })
})

describe('pipeline return state', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } } }
  const state = { mode: 'table' as const, params: { scope: 'active' as const, market: 'Dallas' }, query: 'baldwin', owner: 'needs_you' as const, stage: 'offer', showDormant: true, openId: 'O1', scrollTop: 120, gridScrollTop: 840 }
  it('round-trips the exact state and clears on demand', () => {
    const s = mem()
    saveReturnState(state, s, 1000)
    expect(peekReturnState(s, 2000)).toMatchObject({ ...state, savedAt: 1000 })
    clearReturnState(s)
    expect(peekReturnState(s, 2000)).toBeNull()
  })
  it('a stale or malformed snapshot is not a return', () => {
    const s = mem()
    saveReturnState(state, s, 0)
    expect(peekReturnState(s, RETURN_TTL_MS + 1)).toBeNull()
    s.setItem(RETURN_KEY, '{bad')
    expect(peekReturnState(s)).toBeNull()
  })
})
