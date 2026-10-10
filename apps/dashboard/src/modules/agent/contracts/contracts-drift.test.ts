import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as M from './contracts'

/**
 * The dashboard mirror must agree with the S1 contracts in apps/api. When the
 * API files are not present in this checkout the suite is skipped (it never
 * passes vacuously: the skip is reported).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '../../../../../api/src/lib/agent/contracts')
const present = ['events.js', 'states.js', 'evidence.js', 'approval.js', 'cost.js'].every((f) => fs.existsSync(path.join(dir, f)))

describe.skipIf(!present)('agent contracts mirror ↔ apps/api S1 contracts', () => {
  const load = (f: string) => import(/* @vite-ignore */ path.join(dir, f))

  it('event types and operation templates', async () => {
    const ev = await load('events.js')
    expect([...M.EVENT_TYPES].sort()).toEqual([...ev.EVENT_TYPES].sort())
    expect(M.OPERATION_LABEL_TEMPLATES).toEqual({ ...ev.OPERATION_LABEL_TEMPLATES })
    expect([...M.LABELLED_EVENT_TYPES]).toEqual([...ev.LABELLED_EVENT_TYPES])
    expect(M.EVENT_SUMMARY_MAX_CHARS).toBe(ev.EVENT_SUMMARY_MAX_CHARS)
  })

  it('lifecycle states', async () => {
    const st = await load('states.js')
    expect([...M.RUN_STATES]).toEqual([...st.RUN_STATES])
    expect([...M.RUN_TERMINAL_STATES]).toEqual([...st.RUN_TERMINAL_STATES])
    expect([...M.TOOL_CALL_STATES]).toEqual([...st.TOOL_CALL_STATES])
    expect([...M.RESEARCH_JOB_STATES]).toEqual([...st.RESEARCH_JOB_STATES])
    expect([...M.RESEARCH_TASK_STATES]).toEqual([...st.RESEARCH_TASK_STATES])
    expect([...M.RESEARCH_PHASES]).toEqual([...st.RESEARCH_PHASES])
    expect(M.RESEARCH_PHASE_LABELS).toEqual({ ...st.RESEARCH_PHASE_LABELS })
    expect(M.RESEARCH_DEPTH_LABELS).toEqual({ ...st.RESEARCH_DEPTH_LABELS })
    expect([...M.JOB_PROPERTY_STATES]).toEqual([...st.JOB_PROPERTY_STATES])
    expect(M.TIER_LABELS).toEqual({ ...st.TIER_LABELS })
  })

  it('evidence vocabulary', async () => {
    const e = await load('evidence.js')
    expect([...M.EVIDENCE_STATUSES]).toEqual([...e.EVIDENCE_STATUSES])
    for (const s of M.EVIDENCE_STATUSES) expect(M.EVIDENCE_STATUS_META[s]).toEqual({ ...e.EVIDENCE_STATUS_META[s] })
    expect([...M.SOURCE_OPERATION_STATUSES]).toEqual([...e.SOURCE_OPERATION_STATUSES])
    expect([...M.SOURCE_FAILURE_REASONS]).toEqual([...e.SOURCE_FAILURE_REASONS])
    expect([...M.BLOCKED_REASONS]).toEqual([...e.BLOCKED_REASONS])
    expect(JSON.parse(JSON.stringify(M.BRIEF_SECTIONS))).toEqual(JSON.parse(JSON.stringify(e.BRIEF_SECTIONS)))
    expect(JSON.parse(JSON.stringify(M.FINDING_TYPES))).toEqual(JSON.parse(JSON.stringify(e.FINDING_TYPES)))
    expect([...M.OPPORTUNITY_CLASSES]).toEqual([...e.OPPORTUNITY_CLASSES])
    expect([...M.CONTACT_READINESS_CLASSES]).toEqual([...e.CONTACT_READINESS_CLASSES])
    expect(M.MODEL_INFERENCE_CONFIDENCE_CAP).toBe(e.MODEL_INFERENCE_CONFIDENCE_CAP)
  })

  it('S3 live additions (CHANGELOG 2026-10-09)', async () => {
    const e = await load('evidence.js')
    if (!e.EXTENDED_EVIDENCE_STATUSES) return // pre-S3 API checkout
    expect([...M.EXTENDED_EVIDENCE_STATUSES]).toEqual([...e.EXTENDED_EVIDENCE_STATUSES])
    for (const s of M.EXTENDED_EVIDENCE_STATUSES) expect(M.EXTENDED_EVIDENCE_STATUS_META[s]).toEqual({ ...e.EXTENDED_EVIDENCE_STATUS_META[s] })
    expect([...M.EVIDENCE_SOURCE_CLASSES]).toEqual([...e.EVIDENCE_SOURCE_CLASSES])
    expect(JSON.parse(JSON.stringify(M.QUICK_SCAN_FINDING_TYPES))).toEqual(JSON.parse(JSON.stringify(e.QUICK_SCAN_FINDING_TYPES)))
  })

  it('approval + cost vocabulary', async () => {
    const a = await load('approval.js')
    const c = await load('cost.js')
    expect([...M.APPROVAL_STATES]).toEqual([...a.APPROVAL_STATES])
    expect(M.PAYLOAD_HASH_PREFIX_LEN).toBe(a.PAYLOAD_HASH_PREFIX_LEN)
    expect(M.APPROVAL_REFUSAL_COPY.IDENTITY_REQUIRED).toBe(a.APPROVAL_REFUSAL_CODES.IDENTITY_REQUIRED)
    expect([...M.ESTIMATE_BASES]).toEqual([...c.ESTIMATE_BASES])
  })

  it('shared helpers behave identically', async () => {
    const e = await load('evidence.js')
    const ev = await load('events.js')
    const cases = [
      { evidence_status: 'blocked', value: 5 },
      { evidence_status: 'unavailable', value: null, is_negative_claim: true },
      { evidence_status: 'model_inference', is_inference: false, confidence: 0.9 },
      { evidence_status: 'county_confirmed', value: 1, is_negative_claim: true },
    ]
    for (const c of cases) expect(M.findingViolations(c as never)).toEqual(e.findingViolations(c))
    expect(M.renderOperationLabel('research.match_parcel', { source_name: 'X' })).toBe(ev.renderOperationLabel('research.match_parcel', { source_name: 'X' }))
  })
})
