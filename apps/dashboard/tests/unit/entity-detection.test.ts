import { describe, expect, it } from 'vitest'
import { isEntityName, safeHumanName } from '../../src/lib/identity/entityDetection'

describe('entity detection (launch blocker: Master Owner names must never become recipient first names)', () => {
  it('flags LLC, trust, and estate names as entities', () => {
    expect(isEntityName('West 7th Apartments LLC')).toBe(true)
    expect(isEntityName('88 Cleveland - M LLC')).toBe(true)
    expect(isEntityName('D & D Divide LLC')).toBe(true)
    expect(isEntityName('Smith Family Trust')).toBe(true)
    expect(isEntityName('Jones Estate')).toBe(true)
    expect(isEntityName('First National Bank')).toBe(true)
    expect(isEntityName('Grace Community Church')).toBe(true)
  })

  it('does not flag real human names', () => {
    expect(isEntityName('Maria Lopez')).toBe(false)
    expect(isEntityName('Jose A Valdizon')).toBe(false)
    expect(isEntityName('Jane Smith')).toBe(false)
    expect(isEntityName('')).toBe(false)
    expect(isEntityName(null)).toBe(false)
    expect(isEntityName(undefined)).toBe(false)
  })

  it('safeHumanName passes through real names and blanks out entity names', () => {
    expect(safeHumanName('Maria Lopez')).toBe('Maria Lopez')
    expect(safeHumanName('West 7th Apartments LLC')).toBe('')
    expect(safeHumanName('  ')).toBe('')
    expect(safeHumanName(null)).toBe('')
  })
})
