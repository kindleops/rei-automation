import { describe, expect, it } from 'vitest'
import {
  APPROVED_TEXTGRID_CLUSTERS,
  normalizeState,
  resolveApprovedClusterForState,
  uncoveredUsStates,
  US_STATE_CODES,
} from '../../src/lib/data/textgridRouting'

describe('textgrid routing nationwide coverage', () => {
  it('covers every US state and DC in approved clusters', () => {
    expect(uncoveredUsStates()).toEqual([])
    expect(new Set(APPROVED_TEXTGRID_CLUSTERS.flatMap((cluster) => cluster.allowed_seller_states)).size)
      .toBe(US_STATE_CODES.length)
  })

  it.each(US_STATE_CODES)('maps %s to an approved sender cluster', (state) => {
    const cluster = resolveApprovedClusterForState(state)
    expect(cluster, `missing cluster for ${state}`).not.toBeNull()
    expect(cluster?.allowed_seller_states).toContain(state)
  })

  it('normalizes full state names and abbreviations', () => {
    expect(normalizeState('Tennessee')).toBe('tn')
    expect(normalizeState('NEW YORK')).toBe('ny')
    expect(normalizeState('District of Columbia')).toBe('dc')
    expect(normalizeState('North Carolina')).toBe('nc')
  })

  it('routes representative markets from each region', () => {
    expect(resolveApprovedClusterForState('NY')?.cluster_key).toBe('NORTHEAST')
    expect(resolveApprovedClusterForState('WA')?.cluster_key).toBe('WEST_COAST')
    expect(resolveApprovedClusterForState('TX')?.cluster_key).toBe('TEXAS_OK')
    expect(resolveApprovedClusterForState('OH')?.cluster_key).toBe('MIDWEST')
    expect(resolveApprovedClusterForState('SC')?.cluster_key).toBe('SOUTHEAST_EAST')
  })
})