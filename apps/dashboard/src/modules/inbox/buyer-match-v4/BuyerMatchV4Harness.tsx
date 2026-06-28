/**
 * Buyer Match V4 — DEV-ONLY standalone harness.
 *
 *   /dev/buyer-match-v4?propertyId=2131309217&pane=100&theme=dark
 */
import { useEffect, useMemo } from 'react'
import type { DealContext } from '../../../lib/data/dealContext'
import { BuyerMatchV4Workspace } from './BuyerMatchV4Workspace'
import type { BuyerMatchPaneWidth } from './buyer-match-v4.types'

function useQuery(): URLSearchParams {
  return new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
}

function harnessDealContext(propertyId: string, q: URLSearchParams): DealContext {
  const marketValue = q.get('marketValue') ? Number(q.get('marketValue')) : 332000
  const buyerExitBase = q.get('buyerExitBase') ? Number(q.get('buyerExitBase')) : 332000
  return {
    propertyId,
    property_id: propertyId,
    propertyAddress: q.get('address') || '4940 Broom St, Houston, TX 77091',
    propertyZip: q.get('zip') || '77091',
    propertyState: q.get('state') || 'TX',
    market: q.get('market') || 'Houston, TX',
    property_type: q.get('assetLane') || 'single_family',
    latitude: q.get('lat') ? Number(q.get('lat')) : 29.819,
    longitude: q.get('lng') ? Number(q.get('lng')) : -95.41,
    building_square_feet: 1400,
    acquisition_decision: {
      canonical_asset_lane: q.get('assetLane') || 'single_family',
      execution_state: q.get('executionState') || 'SHADOW_MODE_READY',
      strategy: q.get('strategy') || 'CASH',
      engine_version: 'acquisition_decision_engine_v3',
      value_contract: {
        qualified_market_value: { mid: marketValue },
        qualified_buyer_exit: {
          conservative: buyerExitBase * 0.96,
          base: buyerExitBase,
          optimistic: buyerExitBase * 1.04,
        },
      },
    },
  } as unknown as DealContext
}

export default function BuyerMatchV4Harness() {
  const q = useQuery()
  const propertyId = q.get('propertyId') || q.get('property_id') || '2131309217'
  const theme = q.get('theme')
  const pane = (q.get('pane') as BuyerMatchPaneWidth | null) ?? '100'
  const tab = q.get('tab')

  const dealContext = useMemo(() => harnessDealContext(propertyId, q), [propertyId, q])

  useEffect(() => {
    if (!theme) return
    const root = document.documentElement
    const prev = root.getAttribute('data-nexus-theme')
    const prevData = root.getAttribute('data-theme')
    if (theme === 'light') {
      root.setAttribute('data-nexus-theme', 'light')
      root.setAttribute('data-theme', 'light')
    } else if (theme === 'red-ops' || theme === 'red_ops') {
      root.setAttribute('data-nexus-theme', 'red_ops')
      root.setAttribute('data-theme', 'red-ops')
    } else {
      root.setAttribute('data-nexus-theme', 'dark')
      root.removeAttribute('data-theme')
    }
    return () => {
      if (prev) root.setAttribute('data-nexus-theme', prev)
      else root.removeAttribute('data-nexus-theme')
      if (prevData) root.setAttribute('data-theme', prevData)
      else root.removeAttribute('data-theme')
    }
  }, [theme])

  useEffect(() => {
    if (!tab) return
    const el = document.querySelector(`[data-bmv4-tab="${tab.toUpperCase()}"]`) as HTMLButtonElement | null
    el?.click()
  }, [tab, pane, propertyId])

  const sim = q.get('sim')
  const workspace = (
    <BuyerMatchV4Workspace dealContext={dealContext} paneWidth={pane} paused={false} />
  )

  if (sim) {
    const w = Number(sim) || 50
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', background: '#05070b' }}>
        <section className="nx-workspace-surface nx-workspace-surface--map is-buyer-match-v4" style={{ width: `${w}%`, height: '100%' }}>
          {workspace}
        </section>
        {w < 100 && <div style={{ flex: 1, background: '#0a0e16' }} />}
      </div>
    )
  }

  return (
    <div className="bmv4-harness" style={{ position: 'fixed', inset: 0 }}>
      {workspace}
    </div>
  )
}