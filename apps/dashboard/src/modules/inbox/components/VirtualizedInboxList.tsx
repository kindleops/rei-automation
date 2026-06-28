import { memo, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { List, type RowComponentProps } from 'react-window'

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
  renderRow,
}: VirtualizedInboxListProps<T>) {
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null)
  const [listHeight, setListHeight] = useState(480)

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

  if (items.length === 0) return null

  return (
    <div ref={setContainerNode} className={className} style={{ flex: 1, minHeight: 0, height: '100%' }}>
      <List<InboxListRowProps<T>>
        style={{ height: listHeight, width: '100%' }}
        rowCount={items.length}
        rowHeight={rowHeight}
        overscanCount={overscanCount}
        rowComponent={InboxListRow}
        rowProps={{ items, renderRow }}
      />
    </div>
  )
}

export const VirtualizedInboxList = memo(VirtualizedInboxListInner) as typeof VirtualizedInboxListInner