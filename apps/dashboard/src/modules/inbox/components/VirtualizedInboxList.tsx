import { memo, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { List, useListRef, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import { markListScrollOffset } from '../../../domain/inbox/inbox-proof-bridge'

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
  const listRef = useListRef()
  const lastOffsetRef = useRef(initialScrollOffset)

  useEffect(() => {
    if (!containerNode || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const nextHeight = Math.max(240, Math.floor(entries[0]?.contentRect.height ?? 0))
      setListHeight((current) => (current === nextHeight ? current : nextHeight))
    })
    observer.observe(containerNode)
    setListHeight(Math.max(240, Math.floor(containerNode.clientHeight || 480)))
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
      <List<InboxListRowProps<T>>
        listRef={listRef}
        style={{ height: listHeight, width: '100%' }}
        rowCount={items.length}
        rowHeight={rowHeight}
        overscanCount={overscanCount}
        rowComponent={InboxListRow}
        rowProps={{ items, renderRow }}
        onRowsRendered={({ startIndex }) => {
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