import { describe, expect, it } from 'vitest'

type ViewWidthPercent = '25' | '50' | '75' | '100'
type InboxWorkspaceView = 'thread' | 'sms_thread' | 'deal_intelligence'

const DEFAULT_WORKSPACE_WIDTHS: Partial<Record<InboxWorkspaceView, ViewWidthPercent>> = {
  thread: '25',
  sms_thread: '50',
  deal_intelligence: '25',
}

const stripDefaultDealDeskWidthOverrides = (
  overrides: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> =>
  Object.fromEntries(
    Object.entries(overrides).filter(([view, value]) => {
      const workspaceView = view as InboxWorkspaceView
      return DEFAULT_WORKSPACE_WIDTHS[workspaceView] !== value
    }),
  ) as Partial<Record<InboxWorkspaceView, ViewWidthPercent>>

describe('stripDefaultDealDeskWidthOverrides', () => {
  it('removes default widths so flex math stays at 100%', () => {
    expect(
      stripDefaultDealDeskWidthOverrides({
        thread: '25',
        sms_thread: '50',
        deal_intelligence: '25',
      }),
    ).toEqual({})
  })

  it('keeps only the changed pane when one default deviates', () => {
    expect(
      stripDefaultDealDeskWidthOverrides({
        thread: '25',
        sms_thread: '50',
        deal_intelligence: '50',
      }),
    ).toEqual({ deal_intelligence: '50' })
  })
})