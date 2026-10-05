import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decideArrival, decideAutoNav, pinLoadPlan } from './camera-claims'

const here = dirname(fileURLToPath(import.meta.url))

describe('camera claims — the Map never snaps back (symptom 4)', () => {
  it('a linked focus to B supersedes the host active A: a pin reload re-run does not fly back to A', () => {
    // arrival handled A earlier; a Pipeline click focuses B, superseding A (handled := A)
    let handled: string | null = 'A'
    const lastFocused = 'B'
    // the pin field reloads for the new viewport → the arrival effect re-runs with active still A
    expect(decideArrival({ active: 'A', handled, lastFocused })).toBe('skip')
    // the host then catches up to B (the Inbox opened B's thread): settle, do not re-fly
    const d = decideArrival({ active: 'B', handled, lastFocused })
    expect(d).toBe('settle')
    handled = 'B'
    expect(decideArrival({ active: 'B', handled, lastFocused })).toBe('skip')
  })

  it('a genuinely new active property still arrives', () => {
    expect(decideArrival({ active: 'C', handled: 'B', lastFocused: 'B' })).toBe('arrive')
    expect(decideArrival({ active: null, handled: 'B', lastFocused: 'B' })).toBe('idle')
  })

  it('auto-nav: a coordinate refinement of the same thread yields after a focus request claimed the camera', () => {
    const prev = { threadId: 'tA', key: 'tA:1:2', claim: 0 }
    expect(decideAutoNav(prev, { threadId: 'tA', key: 'tA:1.0001:2' }, 1)).toBe('mark')
    // no claim since: a refinement may still correct the camera
    expect(decideAutoNav(prev, { threadId: 'tA', key: 'tA:1.0001:2' }, 0)).toBe('fly')
    // a different thread always flies
    expect(decideAutoNav(prev, { threadId: 'tB', key: 'tB:3:4' }, 1)).toBe('fly')
    expect(decideAutoNav(prev, { threadId: 'tA', key: 'tA:1:2' }, 1)).toBe('skip')
  })

  it('the Map wires the claims: focus requests claim, the arrival poll yields, the outcome no longer overwrites arrival', () => {
    const src = readFileSync(join(here, '..', 'InboxCommandMap.tsx'), 'utf8')
    expect(src).toContain('cameraClaimRef.current += 1')
    expect(src).toContain('cameraClaimRef.current !== claimAtStart')
    expect(src).not.toContain("if (outcome.status === 'focused') arrivedPropertyRef.current = outcome.propertyId")
  })
})

describe('the Inbox → Map follow does not blink (symptom 2)', () => {
  it('a resume keeps the pin field: one full pass, never the capped first pass again', () => {
    expect(pinLoadPlan(false)).toEqual(['stage_1', 'stage_2'])
    expect(pinLoadPlan(true)).toEqual(['stage_2'])
  })

  it('the Map component is not remounted by a follow: its container key only moves on a GL context restore', () => {
    const src = readFileSync(join(here, '..', 'InboxCommandMap.tsx'), 'utf8')
    // the map instance is created once per container key, and the key is bumped only in the context-restore path
    expect(src.match(/setMapContainerKey\(/g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(src).toContain('pinLoadPlan(sellerPinsByPropertyIdRef.current.size > 0)')
  })
})
