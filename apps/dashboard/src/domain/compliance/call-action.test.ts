import { describe, expect, it } from 'vitest'
import { callGateFromDossier, normalizeDialable, resolveCallAction } from './call-action'

describe('normalizeDialable', () => {
  it('normalises NANP forms to E.164', () => {
    expect(normalizeDialable('+16122756497')).toBe('+16122756497')
    expect(normalizeDialable('(612) 275-6497')).toBe('+16122756497')
    expect(normalizeDialable('16122756497')).toBe('+16122756497')
  })
  it('rejects non-phones', () => {
    for (const v of ['', '  ', null, undefined, '12345', 'thread_abc', '+1012345678', '0612275649', 'prop:123']) {
      expect(normalizeDialable(v as string)).toBeNull()
    }
  })
})

describe('resolveCallAction', () => {
  const ok = '+16122756497'
  it('allows a clean, valid number', () => {
    const v = resolveCallAction({ phone: ok, suppressed: false, contactability: 'contactable' })
    expect(v).toMatchObject({ allowed: true, href: 'tel:+16122756497' })
  })
  it.each([
    ['opted_out', 'opted out'],
    ['dnc', 'do-not-contact'],
    ['do_not_contact', 'do not contact'],
    ['do_not_text', 'do not contact'],
    ['invalid_number', 'not valid'],
    ['wrong_number', 'wrong number'],
    ['provider_blacklisted', 'suppressed'],
  ])('blocks contactability %s with a plain reason', (code, fragment) => {
    const v = resolveCallAction({ phone: ok, suppressed: false, contactability: code })
    expect(v.allowed).toBe(false)
    expect(v.href).toBeNull()
    expect(v.reason?.toLowerCase()).toContain(fragment)
  })
  it('blocks suppression even when contactability says contactable', () => {
    expect(resolveCallAction({ phone: ok, suppressed: true, contactability: 'contactable' })).toMatchObject({ allowed: false, reason: 'Contact is suppressed' })
  })
  it('blocks wrong number, missing and invalid phones, and pending subjects', () => {
    expect(resolveCallAction({ phone: ok, wrongNumber: true }).allowed).toBe(false)
    expect(resolveCallAction({ phone: null }).reason).toBe('No phone on file')
    expect(resolveCallAction({ phone: 'abc' }).reason).toBe('Number is not valid')
    expect(resolveCallAction({ phone: ok, pending: true }).allowed).toBe(false)
  })
  it('does not block on an unknown contactability code by itself', () => {
    expect(resolveCallAction({ phone: ok, contactability: 'something_new' }).allowed).toBe(true)
  })
})

describe('callGateFromDossier', () => {
  it('holds the call while the dossier is not loaded', () => {
    expect(resolveCallAction(callGateFromDossier(null, '+16122756497')).allowed).toBe(false)
  })
  it('reads compliance, phone and conversation blocks', () => {
    const base = { compliance: { is_suppressed: false }, phone: { number: '+16122756497' }, conversation_intelligence: {} }
    expect(resolveCallAction(callGateFromDossier(base, '+16122756497')).allowed).toBe(true)
    expect(resolveCallAction(callGateFromDossier({ ...base, compliance: { is_suppressed: true } }, '+16122756497')).allowed).toBe(false)
    expect(resolveCallAction(callGateFromDossier({ ...base, compliance: { contactability_status: 'do_not_contact' } }, '+16122756497')).allowed).toBe(false)
    expect(resolveCallAction(callGateFromDossier({ ...base, phone: { wrong_number: true } }, '+16122756497')).allowed).toBe(false)
    expect(resolveCallAction(callGateFromDossier({ ...base, conversation_intelligence: { suppressed: true } }, '+16122756497')).allowed).toBe(false)
  })
})
