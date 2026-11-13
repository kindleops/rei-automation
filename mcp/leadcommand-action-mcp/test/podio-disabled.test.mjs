// LeadCommand is the CRM; the gateway runs with the legacy Podio provider disabled: no warnings, no Podio I/O.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the gateway loader disables the Podio provider before any app module loads', async () => {
  assert.equal(process.env.PODIO_INTEGRATION_DISABLED, '1')
  const podio = await import('@/lib/providers/podio.js')
  assert.equal(podio.isPodioAvailable(), false)
  assert.equal(podio.getPodioAvailability().reason, 'podio_integration_disabled')
  await assert.rejects(() => podio.getItem(1), (e) => podio.isPodioUnavailableError(e))
})

test('booting the gateway prints no Podio warning', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'bin/leadcommand-action-mcp.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: '/nonexistent', LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http' },
  })
  const out = `${r.stdout}${r.stderr}`
  assert.match(out, /server_boot_failed/) // config deliberately incomplete; the app graph is imported first
  assert.doesNotMatch(out, /podio/i)
})
