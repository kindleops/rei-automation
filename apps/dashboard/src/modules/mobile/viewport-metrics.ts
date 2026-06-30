export type ViewportMetrics = {
  layoutWidth: number
  layoutHeight: number
  effectiveWidth: number
  effectiveHeight: number
  isPortrait: boolean
}

/** Correct Safari "Request Desktop Website" layout viewport inflation on phones. */
const PHONE_MAX = 767
const PHONE_LONG_EDGE_MAX = 1024

export function resolveViewportMetrics(input: {
  innerWidth: number
  innerHeight: number
  screenWidth?: number
  screenHeight?: number
  visualViewportWidth?: number
  visualViewportHeight?: number
  orientationPortrait?: boolean
}): ViewportMetrics {
  const layoutWidth = Math.round(input.visualViewportWidth ?? input.innerWidth)
  const layoutHeight = Math.round(input.visualViewportHeight ?? input.innerHeight)
  const screenWidth = Math.round(input.screenWidth ?? layoutWidth)
  const screenHeight = Math.round(input.screenHeight ?? layoutHeight)
  const shortEdge = Math.min(screenWidth, screenHeight)
  const longEdge = Math.max(screenWidth, screenHeight)
  const screenPortrait = screenHeight >= screenWidth

  // Safari "Request Desktop Website" inflates layout width (e.g. 980) while the
  // device screen stays phone-sized. Layout-based orientation then reads landscape.
  const inflatedDesktopViewport =
    layoutWidth > PHONE_MAX
    && layoutWidth > longEdge
    && shortEdge <= PHONE_MAX
    && longEdge <= PHONE_LONG_EDGE_MAX
    && screenPortrait

  const isPortrait = inflatedDesktopViewport
    ? screenPortrait
    : (input.orientationPortrait ?? layoutHeight >= layoutWidth)

  const effectiveWidth = inflatedDesktopViewport ? shortEdge : layoutWidth
  const effectiveHeight = inflatedDesktopViewport ? longEdge : layoutHeight

  return {
    layoutWidth,
    layoutHeight,
    effectiveWidth,
    effectiveHeight,
    isPortrait,
  }
}