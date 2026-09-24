import { describe, expect, it } from 'vitest'
import { confirmSpecFor } from './CampaignConfirmSheet'
import type { CampaignSummary } from '../campaigns.types'

const campaign = (over: Partial<CampaignSummary> = {}) =>
  ({ id: 'c1', campaign_name: 'Miami', status: 'paused', ready_targets: 789, total_targets: 802, send_interval_seconds: 60, ...over }) as CampaignSummary

describe('confirmSpecFor', () => {
  it('asks before anything that changes what gets sent, with the scope in numbers', () => {
    const resume = confirmSpecFor('resume', campaign())!
    expect(resume.tone).toBe('go')
    expect(resume.facts).toContainEqual({ label: 'Ready to send', value: '789' })
    expect(resume.facts).toContainEqual({ label: 'Pace', value: '60 an hour' })
    expect(confirmSpecFor('convert_to_live', campaign())!.confirmLabel).toBe('Go live')
    expect(confirmSpecFor('queue_batch_live', campaign())).not.toBeNull()
  })

  it('asks before queue writes too, and says nothing is sent', () => {
    const spec = confirmSpecFor('queue_batch', campaign())!
    expect(spec.body).toMatch(/Nothing is sent/)
    expect(spec.tone).toBe('neutral')
  })

  it('confirms a direct rebuild, but not a draft build that opens the guided builder', () => {
    expect(confirmSpecFor('build_targets', campaign({ status: 'draft' }))).toBeNull()
    const rebuild = confirmSpecFor('build_targets', campaign({ status: 'paused' }))!
    expect(rebuild.title).toBe('Rebuild the audience?')
    expect(rebuild.facts).toContainEqual({ label: 'Current audience', value: '802' })
  })

  it('marks destructive actions as danger', () => {
    expect(confirmSpecFor('archive', campaign())!.tone).toBe('danger')
    expect(confirmSpecFor('unschedule', campaign())!.tone).toBe('danger')
  })

  it('runs harmless or self-guided actions directly', () => {
    for (const action of ['refresh', 'sync_metrics', 'edit', 'schedule', 'activate', 'duplicate', 'restore']) {
      expect(confirmSpecFor(action, campaign()), action).toBeNull()
    }
  })
})
