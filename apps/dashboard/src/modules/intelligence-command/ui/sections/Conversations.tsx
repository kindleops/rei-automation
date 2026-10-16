import { useEffect, useMemo, useRef } from 'react'
import { activeThread, useAsk } from '../../../agent/ask/ask-store'
import type { PageContext } from '../../model/context-model'
import { startNewConversation, useIc, type ActEntry } from '../../store/ic-store'
import { ActEntryView } from '../ActCard'
import { Composer } from '../Composer'
import { RunTurn } from '../RunTurn'
import { Kbd, Spec, ago } from '../primitives'

type Item = { kind: 'turn'; at: number; id: string } | { kind: 'act'; at: number; id: string; entry: ActEntry }

/** The execution canvas: the conversation's runs and acts in time order, the composer docked below. */
export function ConversationCanvas({ page }: { page: PageContext }) {
  const a = useAsk()
  const ic = useIc()
  const thread = activeThread(a)
  const tools = a.status.data?.tools ?? []
  const labelOf = (id: string) => a.labels[id] ?? null
  const scroller = useRef<HTMLDivElement | null>(null)
  const items = useMemo<Item[]>(() => {
    const out: Item[] = (thread?.turns ?? []).map((u) => ({ kind: 'turn', at: u.sentAt, id: u.id }))
    for (const e of ic.acts) if (e.threadId === (thread?.id ?? null)) out.push({ kind: 'act', at: e.createdAt, id: e.id, entry: e })
    return out.sort((x, y) => x.at - y.at)
  }, [thread, ic.acts])
  const lastLen = useRef(0)
  const tail = thread?.turns.at(-1)
  const streamLen = (tail?.events?.length ?? 0) + items.length
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 240
    if (near || items.length !== lastLen.current) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    lastLen.current = items.length
  }, [streamLen, items.length])

  return (
    <div className="ic-conv">
      <header className="ic-conv__h">
        <div>
          <h2>{thread?.title ?? 'New conversation'}</h2>
          <Spec items={[thread ? `${thread.turns.length} run${thread.turns.length === 1 ? '' : 's'}` : 'Nothing sent yet', thread ? `updated ${ago(thread.updatedAt)}` : null, 'runs durable by id · index kept in this tab']} />
        </div>
        <button type="button" className="ic-btn" onClick={startNewConversation}>New conversation</button>
      </header>
      <div className="ic-conv__scroll" ref={scroller}>
        <div className="ic-conv__col">
          {items.length ? items.map((it) => {
            if (it.kind === 'act') return <ActEntryView key={it.id} entry={it.entry} />
            const turn = thread!.turns.find((u) => u.id === it.id)!
            return <RunTurn key={it.id} thread={thread!} turn={turn} tools={tools} mode={ic.turnModes[turn.id] ?? 'ask'} labelOf={labelOf} />
          }) : (
            <div className="ic-start">
              <h3>What should LeadCommand investigate?</h3>
              <p>Ask researches with the read-only agent and cites every source. Plan writes a mission plan without executing it. Act prepares a platform change and waits for your approval.</p>
              <ul className="ic-start__keys">
                <li><Kbd>⌘'</Kbd> composer on any page</li>
                <li><Kbd>⌘⇧E</Kbd> this workspace</li>
                <li><Kbd>@</Kbd> property · campaign · owner · market · hot</li>
                <li><Kbd>⇧⇥</Kbd> Ask → Plan → Act</li>
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="ic-conv__dock"><div className="ic-conv__col"><Composer page={page} surface="dock" /></div></div>
    </div>
  )
}
