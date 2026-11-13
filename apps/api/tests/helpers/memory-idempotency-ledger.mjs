// The in-process durable-state backend, injected explicitly into the idempotency ledger.
//
// Under NODE_ENV=test (the chunked suite) durable-state-backend.js already resolves to its memory
// backend. A test FILE run alone (plain `node --test <file>`) has no NODE_ENV, so the backend
// resolves to Postgres and idempotency_begin / _complete / _fail become Supabase RPCs (blocked by
// the critical fetch guard). The critical-test environment resets process.env before every test,
// so pinning RUNTIME_STATE_BACKEND at module scope does not survive; this helper injects the
// memory backend through the ledger's own test seam instead. The memory backend mirrors the SQL
// semantics of public.idempotency_ledger (INSERT … ON CONFLICT claims, leases, reclaim).
import { getDurableBackend, DURABLE_BACKEND_MEMORY } from '../../src/lib/domain/runtime/durable-state-backend.js'
import { __resetIdempotencyLedgerTestDeps, __setIdempotencyLedgerTestDeps } from '../../src/lib/domain/events/idempotency-ledger.js'

function memoryDurableBackend() {
  const prev = process.env.RUNTIME_STATE_BACKEND
  process.env.RUNTIME_STATE_BACKEND = DURABLE_BACKEND_MEMORY
  try {
    return getDurableBackend()
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_STATE_BACKEND
    else process.env.RUNTIME_STATE_BACKEND = prev
  }
}

const MEMORY = memoryDurableBackend()

/** Clear the memory ledger and route every ledger call to the memory backend (no RPC, no network). */
export function resetMemoryIdempotencyLedger() {
  __resetIdempotencyLedgerTestDeps()
  __setIdempotencyLedgerTestDeps({ getDurableBackend: () => MEMORY })
}
