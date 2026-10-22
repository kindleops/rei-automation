// Workforce store (docs/WORKFORCE.md §11): the contract between the DB layer and the engine.
//
//   createWorkforcePgStore({ pool })      Postgres (pool connects as agent_api)
//   createWorkforceMemoryStore({ now })   the engine's unit-test twin (same semantics)
//
// Both implement the same async interface and throw WorkforceStoreError { code } with
// code ∈ NOT_FOUND, CONFLICT, LEASE_LOST, ILLEGAL_TRANSITION, PAYLOAD_REFUSED, CLAIM_HELD,
// VERSION_MISMATCH, FORBIDDEN (UNAVAILABLE for an infrastructure failure of the PG store).
export { createWorkforcePgStore } from './workforce-pg-store.js'
export { createWorkforceMemoryStore, LEADCOMMAND_ORG_ID } from './workforce-memory-store.js'
export { WorkforceStoreError, WORKFORCE_ERROR_CODES, WORKFORCE_UNAVAILABLE, isWorkforceStoreError } from './errors.js'
export {
  ASSIGNMENT_TRANSITIONS, MISSION_TRANSITIONS, ASSIGNMENT_STATES, MISSION_STATES, ASSIGNMENT_TERMINAL_STATES, MISSION_TERMINAL_STATES,
  ROLE_DEPARTMENTS, ROLE_KEYS, DEPARTMENT_KEYS, canAssignmentTransition, canMissionTransition, backoffSeconds,
} from './transitions.js'
