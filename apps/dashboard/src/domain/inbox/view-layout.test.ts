import { describe, expect, it } from 'vitest'
import {
  deriveWidthPercentFromFlex,
  getViewLayoutMode,
  resolveLayoutModeForPane,
  resolveWorkspaceFlexBases,
  resolveWorkspaceWidthLabels,
} from './view-layout'

const DEAL_DESK_VIEWS = ['thread', 'sms_thread', 'deal_intelligence'] as const
const DEFAULT_WIDTHS = { thread: '25', sms_thread: '50', deal_intelligence: '25' } as const

const isDefaultDealDesk = (views: readonly string[]) =>
  views.length === 3 && DEAL_DESK_VIEWS.every((view) => views.includes(view))

describe('resolveWorkspaceFlexBases', () => {
  it('uses default 25/50/25 when deal desk has no overrides', () => {
    const flex = resolveWorkspaceFlexBases([...DEAL_DESK_VIEWS], {}, {
      isDefaultSet: isDefaultDealDesk,
      defaultWidths: { ...DEFAULT_WIDTHS },
    })
    expect(flex).toEqual({ thread: 25, sms_thread: 50, deal_intelligence: 25 })
  })

  it('redistributes remainder when one pane is pinned to 75%', () => {
    const flex = resolveWorkspaceFlexBases([...DEAL_DESK_VIEWS], { sms_thread: '75' })
    expect(flex.sms_thread).toBe(75)
    expect(flex.thread).toBe(12.5)
    expect(flex.deal_intelligence).toBe(12.5)
  })

  it('does not scale when only one non-default override is present', () => {
    const flex = resolveWorkspaceFlexBases([...DEAL_DESK_VIEWS], { deal_intelligence: '50' })
    expect(flex).toEqual({ deal_intelligence: 50, thread: 25, sms_thread: 25 })
  })

  it('collapses to a single full-width pane', () => {
    const flex = resolveWorkspaceFlexBases(['sms_thread'], {})
    expect(flex).toEqual({ sms_thread: 100 })
  })
})

describe('resolveWorkspaceWidthLabels', () => {
  it('preserves explicit overrides and derives labels for remainder panes', () => {
    const overrides = { sms_thread: '75' }
    const flex = resolveWorkspaceFlexBases([...DEAL_DESK_VIEWS], overrides)
    const labels = resolveWorkspaceWidthLabels([...DEAL_DESK_VIEWS], overrides, flex)
    expect(labels.sms_thread).toBe('75')
    expect(labels.thread).toBe('25')
    expect(labels.deal_intelligence).toBe('25')
  })
})

describe('layout mode helpers', () => {
  it('maps width percent to layout mode', () => {
    expect(getViewLayoutMode('25')).toBe('compact')
    expect(getViewLayoutMode('50')).toBe('medium')
    expect(getViewLayoutMode('75')).toBe('expanded')
    expect(getViewLayoutMode('100')).toBe('full')
  })

  it('prefers explicit override over derived flex for layout mode', () => {
    expect(resolveLayoutModeForPane(12.5, '75')).toBe('expanded')
    expect(resolveLayoutModeForPane(12.5)).toBe('compact')
    expect(deriveWidthPercentFromFlex(12.5)).toBe('25')
  })
})