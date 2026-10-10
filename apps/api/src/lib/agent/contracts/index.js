// LeadCommand Global AI Agent — shared contracts barrel (S1).
//
// The S2 interface consumes these files directly. Every module here is pure
// ESM with JSDoc types, no imports outside this directory and no Node-only
// APIs, so the dashboard can import or vendor them unchanged.
//
//   states.js    run / tool-call / research job / task states, phases, tiers
//   events.js    event envelope, event types + payload whitelist, operation labels
//   evidence.js  evidence statuses, source + finding shapes, brief sections
//   approval.js  approval request shape, states, refusal copy, TTLs
//   cost.js      cost display shape, cap keys, owner default caps
//   reducer.js   pure event → run view reducer (server snapshot == UI view)
//   fixtures/    deterministic fixture event-log generator (8 design-review scenarios)

export * from './states.js'
export * from './events.js'
export * from './evidence.js'
export * from './approval.js'
export * from './cost.js'
export * from './reducer.js'

export const AGENT_CONTRACTS_VERSION = '2026-10-08.s1'
