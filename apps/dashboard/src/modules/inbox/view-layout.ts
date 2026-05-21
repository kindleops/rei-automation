export type ViewWidthPercent = '25' | '50' | '75' | '100'

export type ViewLayoutMode = 'compact' | 'medium' | 'expanded' | 'full'

export const getViewLayoutMode = (widthPercent: ViewWidthPercent): ViewLayoutMode => {
  if (widthPercent === '25') return 'compact'
  if (widthPercent === '50') return 'medium'
  if (widthPercent === '75') return 'expanded'
  return 'full'
}

export const isCompactLayout = (layoutMode: ViewLayoutMode): boolean => layoutMode === 'compact'

export const isMediumLayout = (layoutMode: ViewLayoutMode): boolean => layoutMode === 'medium'

export const isExpandedLayout = (layoutMode: ViewLayoutMode): boolean =>
  layoutMode === 'expanded' || layoutMode === 'full'
