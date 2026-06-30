import type { CSSProperties } from 'react'
import type { SellerMapCardMode } from './seller-map-card.types'

/** Conversation flip keeps the same shell footprint as focus — only the face changes. */
export const getSellerMapCardLayoutMode = (mode: SellerMapCardMode): SellerMapCardMode => (
  mode === 'conversation' ? 'focus' : mode
)

export const getSellerCardDimensions = (
  mode: SellerMapCardMode,
  isMobile: boolean,
): { width: number; maxHeight: number; imageHeight: number } => {
  const layoutMode = getSellerMapCardLayoutMode(mode)
  if (isMobile) {
    if (layoutMode === 'peek') {
      return { width: 0, maxHeight: Math.round(window.innerHeight * 0.4), imageHeight: 108 }
    }
    return { width: 0, maxHeight: Math.round(window.innerHeight * 0.75), imageHeight: 124 }
  }
  if (layoutMode === 'peek') return { width: 384, maxHeight: 455, imageHeight: 112 }
  return {
    width: 448,
    maxHeight: Math.min(Math.round(window.innerHeight * 0.76), 650),
    imageHeight: 128,
  }
}

export const getSellerMapCardStyle = (
  mode: SellerMapCardMode,
  anchor: { x: number; y: number } | null,
  containerSize: { width: number; height: number },
  isMobile: boolean,
  gap = 18,
  navOffset = 88,
  bottomOffset = 36,
): CSSProperties => {
  const dims = getSellerCardDimensions(mode, isMobile)

  if (isMobile) {
    return {
      position: 'relative',
      width: '100%',
      height: '100%',
      maxHeight: 'none',
    }
  }

  if (!anchor) {
    return {
      position: 'absolute',
      left: 16,
      top: navOffset,
      width: dims.width,
      height: dims.maxHeight,
      maxHeight: dims.maxHeight,
    }
  }

  const { x, y } = anchor
  const { width: cw, height: ch } = containerSize
  const LEFT_MARGIN = 16
  const RIGHT_MARGIN = 16
  let left = x + gap
  let top = y - Math.floor(dims.maxHeight / 2)

  if (left + dims.width > cw - RIGHT_MARGIN) left = x - dims.width - gap
  if (left < LEFT_MARGIN) left = LEFT_MARGIN
  if (top < navOffset) top = navOffset
  const maxTop = ch - dims.maxHeight - bottomOffset
  if (top > maxTop) top = Math.max(navOffset, maxTop)

  const availHeight = ch - top - bottomOffset
  const finalHeight = Math.min(dims.maxHeight, Math.max(240, availHeight))

  return {
    position: 'absolute',
    left,
    top,
    width: Math.min(dims.width, cw - LEFT_MARGIN - RIGHT_MARGIN),
    height: finalHeight,
    maxHeight: finalHeight,
  }
}