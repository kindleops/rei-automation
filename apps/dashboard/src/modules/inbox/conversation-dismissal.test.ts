import { describe, expect, it } from 'vitest'
import { contextIdentity, nextDismissal, shouldReanchorFromContext } from './conversation-dismissal'

const linked = { threadKey: '+16125550101', propertyId: 'p-1', sourceView: 'map' as const }

describe('closing a conversation stays closed', () => {
  it('repro: the legacy rule re-selects the thread the operator just closed', () => {
    // close cleared the selection; the context still names the linked property's seller
    expect(shouldReanchorFromContext(linked, { selectedMatches: false, dismissed: null })).toBe(true)
  })

  it('a dismissed context does not re-anchor', () => {
    const dismissed = contextIdentity(linked)
    expect(shouldReanchorFromContext(linked, { selectedMatches: false, dismissed })).toBe(false)
  })

  it('a different entity clears the dismissal and anchors normally', () => {
    const dismissed = contextIdentity(linked)
    const next = { threadKey: '+16125550202', propertyId: 'p-2' }
    expect(nextDismissal(next, dismissed)).toBeNull()
    expect(shouldReanchorFromContext(next, { selectedMatches: false, dismissed: nextDismissal(next, dismissed) })).toBe(true)
  })

  it('the same entity keeps the dismissal; an empty context has nothing to anchor', () => {
    const dismissed = contextIdentity(linked)
    expect(nextDismissal({ ...linked, sourceView: 'inbox' as const }, dismissed)).toBe(dismissed)
    expect(contextIdentity({ sourceView: 'inbox' })).toBeNull()
    expect(shouldReanchorFromContext({ sourceView: 'inbox' }, { selectedMatches: false, dismissed: null })).toBe(false)
  })
})
