/**
 * Poll scheduler unit proof — healthy realtime must not tick over 120s simulated.
 * Run: npx tsx scripts/proof/inbox-poll-scheduler.test.ts
 */
import {
  createDegradedPollScheduler,
  createSelectedThreadPollScheduler,
  POLL_INTERVAL_DEGRADED_MS,
  POLL_INTERVAL_SELECTED_MS,
} from '../../src/domain/inbox/inbox-poll-scheduler'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    passed += 1
  } catch (err) {
    console.error(`  ❌ ${name}`)
    console.error(`     ${(err as Error).message}`)
    failed += 1
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

const fakeNow = { value: 0 }
const timers = new Map<number, { fn: () => void; at: number; interval: number }>()
let nextId = 1

function fakeSetInterval(fn: () => void, ms: number) {
  const id = nextId++
  timers.set(id, { fn, at: fakeNow.value + ms, interval: ms })
  return id as unknown as ReturnType<typeof setInterval>
}

function fakeClearInterval(id: ReturnType<typeof setInterval>) {
  timers.delete(id as unknown as number)
}

function advance(ms: number) {
  fakeNow.value += ms
  for (const [id, timer] of [...timers.entries()]) {
    while (fakeNow.value >= timer.at) {
      timer.fn()
      timer.at += timer.interval
      timers.set(id, timer)
    }
  }
}

test('degraded poll does not tick when realtime is connected for 120s', () => {
  let ticks = 0
  const scheduler = createDegradedPollScheduler({
    getRealtimeStatus: () => 'connected',
    isCancelled: () => false,
    isDocumentHidden: () => false,
    onTick: () => { ticks += 1 },
    intervalMs: POLL_INTERVAL_DEGRADED_MS,
    setIntervalFn: fakeSetInterval,
    clearIntervalFn: fakeClearInterval,
  })
  advance(120_000)
  scheduler.stop()
  assert(ticks === 0, `expected 0 degraded ticks, got ${ticks}`)
})

test('degraded poll ticks when realtime is error', () => {
  let ticks = 0
  const scheduler = createDegradedPollScheduler({
    getRealtimeStatus: () => 'error',
    isCancelled: () => false,
    isDocumentHidden: () => false,
    onTick: () => { ticks += 1 },
    intervalMs: POLL_INTERVAL_DEGRADED_MS,
    setIntervalFn: fakeSetInterval,
    clearIntervalFn: fakeClearInterval,
  })
  advance(POLL_INTERVAL_DEGRADED_MS)
  scheduler.stop()
  assert(ticks === 1, `expected 1 degraded tick, got ${ticks}`)
})

test('selected thread poll does not schedule when connection is live', () => {
  const scheduler = createSelectedThreadPollScheduler({
    getConnectionState: () => 'live',
    isDocumentHidden: () => false,
    isPollInFlight: () => false,
    onTick: () => { throw new Error('should not tick') },
    intervalMs: POLL_INTERVAL_SELECTED_MS,
    setIntervalFn: fakeSetInterval,
    clearIntervalFn: fakeClearInterval,
  })
  assert(scheduler == null, 'live connection must not schedule selected poll')
})

test('selected thread poll ticks only when offline', () => {
  let ticks = 0
  const scheduler = createSelectedThreadPollScheduler({
    getConnectionState: () => 'offline',
    isDocumentHidden: () => false,
    isPollInFlight: () => false,
    onTick: () => { ticks += 1 },
    intervalMs: POLL_INTERVAL_SELECTED_MS,
    setIntervalFn: fakeSetInterval,
    clearIntervalFn: fakeClearInterval,
  })!
  advance(POLL_INTERVAL_SELECTED_MS)
  scheduler.stop()
  assert(ticks === 1, `expected 1 selected tick, got ${ticks}`)
})

console.log(`\n── Poll scheduler: ${passed} passed, ${failed} failed ──`)
if (failed > 0) process.exit(1)