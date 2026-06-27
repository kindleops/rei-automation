import { memo, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { FixedSizeList, type ListOnScrollProps } from 'react-window'

interface VirtualizedInboxListProps<T> {
  items: T[]
  rowHeight: number
  className?: string
  overscanCount?: number
  initialScrollOffset?: number
  onScrollOffsetChange?: (offset: number) => void
  renderRow: (item: T, index: number, style: CSSProperties) => ReactNode
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

  const handleScroll = useCallback((props: ListOnScrollProps) => {
    onScrollOffsetChange?.(props.scrollOffset)
  }, [onScrollOffsetChange])

  const Row = useCallback(({ index, style }: { index: number; style: CSSProperties }) => (
    <div style={style}>{renderRow(items[index], index, style)}</div>
  ), [items, renderRow])

  if (items.length === 0) return null

  return (
    <div ref={setContainerNode} className={className} style={{ flex: 1, minHeight: 0, height: '100%' }}>
      <FixedSizeList
        height={listHeight}
        width="100%"
        itemCount={items.length}
        itemSize={rowHeight}
        overscanCount={overscanCount}
        initialScrollOffset={initialScrollOffset}
        onScroll={handleScroll}
      >
        {Row}
      </FixedSizeList>
    </div>
  )
}

export const VirtualizedInboxList = memo(VirtualizedInboxListInner) as typeof VirtualizedInboxListInner