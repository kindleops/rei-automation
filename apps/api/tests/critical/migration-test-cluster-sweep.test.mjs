// Test temp lifecycle (agntei reconciliation): leftover migration-test clusters from killed runs are removed by the next
// run; a running cluster, a fresh one, a symlink or a folder that is not a cluster is never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaleClusters } from '../../../../scripts/db/run-migration-test.mjs'

const mk = (base, name, { pid = null, cluster = true } = {}) => {
  const d = path.join(base, name)
  fs.mkdirSync(path.join(d, 'data'), { recursive: true })
  if (cluster) fs.writeFileSync(path.join(d, 'data', 'PG_VERSION'), '17\n')
  if (pid != null) fs.writeFileSync(path.join(d, 'data', 'postmaster.pid'), `${pid}\n/x\n`)
  return d
}

test('a leftover cluster with no live postmaster is removed; live, fresh, non-cluster and symlinked folders stay', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'))
  const dead = mk(base, 'lc-mt-dead01', { pid: 999999 })
  const nopid = mk(base, 'lc-mt-nopid1')
  const live = mk(base, 'lc-mt-live01', { pid: process.pid })
  const other = mk(base, 'lc-mt-other1', { cluster: false })
  const target = mk(base, 'keep-target')
  fs.symlinkSync(target, path.join(base, 'lc-mt-link01'))
  const later = Date.now() + 2 * 3_600_000
  assert.deepEqual(sweepStaleClusters(base).sort(), [], 'within the first hour nothing is removed')
  assert.deepEqual(sweepStaleClusters(base, { now: later }).sort(), [dead, nopid].sort())
  for (const d of [live, other, target, path.join(base, 'lc-mt-link01')]) assert.equal(fs.existsSync(d), true, d)
  fs.rmSync(base, { recursive: true, force: true })
})
