import { describe, expect, it } from 'vitest'
import {
  applySubjectCoordinates,
  findPinForThread,
  isMappableCoord,
  pinMatchesThread,
  resolveSubjectPropertyId,
  threadNeedsCoordinates,
  threadRefKeys,
} from '../../src/domain/inbox/map-selection-sync'
import type { InboxWorkflowThread } from '../../src/lib/data/inboxWorkflowData'

const thread = {
  id: 'row-1',
  threadKey: 'thread-key-1',
  propertyId: 'prop-99',
} as InboxWorkflowThread

describe('threadRefKeys', () => {
  it('collects id, threadKey, and propertyId refs', () => {
    expect(threadRefKeys(thread)).toEqual(expect.arrayContaining(['row-1', 'thread-key-1', 'prop-99']))
  })
})

describe('pinMatchesThread', () => {
  it('matches conversation_id to thread id', () => {
    expect(pinMatchesThread({ conversation_id: 'row-1' }, thread)).toBe(true)
  })

  it('matches by property_id when thread ids differ', () => {
    expect(pinMatchesThread({ conversation_id: 'other', property_id: 'prop-99' }, thread)).toBe(true)
  })

  it('honors extra selected pin ids', () => {
    expect(pinMatchesThread({ conversation_id: 'legacy-id' }, thread, ['legacy-id'])).toBe(true)
  })
})

describe('findPinForThread', () => {
  it('returns the pin that matches the selected thread', () => {
    const pins = [
      { conversation_id: 'other', property_id: 'prop-1' },
      { conversation_id: 'row-1', property_id: 'prop-99' },
    ]
    expect(findPinForThread(pins, thread)?.conversation_id).toBe('row-1')
  })

  it('does not fall back to the first pin when nothing matches', () => {
    const pins = [
      { conversation_id: 'a', property_id: 'prop-1' },
      { conversation_id: 'b', property_id: 'prop-2' },
    ]
    expect(findPinForThread(pins, thread)).toBeUndefined()
  })
})

describe('isMappableCoord', () => {
  it('rejects zero coordinates', () => {
    expect(isMappableCoord(0, 0)).toBe(false)
  })

  it('accepts real coordinates', () => {
    expect(isMappableCoord(35.14, -90.05)).toBe(true)
  })
})

describe('applySubjectCoordinates', () => {
  it('fills coordinates from deal context when the thread is missing them', () => {
    const hydrated = applySubjectCoordinates(thread, {
      latitude: 35.14,
      longitude: -90.05,
      property_id: 'prop-99',
    })
    expect(hydrated?.lat).toBe(35.14)
    expect(hydrated?.lng).toBe(-90.05)
  })

  it('fills coordinates from the property record when deal context is empty', () => {
    const hydrated = applySubjectCoordinates(thread, null, {
      property_id: 'prop-99',
      latitude: 35.2,
      longitude: -90.1,
    })
    expect(hydrated?.lat).toBe(35.2)
    expect(hydrated?.lng).toBe(-90.1)
  })

  it('keeps existing thread coordinates when already mappable', () => {
    const withCoords = { ...thread, lat: 33.1, lng: -96.8 } as typeof thread
    const hydrated = applySubjectCoordinates(withCoords, { latitude: 35.14, longitude: -90.05 })
    expect(hydrated?.lat).toBe(33.1)
    expect(hydrated?.lng).toBe(-96.8)
  })
})

describe('resolveSubjectPropertyId', () => {
  it('prefers deal context property id over thread fields', () => {
    expect(resolveSubjectPropertyId(thread, { property_id: 'ctx-1' })).toBe('ctx-1')
  })

  it('falls back to thread propertyId', () => {
    expect(resolveSubjectPropertyId({ ...thread, propertyId: 'prop-77' })).toBe('prop-77')
  })
})

describe('threadNeedsCoordinates', () => {
  it('returns true when coordinates are missing', () => {
    expect(threadNeedsCoordinates(thread)).toBe(true)
  })

  it('returns false when coordinates are present', () => {
    expect(threadNeedsCoordinates({ ...thread, lat: 35.1, lng: -90.2 })).toBe(false)
  })
})