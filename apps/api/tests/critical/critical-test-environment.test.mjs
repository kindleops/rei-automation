import test from 'node:test'
import assert from 'node:assert/strict'

import { assertFetchGuardBlocksExternal } from '../helpers/critical-test-environment.mjs'

test('critical fetch guard blocks unmocked external Supabase host', async () => {
  await assert.rejects(assertFetchGuardBlocksExternal(), /CRITICAL_TEST_NETWORK_BLOCKED/)
})