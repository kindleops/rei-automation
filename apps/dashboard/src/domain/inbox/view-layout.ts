export type ViewWidthPercent = '25' | '50' | '75' | '100'

export type ViewLayoutMode = 'compact' | 'medium' | 'expanded' | 'full'

export type WorkspaceFlexBasis = number

export const getViewLayoutMode = (widthPercent: ViewWidthPercent): ViewLayoutMode => {
  if (widthPercent === '25') return 'compact'
  if (widthPercent === '50') return 'medium'
  if (widthPercent === '75') return 'expanded'
  return 'full'
}

export const deriveWidthPercentFromFlex = (flexBasis: number): ViewWidthPercent => {
  if (flexBasis <= 30) return '25'
  if (flexBasis <= 55) return '50'
  if (flexBasis <= 85) return '75'
  return '100'
}

export const resolveLayoutModeForPane = (
  flexBasis: number,
  widthOverride?: ViewWidthPercent,
): ViewLayoutMode => getViewLayoutMode(widthOverride ?? deriveWidthPercentFromFlex(flexBasis))

export const resolveWorkspaceFlexBases = <T extends string>(
  views: T[],
  overrides: Partial<Record<T, ViewWidthPercent>>,
  options?: {
    isDefaultSet?: (views: T[]) => boolean
    defaultWidths?: Partial<Record<T, ViewWidthPercent>>
  },
): Partial<Record<T, WorkspaceFlexBasis>> => {
  if (views.length === 0) return {}
  if (views.length === 1) return { [views[0]]: 100 }

  const explicit = views
    .map((view) => [view, overrides[view]] as const)
    .filter((entry): entry is [T, ViewWidthPercent] => Boolean(entry[1]))

  if (explicit.length === 1) {
    const [pinnedView, pinnedWidth] = explicit[0]
    const pinnedNum = Number(pinnedWidth)
    const others = views.filter((view) => view !== pinnedView)
    const remainder = Math.max(0, 100 - pinnedNum)
    const each = others.length > 0 ? remainder / others.length : 0
    const result: Partial<Record<T, WorkspaceFlexBasis>> = { [pinnedView]: pinnedNum }
    others.forEach((view, index) => {
      result[view] = index === others.length - 1
        ? Math.round((remainder - each * (others.length - 1)) * 100) / 100
        : Math.round(each * 100) / 100
    })
    return result
  }

  if (explicit.length > 1 && explicit.length < views.length) {
    const [pinnedView, pinnedWidth] = explicit[explicit.length - 1]
    const pinnedNum = Number(pinnedWidth)
    const others = views.filter((view) => view !== pinnedView)
    const remainder = Math.max(0, 100 - pinnedNum)
    const each = others.length > 0 ? remainder / others.length : 0
    const result: Partial<Record<T, WorkspaceFlexBasis>> = { [pinnedView]: pinnedNum }
    others.forEach((view, index) => {
      result[view] = index === others.length - 1
        ? Math.round((remainder - each * (others.length - 1)) * 100) / 100
        : Math.round(each * 100) / 100
    })
    return result
  }

  if (explicit.length === views.length) {
    const nums = views.map((view) => Number(overrides[view]))
    const sum = nums.reduce((total, value) => total + value, 0)
    if (sum > 0 && sum !== 100) {
      const scale = 100 / sum
      const scaled = nums.map((value) => Math.round(value * scale * 100) / 100)
      const drift = 100 - scaled.reduce((total, value) => total + value, 0)
      if (scaled.length > 0) scaled[scaled.length - 1] = Math.round((scaled[scaled.length - 1] + drift) * 100) / 100
      return Object.fromEntries(views.map((view, index) => [view, scaled[index]])) as Partial<Record<T, WorkspaceFlexBasis>>
    }
    if (sum === 100) {
      return Object.fromEntries(views.map((view) => [view, Number(overrides[view])])) as Partial<Record<T, WorkspaceFlexBasis>>
    }
  }

  if (views.length === 3 && options?.isDefaultSet?.(views) && options.defaultWidths) {
    const defaults = options.defaultWidths
    return {
      [views[0]]: Number(defaults[views[0]] ?? 25),
      [views[1]]: Number(defaults[views[1]] ?? 50),
      [views[2]]: Number(defaults[views[2]] ?? 25),
    } as Partial<Record<T, WorkspaceFlexBasis>>
  }

  if (views.length === 2) {
    const firstOverride = overrides[views[0]]
    const secondOverride = overrides[views[1]]
    if (firstOverride && secondOverride && Number(firstOverride) + Number(secondOverride) === 100) {
      return {
        [views[0]]: Number(firstOverride),
        [views[1]]: Number(secondOverride),
      }
    }
    if (firstOverride === '75') return { [views[0]]: 75, [views[1]]: 25 }
    if (firstOverride === '25') return { [views[0]]: 25, [views[1]]: 75 }
    if (firstOverride === '50') return { [views[0]]: 50, [views[1]]: 50 }
    if (secondOverride === '75') return { [views[0]]: 25, [views[1]]: 75 }
    if (secondOverride === '25') return { [views[0]]: 75, [views[1]]: 25 }
    if (secondOverride === '50') return { [views[0]]: 50, [views[1]]: 50 }
    return { [views[0]]: 50, [views[1]]: 50 }
  }

  const each = 100 / views.length
  return Object.fromEntries(
    views.map((view, index) => [
      view,
      index === views.length - 1
        ? Math.round((100 - each * (views.length - 1)) * 100) / 100
        : Math.round(each * 100) / 100,
    ]),
  ) as Partial<Record<T, WorkspaceFlexBasis>>
}

export const resolveWorkspaceWidthLabels = <T extends string>(
  views: T[],
  overrides: Partial<Record<T, ViewWidthPercent>>,
  flexBases: Partial<Record<T, WorkspaceFlexBasis>>,
): Partial<Record<T, ViewWidthPercent>> => {
  if (views.length === 1) return { [views[0]]: '100' }
  return Object.fromEntries(
    views.map((view) => [
      view,
      overrides[view] ?? deriveWidthPercentFromFlex(flexBases[view] ?? 25),
    ]),
  ) as Partial<Record<T, ViewWidthPercent>>
}

export const isCompactLayout = (layoutMode: ViewLayoutMode): boolean => layoutMode === 'compact'

export const isMediumLayout = (layoutMode: ViewLayoutMode): boolean => layoutMode === 'medium'

export const isExpandedLayout = (layoutMode: ViewLayoutMode): boolean =>
  layoutMode === 'expanded' || layoutMode === 'full'