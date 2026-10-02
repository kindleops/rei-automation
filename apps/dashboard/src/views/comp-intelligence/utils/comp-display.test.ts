import { describe, expect, it } from 'vitest'
import { displayAddress } from './comp-display'

describe('displayAddress', () => {
  it('capitalises a title-cased state code before a ZIP', () => {
    expect(displayAddress('3722 Fremont Ave N, Minneapolis, Mn 55412')).toBe('3722 Fremont Ave N, Minneapolis, MN 55412')
    expect(displayAddress('Minneapolis, Mn 55412-1234')).toBe('Minneapolis, MN 55412-1234')
  })
  it('capitalises a trailing state code and one followed by a comma', () => {
    expect(displayAddress('12 Elm St, Dallas, Tx')).toBe('12 Elm St, Dallas, TX')
    expect(displayAddress('12 Elm St, Dallas, Tx, USA')).toBe('12 Elm St, Dallas, TX, USA')
  })
  it('leaves everything else untouched', () => {
    expect(displayAddress('3635 Emerson Ave N, Minneapolis, MN 55412')).toBe('3635 Emerson Ave N, Minneapolis, MN 55412')
    expect(displayAddress('4601 Newton Ave N')).toBe('4601 Newton Ave N')
    expect(displayAddress('1 Main St, Saint Paul, Mn 55101')).toBe('1 Main St, Saint Paul, MN 55101')
    expect(displayAddress(null)).toBeNull()
  })
})
