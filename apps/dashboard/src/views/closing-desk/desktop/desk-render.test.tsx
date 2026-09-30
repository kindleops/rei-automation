import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import demo from '../mobile/closing-demo.generated.json'
import type { ActivityItem, Closing, Room } from '../mobile/closing-execution-api'
import { DeskRoom } from './DeskRoom'
import { DeskInspector, type Subject } from './DeskInspector'
import { SECTIONS } from './desk-model'

/**
 * Server-free render smoke test: every section of every demo closing and the
 * inspector's subjects render without throwing, and the words that carry the
 * truth rules are on the page. (The browser captures verify the look.)
 */
const file = demo as unknown as { now: string; portfolio: { items: Closing[] }; activity: Record<string, ActivityItem[]> }
const NOW = Date.parse(file.now)
const roomOf = (c: Closing): Room => ({ closing: c, activity: file.activity[c.id] ?? [], activityMore: false, degraded: [] })
const byLine = (line: string) => file.portfolio.items.find((c) => c.property.line === line)!
const noop = () => {}
void React

function renderRoom(c: Closing, section: (typeof SECTIONS)[number] = 'overview') {
  return renderToStaticMarkup(
    <DeskRoom c={c} room={roomOf(c)} demo now={NOW} section={section} onSection={noop} highlight={null} inspectKey={null} onInspect={noop} files={[]} filesState="ready" onLoadFiles={noop} onMoreActivity={noop} loadingMore={false} />,
  )
}

describe('closing desk desktop — every room, every section renders', () => {
  for (const c of file.portfolio.items) {
    it(`${c.property.line} (${c.state.key})`, () => {
      for (const s of SECTIONS) expect(() => renderRoom(c, s)).not.toThrow()
    })
  }

  it('the rooms say what the model says', () => {
    const ready = renderRoom(byLine('1204 Penn Ave N'))
    expect(ready).toContain('READY TO CLOSE')
    expect(ready).toContain('7/7')
    expect(ready).toContain('Closing today')
    const sys = renderRoom(byLine('2718 Emerson Ave S'))
    expect(sys).toContain('System handling')
    expect(sys).toContain('Title commitment follow-up #2')
    expect(sys).toContain('Why: commitment not yet received')
    const settled = renderRoom(byLine('5021 34th Ave S'))
    expect(settled).toContain('Actual net')
    expect(settled).toContain('$17,480')
    expect(settled).toContain('$18,000')
    expect(settled).not.toContain('Who has the ball')
    const bare = renderRoom(byLine('4127 Upton Ave S'))
    expect(bare).toContain('Closed · settlement record unavailable')
    const cancelled = renderRoom(byLine('1719 E 38th St'))
    expect(cancelled).toContain('Cancelled at')
    expect(cancelled).toContain('Ryan K. (operator)')
    const passed = renderRoom(byLine('2600 Lyndale Ave N'))
    expect(passed).toContain('Closing date passed — not closed')
    const issue = renderRoom(byLine('1532 Fremont Ave N'))
    expect(issue).toContain('Unreleased mortgage: automation paused, needs operator direction')
  })

  it('the inspector renders each kind of subject', () => {
    const c = byLine('3847 Bloomington Ave')
    const item = c.items!.find((i) => i.key === 'emd_overdue')!
    const loop = c.automation!.loops!.find((l) => l.key === 'buyer_emd')!
    const subjects: Subject[] = [
      { kind: 'item', item },
      { kind: 'requirement', key: 'emd' },
      { kind: 'document', doc: c.documents.find((d) => d.status === 'missing')! },
      { kind: 'deadline', deadline: c.deadlines[0] },
      { kind: 'loop', loop },
      { kind: 'money' },
    ]
    for (const subject of subjects) {
      const html = renderToStaticMarkup(<DeskInspector c={c} subject={subject} demo now={NOW} collapsed={false} onClose={noop} onCollapse={noop} onExpand={noop} onSubject={noop} onDone={noop} />)
      expect(html).toContain('cdx-insp')
    }
    const collapsed = renderToStaticMarkup(<DeskInspector c={c} subject={{ kind: 'item', item }} demo now={NOW} collapsed onClose={noop} onCollapse={noop} onExpand={noop} onSubject={noop} onDone={noop} />)
    expect(collapsed).toContain('cdx-insp-tab')
  })
})
