import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import { needsResponse } from './pipeline-mobile-filters'

/**
 * Mobile half of the new-reply parity contract.
 *
 * Reads the SAME fixture the API suite asserts against
 * (`apps/api/tests/critical/new-reply-parity.test.mjs` → `isNewReplyLead`), so
 * the desktop KPI and this board cannot silently answer different questions
 * again. They reported 2 and 63 for the same book because nothing pinned them
 * together; this file is that pin.
 *
 * If this import path breaks, the fixture moved — fix the path rather than
 * copying the fixture, or the surfaces are free to drift again.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../../../../api/tests/fixtures/new-reply-parity.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: Array<{ name: string; row: Record<string, unknown>; expected: boolean }>
}

describe('new-reply parity with the desktop KPI', () => {
  it('reads the shared fixture rather than a local copy', () => {
    expect(Array.isArray(FIXTURE.cases)).toBe(true)
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(10)
  })

  it.each(FIXTURE.cases.map((c) => [c.name, c.row, c.expected] as const))(
    'needsResponse: %s',
    (_name, row, expected) => {
      expect(needsResponse(row as unknown as PipelineOpportunity)).toBe(expected)
    },
  )
})
