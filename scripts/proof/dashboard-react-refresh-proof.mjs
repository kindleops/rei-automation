#!/usr/bin/env node

const BASE = process.env.DASHBOARD_PROOF_BASE_URL || 'http://127.0.0.1:5173'
let failures = 0

function fail(label, detail = '') {
  failures += 1
  console.error(`FAIL ${label}${detail ? ` ${detail}` : ''}`)
}

function pass(label, detail = '') {
  console.log(`PASS ${label}${detail ? ` ${detail}` : ''}`)
}

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  return { response, text: await response.text() }
}

async function main() {
  const { response: htmlRes, text: html } = await fetchText(`${BASE}/`)
  htmlRes.ok ? pass('dashboard document', `status=${htmlRes.status}`) : fail('dashboard document', `status=${htmlRes.status}`)
  html.includes('$RefreshSig$') ? pass('html react-refresh preamble') : fail('html react-refresh preamble')
  html.includes('/@vite/client') ? pass('html vite client script') : fail('html vite client script')

  const { response: clientRes } = await fetchText(`${BASE}/@vite/client`)
  clientRes.ok ? pass('/@vite/client', `status=${clientRes.status}`) : fail('/@vite/client', `status=${clientRes.status}`)

  const { response: refreshRes, text: refreshBody } = await fetchText(`${BASE}/@react-refresh`)
  refreshRes.ok ? pass('/@react-refresh', `status=${refreshRes.status}`) : fail('/@react-refresh', `status=${refreshRes.status}`)
  refreshBody.includes('injectIntoGlobalHook') ? pass('/@react-refresh runtime') : fail('/@react-refresh runtime')

  const { response: moduleRes, text: moduleBody } = await fetchText(`${BASE}/src/components/auth/AuthProvider.tsx`)
  moduleRes.ok ? pass('AuthProvider module', `status=${moduleRes.status}`) : fail('AuthProvider module', `status=${moduleRes.status}`)
  moduleBody.includes('$RefreshSig$') ? pass('AuthProvider refresh transform') : fail('AuthProvider refresh transform')

  if (failures > 0) {
    console.error(`FAIL dashboard-react-refresh-proof failures=${failures}`)
    process.exit(1)
  }
  console.log('PASS dashboard-react-refresh-proof')
}

main().catch((error) => {
  console.error('FAIL dashboard-react-refresh-proof crashed', error?.message || error)
  process.exit(1)
})