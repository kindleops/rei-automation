import test from 'node:test'
import assert from 'node:assert/strict'
import { getNextExpansionStep, COMP_SEARCH_EXPANSION_STEPS } from '../../src/domain/comp-intelligence/direct-pipeline'

test('getNextExpansionStep advances search ladder', () => {
  assert.deepEqual(getNextExpansionStep(0.5, 6), COMP_SEARCH_EXPANSION_STEPS[2])
  assert.deepEqual(getNextExpansionStep(5, 24), null)
})

test('direct pipeline uses exact radius discovery function', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/domain/comp-intelligence/direct-pipeline.ts'),
    'utf8',
  )
  assert.match(source, /discoverCandidatesExact/)
  assert.equal(source.includes('if (candidates.length >= 3) break'), false)
})