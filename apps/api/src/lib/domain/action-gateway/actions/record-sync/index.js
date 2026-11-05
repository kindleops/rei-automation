// agntei ↔ LeadCommand record sync (link 10, PROPOSED, born OFF): versioned writes to a lead's canonical record.
//
//   apply_record_change         an agent changes one synchronized field of a lead — its seller-conversation stage, its
//                               pipeline stage (the thread and its opportunity together), temperature, operational
//                               status, disposition, archive state, follow-up date, opportunity status, the property's
//                               market status, the agreement status, the next-action date — on named evidence, with the
//                               version it last saw (expected_version). The database refuses a stale write
//                               (VERSION_CONFLICT, with the current value), an automated write over a person's edit
//                               unless its evidence is newer (PROTECTED_MANUAL), over an operator's lock
//                               (PROTECTED_MANUAL_LOCK), an unverified write over a verified fact (PROTECTED_VERIFIED),
//                               a stage regression (a person's decision) and a contract or later stage without a signed
//                               production agreement. Routine: a standing T2 grant, no per-change approval.
//   apply_person_record_change  the same write made by a PERSON in agntei: only agntei's console credential holds this
//                               capability; it names the person (edited_by), who is recorded as the actor (a person's edit is
//                               protected from stale automated writes).
//   get_record_state            (read) the lead's synchronized record now: value, version and provenance of each field.
//   get_record_history          (read) the lead's change history: source system, actor, time, old and new value,
//                               evidence, reason and version of each change.
//
// Every write goes through the ONE gateway pipeline and the ONE lease-bound domain write
// (public.action_gateway_dw_record_change); the change, its history row and its event on the lead feed commit together.
import { UUID, obj, enumOf, num, str, bool } from '../../../../agent/capabilities/defs/_schema.js'
import { TIERS } from '../../constants.js'
import { client, TEXT, ISO_TIME } from '../t2/_schema.js'
import { cleanText, neverReviveCode, deny, allow, mustThread, threadResource } from '../t2/shared.js'

export const RECORD_DOMAIN_WRITE = 'action_gateway_dw_record_change'
export const RECORD_FIELDS = Object.freeze(['conversation_stage', 'pipeline_stage', 'temperature', 'status', 'disposition', 'archived', 'follow_up_at',
  'opportunity_status', 'property_status', 'agreement_status', 'assigned_operator', 'next_action_due'])
export const EVIDENCE_SOURCES = Object.freeze(['seller_message', 'underwriting', 'research', 'agreement', 'leadcommand_record', 'document', 'person'])
/** A coded value: a stage, a status, `archived:<reason>`, `active`, an ISO time, or '' to clear a date. */
const VALUE = str(64, { pattern: '^[A-Za-z0-9_.:+-]{0,64}$' })
const REF = str(120, { minLength: 1, pattern: '^[A-Za-z0-9_.:-]{1,120}$' })
const EVIDENCE = obj({
  source: enumOf(EVIDENCE_SOURCES), ref: REF, quote: TEXT(600), at: ISO_TIME, message_id: REF, verified: bool(),
  environment: enumOf(['production', 'demo', 'simulated']), agreement_status: enumOf(['draft', 'sent', 'delivered', 'completed', 'declined', 'voided', 'expired']),
}, ['source'])
const PERSON = str(80, { minLength: 2, pattern: '^[A-Za-z][A-Za-z0-9_.:-]{1,79}$' })

const base = (name, capability) => ({ name, capability, tier: TIERS.T2, resource: 'thread', reversible: true, executor: { kind: 'domain_write', fn: RECORD_DOMAIN_WRITE }, recovery: 'reexecute', touches: [],
  wraps: { service: 'public.action_gateway_dw_record_change (link 10): canonical columns + lc_sync.field_versions / record_changes + the lead event feed', module: 'supabase/migrations/PROPOSED_20261101120000_record_sync.sql' } })

export const APPLY_SPEC = Object.freeze({
  ...base('apply_record_change', 'records.apply_change'), title: 'Change a field of a lead\'s record',
  description: 'Change ONE synchronized field of a lead in LeadCommand (its system of record): conversation_stage, pipeline_stage (S1–S10, the thread and its opportunity together), temperature, status, disposition, archived ("archived:sold|unavailable|duplicate|dead|other" or "active"), follow_up_at, opportunity_status, property_status, agreement_status, next_action_due. Give the version you last read (expected_version, from get_record_state; 0 for a field never set) and the evidence. A stale version is refused with the current value (VERSION_CONFLICT: read it, decide again); a person\'s edit stands unless your evidence is newer; an operator\'s lock is final; never a stage regression; a contract or later stage only on a signed production agreement. Every change is versioned, attributed to you and visible in agntei and LeadCommand at once.',
  input: obj({ ...client, thread_id: UUID, field: enumOf(RECORD_FIELDS.filter((f) => f !== 'assigned_operator')), value: VALUE, expected_version: num(0, 1e12), evidence: EVIDENCE, reason: TEXT(400, 3) }, ['client_request_id', 'thread_id', 'field', 'value', 'expected_version', 'evidence', 'reason']),
  limits: { per_min: 60 },
})
export const APPLY_PERSON_SPEC = Object.freeze({
  ...base('apply_person_record_change', 'records.apply_person_change'), title: 'A person\'s change to a lead\'s record (from agntei)',
  description: 'A person\'s edit made in agntei, written to LeadCommand as that person\'s change (only agntei\'s console credential holds this capability). Same fields and versioning as apply_record_change, plus assigned_operator; a person may move a stage back. Their edit is then protected from stale automated writes.',
  input: obj({ ...client, thread_id: UUID, field: enumOf(RECORD_FIELDS), value: VALUE, expected_version: num(0, 1e12), edited_by: PERSON, evidence: EVIDENCE, reason: TEXT(400, 3) }, ['client_request_id', 'thread_id', 'field', 'value', 'expected_version', 'edited_by', 'reason']),
  limits: { per_min: 120 },
})
export const STATE_READ_SPEC = Object.freeze({
  name: 'get_record_state', title: 'A lead\'s synchronized record',
  description: 'For one thread: each synchronized field with its value, version, when and by whom it last changed (source system, actor), whether a person\'s edit or a verified fact protects it and whether an operator locked it. Read it before apply_record_change: its versions are the ones to send.',
  capability: 'records.read', tier: TIERS.T1, scope: 'conversation_context.read', resource: 'thread',
  input: obj({ thread_id: UUID }, ['thread_id']), limits: { per_min: 120 },
  wraps: { service: 'public.action_gateway_record_state (link 10)', module: 'supabase/migrations/PROPOSED_20261101120000_record_sync.sql' },
})
export const HISTORY_READ_SPEC = Object.freeze({
  name: 'get_record_history', title: 'A lead\'s change history',
  description: 'For one thread: every change to its synchronized fields, newest first — source system (leadcommand, agntei), actor (person, agent, system), via which principal, intent, time, previous and new value, evidence, reason and version.',
  capability: 'records.read', tier: TIERS.T1, scope: 'conversation_context.read', resource: 'thread',
  input: obj({ thread_id: UUID, limit: num(1, 500) }, ['thread_id']), limits: { per_min: 60 },
  wraps: { service: 'public.action_gateway_record_history (link 10)', module: 'supabase/migrations/PROPOSED_20261101120000_record_sync.sql' },
})

const writeLogic = (person) => ({
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  async params(input, resource) {
    const ev = input.evidence ? Object.fromEntries(Object.entries(input.evidence).map(([k, v]) => [k, k === 'quote' ? cleanText(v, 600) : v])) : {}
    return { thread_id: resource.id, field: input.field, value: String(input.value ?? ''), expected_version: Number(input.expected_version), evidence: ev, reason: cleanText(input.reason, 400), ...(person ? { edited_by: String(input.edited_by) } : {}) }
  },
  async policy({ input, resource }) {
    const nr = neverReviveCode({ thread_id: resource.id, thread_key: resource.refs.thread_key, property_id: resource.refs.property_id })
    if (nr) return deny(nr, {})
    if (input.field === 'archived' && !/^(archived:(sold|unavailable|duplicate|dead|other)|active)$/.test(String(input.value))) return deny('VALUE_INVALID', { field: 'archived' })
    // the database decides the rest in the same transaction as the write (versions, protection, stage rules)
    return allow({ field: input.field, expected_version: Number(input.expected_version), by: person ? 'person' : 'agent' })
  },
})

export const RECORD_LOGIC = Object.freeze({
  apply_record_change: writeLogic(false),
  apply_person_record_change: writeLogic(true),
  get_record_state: {
    async read({ input, reads, coverResource }) {
      const t = await mustThread(reads, input.thread_id)
      coverResource({ type: 'thread', id: t.id, refs: { market: t.market || null } })
      return { resource_type: 'thread', thread_id: t.id, record: await reads.recordState(t.id), note: 'send a field\'s version as expected_version when you change it; values are LeadCommand\'s canonical record.' }
    },
  },
  get_record_history: {
    async read({ input, reads, coverResource }) {
      const t = await mustThread(reads, input.thread_id)
      coverResource({ type: 'thread', id: t.id, refs: { market: t.market || null } })
      return { resource_type: 'thread', thread_id: t.id, rows: (await reads.recordHistory(t.id, input.limit ?? 50)) || [] }
    },
  },
})
export const RECORD_ACTIONS = Object.freeze([APPLY_SPEC, APPLY_PERSON_SPEC])
export const RECORD_READS = Object.freeze([STATE_READ_SPEC, HISTORY_READ_SPEC])
export const RECORD_NAMES = Object.freeze([...RECORD_ACTIONS, ...RECORD_READS].map((s) => s.name))
