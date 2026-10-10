import { describe, expect, it } from 'vitest'
import { campaignEntityGraphPath, openCampaignInEntityGraph } from './campaign-entity-graph'

const ID = '9799d345-06c7-46d8-9b4d-db8b8a4e2bdc'

describe('Campaign Command → Entity Graph door', () => {
  it('opens the desk on the campaign scope chip, Overview first', () => {
    const path = campaignEntityGraphPath(ID)!
    const url = new URL(path, 'http://x')
    expect(url.pathname).toBe('/entity-graph')
    expect(url.searchParams.get('egv')).toBe('overview')
    expect(JSON.parse(url.searchParams.get('ff')!)).toEqual([{ field_key: 'campaign.membership', operator: 'is_any_of', value: [ID] }])
  })
  it('refuses a campaign without an id (never the universe)', () => {
    const seen: string[] = []
    expect(campaignEntityGraphPath('')).toBeNull()
    expect(openCampaignInEntityGraph(undefined, (p) => seen.push(p))).toBe(false)
    expect(seen).toEqual([])
    expect(openCampaignInEntityGraph(ID, (p) => seen.push(p))).toBe(true)
    expect(seen).toHaveLength(1)
  })
})
