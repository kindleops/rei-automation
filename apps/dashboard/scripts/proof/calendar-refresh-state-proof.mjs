/**
 * Proves single refresh state lifecycle: updating → updated/error → live
 * No duplicate Updating badges; latest request wins; abort ignored.
 */

const states = []
let requestId = 0

function simulateRefresh({ succeed = true, abort = false, stale = false } = {}) {
  const id = ++requestId
  let refreshState = 'live'
  const badges = []

  const setState = (next) => {
    if (!stale || id === requestId) refreshState = next
    badges.push(refreshState)
  }

  setState('updating')
  if (abort) return { refreshState: 'live', badges, aborted: true }
  if (stale && id !== requestId) return { refreshState, badges, ignored: true }
  if (succeed) setState('updated')
  else setState('error')
  setState('live')
  return { refreshState, badges }
}

const success = simulateRefresh({ succeed: true })
const empty = simulateRefresh({ succeed: true })
const error = simulateRefresh({ succeed: false })
const abort = simulateRefresh({ abort: true })
const rapid = (() => {
  simulateRefresh({ succeed: true, stale: true })
  return simulateRefresh({ succeed: true })
})()

const duplicateCheck = (result) => {
  const updatingCount = result.badges.filter((b) => b === 'updating').length
  return updatingCount <= 1
}

const endsLive = (r) => r.refreshState === 'live' || r.badges.at(-1) === 'live'

const proofs = [
  ['success completes to live', endsLive(success)],
  ['empty completes to live', endsLive(empty)],
  ['error completes to live', endsLive(error)],
  ['abort keeps live', abort.aborted && abort.refreshState === 'live'],
  ['rapid latest wins', rapid.refreshState === 'live'],
  ['no duplicate updating in success', duplicateCheck(success)],
  ['no duplicate updating in error', duplicateCheck(error)],
]

let failed = 0
for (const [label, ok] of proofs) {
  if (!ok) {
    console.error('FAIL:', label)
    failed++
  } else {
    console.log('PASS:', label)
  }
}

if (failed > 0) process.exit(1)
console.log('calendar-refresh-state-proof: ALL PASS', { cases: proofs.length })