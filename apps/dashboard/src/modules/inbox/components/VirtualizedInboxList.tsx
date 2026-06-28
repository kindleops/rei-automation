import { memo, useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'

const WindowedList = List as ComponentType<Record<string, unknown>>
import { markFirstRowsPainted, markListScrollOffset } from '../../../domain/inbox/inbox-proof-bridge'

interface VirtualizedInboxListProps<T> {
  items: T[]
  rowHeight: number
  className?: string
  overscanCount?: number
  initialScrollOffset?: number
  onScrollOffsetChange?: (offset: number) => void
  renderRow: (item: T, index: number, style: CSSProperties) => ReactNode
}

type InboxListRowProps<T> = {
  items: T[]
  renderRow: (item: T, index: number, style: CSSProperties) => ReactNode
}

function InboxListRow<T>({
  index,
  style,
  items,
  renderRow,
}: RowComponentProps<InboxListRowProps<T>>): ReactElement | null {
  const item = items[index]
  useEffect(() => {
    if (index === 0) markFirstRowsPainted()
  }, [index])
  if (!item) return null
  return <div style={style}>{renderRow(item, index, style)}</div>
}

function VirtualizedInboxListInner<T>({
  items,
  rowHeight,
  className,
  overscanCount = 6,
  initialScrollOffset = 0,
  onScrollOffsetChange,
  renderRow,
}: VirtualizedInboxListProps<T>) {
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null)
  const [listHeight, setListHeight] = useState(480)
  const listRef = useRef<ListImperativeAPI | null>(null)
  const lastOffsetRef = useRef(initialScrollOffset)

  useEffect(() => {
    if (!containerNode || typeof ResizeObserver === 'undefined') return

    const resolveHeight = () => {
      const self = Math.floor(containerNode.getBoundingClientRect().height)
      const parent = Math.floor(containerNode.parentElement?.getBoundingClientRect().height ?? 0)
      const scrollHost = containerNode.closest('.nx-sidebar-rebuilt__threads-scroll')
      const host = Math.floor(scrollHost?.getBoundingClientRect().height ?? 0)
      return Math.max(240, self, parent, host)
    }

    const applyHeight = () => {
      const nextHeight = resolveHeight()
      setListHeight((current) => (current === nextHeight ? current : nextHeight))
    }

    const observer = new ResizeObserver(() => applyHeight())
    observer.observe(containerNode)
    if (containerNode.parentElement) observer.observe(containerNode.parentElement)
    const scrollHost = containerNode.closest('.nx-sidebar-rebuilt__threads-scroll')
    if (scrollHost) observer.observe(scrollHost)

    applyHeight()
    return () => observer.disconnect()
  }, [containerNode])

  useEffect(() => {
    const api = listRef.current as ListImperativeAPI | null
    if (!api || initialScrollOffset <= 0) return
    api.scrollToRow({ index: Math.floor(initialScrollOffset / rowHeight), align: 'start', behavior: 'instant' })
    lastOffsetRef.current = initialScrollOffset
    onScrollOffsetChange?.(initialScrollOffset)
    markListScrollOffset(initialScrollOffset)
  }, [initialScrollOffset, listRef, onScrollOffsetChange, rowHeight])

  if (items.length === 0) return null

  return (
    <div ref={setContainerNode} className={className} style={{ flex: 1, minHeight: 0, height: '100%' }}>
      <WindowedList
        listRef={listRef}
        style={{ height: listHeight, width: '100%' }}
        rowCount={items.length}
        rowHeight={rowHeight}
        overscanCount={overscanCount}
        rowComponent={InboxListRow}
        rowProps={{ items, renderRow }}
        onRowsRendered={({ startIndex }: { startIndex: number }) => {
          const offset = startIndex * rowHeight
          if (offset === lastOffsetRef.current) return
          lastOffsetRef.current = offset
          onScrollOffsetChange?.(offset)
          markListScrollOffset(offset)
        }}
      />
    </div>
  )
}

export const VirtualizedInboxList = memo(VirtualizedInboxListInner) as typeof VirtualizedInboxListInner