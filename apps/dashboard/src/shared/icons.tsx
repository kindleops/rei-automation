import type { SVGProps } from 'react'

export type IconName =
  | 'search'
  | 'bell'
  | 'settings'
  | 'radar'
  | 'spark'
  | 'pin'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-right'
  | 'arrow-up-right'
  | 'clock'
  | 'shield'
  | 'alert'
  | 'activity'
  | 'send'
  | 'calendar'
  | 'message'
  | 'target'
  | 'layers'
  | 'bolt'
  | 'close'
  | 'map'
  | 'layout-split'
  | 'list'
  | 'command'
  | 'maximize'
  | 'inbox'
  | 'stats'
  | 'users'
  | 'file-text'
  | 'phone'
  | 'mail'
  | 'paperclip'
  | 'more'
  | 'key'
  | 'user'
  | 'eye'
  | 'play'
  | 'pause'
  | 'check'
  | 'zap'
  | 'trending-up'
  | 'hash'
  | 'star'
  | 'archive'
  | 'filter'
  | 'flag'
  | 'brain'
  | 'briefing'
  | 'mic'
  | 'palette'
  | 'grid'
  | 'drag'
  | 'volume'
  | 'moon'
  | 'globe'
  | 'bookmark'
  | 'slash'
  | 'arrow-down-left'
  | 'alert-circle'
  | 'refresh-cw'
  | 'cpu'
  | 'external-link'
  | 'home'
  | 'link'
  | 'briefcase'
  | 'dollar-sign'
  | 'heart'
  | 'database'
  | 'x'
  | 'check-double'



interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName
  size?: number | string
}

const commonProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  strokeWidth: 1.7,
}

export const Icon = ({ name, size, ...rest }: IconProps) => {
  const props = size ? { width: size, height: size, ...rest } : rest;
  switch (name) {
    case 'search':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="11" cy="11" r="6" {...commonProps} />
          <path d="m16 16 4.5 4.5" {...commonProps} />
        </svg>
      )
    case 'bell':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M6 9a6 6 0 0 1 12 0v4l1.5 2.5H4.5L6 13z" {...commonProps} />
          <path d="M10 18a2 2 0 0 0 4 0" {...commonProps} />
        </svg>
      )
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="3.2" {...commonProps} />
          <path
            d="m19.5 15.3-1.1.6.1 1.3-1.6 1.6-1.3-.1-.6 1.1H9.8l-.6-1.1-1.3.1-1.6-1.6.1-1.3-1.1-.6V8.7l1.1-.6-.1-1.3 1.6-1.6 1.3.1.6-1.1h4.4l.6 1.1 1.3-.1 1.6 1.6-.1 1.3 1.1.6z"
            {...commonProps}
          />
        </svg>
      )
    case 'radar':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="8.5" {...commonProps} />
          <circle cx="12" cy="12" r="4.5" {...commonProps} />
          <path d="M12 12 18 6" {...commonProps} />
          <path d="M12 3.5v17" {...commonProps} opacity="0.45" />
          <path d="M3.5 12h17" {...commonProps} opacity="0.45" />
        </svg>
      )
    case 'spark':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M12 3 8.2 12h3.5L10 21l5.8-10H12z" {...commonProps} />
        </svg>
      )
    case 'pin':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M12 21s6-5.2 6-11a6 6 0 0 0-12 0c0 5.8 6 11 6 11Z" {...commonProps} />
          <circle cx="12" cy="10" r="2.2" {...commonProps} />
        </svg>
      )
    case 'chevron-down':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m6 9 6 6 6-6" {...commonProps} />
        </svg>
      )
    case 'chevron-up':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m18 15-6-6-6 6" {...commonProps} />
        </svg>
      )
    case 'chevron-right':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m9 6 6 6-6 6" {...commonProps} />
        </svg>
      )
    case 'arrow-up-right':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M7 17 17 7" {...commonProps} />
          <path d="M9 7h8v8" {...commonProps} />
        </svg>
      )
    case 'clock':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="8.5" {...commonProps} />
          <path d="M12 7.2v5.1l3.7 2.2" {...commonProps} />
        </svg>
      )
    case 'shield':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M12 3.5 18.5 6v5.2c0 4.4-2.8 7.6-6.5 9.3-3.7-1.7-6.5-4.9-6.5-9.3V6z" {...commonProps} />
        </svg>
      )
    case 'alert':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m12 4.5 8 14H4z" {...commonProps} />
          <path d="M12 9v4.4" {...commonProps} />
          <path d="M12 16.8h.01" {...commonProps} />
        </svg>
      )
    case 'activity':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M3 12h4l2.2-4 4.1 8 2.2-4H21" {...commonProps} />
        </svg>
      )
    case 'send':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m3 20 18-8L3 4l3.6 7.2L14 12l-7.4.8z" {...commonProps} />
        </svg>
      )
    case 'calendar':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <rect x="4" y="6" width="16" height="14" rx="2" {...commonProps} />
          <path d="M8 3.8v4M16 3.8v4M4 10.2h16" {...commonProps} />
        </svg>
      )
    case 'message':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M5 6.5h14v9H9l-4 3z" {...commonProps} />
        </svg>
      )
    case 'target':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="7.5" {...commonProps} />
          <circle cx="12" cy="12" r="3.5" {...commonProps} />
          <path d="M12 2.8v3.2M12 18v3.2M2.8 12H6M18 12h3.2" {...commonProps} />
        </svg>
      )
    case 'layers':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m12 4 8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4" {...commonProps} />
        </svg>
      )
    case 'bolt':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m13 2.8-7 10h4.6L10.8 21l7.2-10H13z" {...commonProps} />
        </svg>
      )
    case 'close':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M6 6 18 18M18 6 6 18" {...commonProps} />
        </svg>
      )
    case 'map':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M9 4 3 7v13l6-3M9 4l6 3M9 4v13M15 7l6-3v13l-6 3M15 7v13" {...commonProps} />
        </svg>
      )
    case 'layout-split':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <rect x="3" y="4" width="18" height="16" rx="2" {...commonProps} />
          <path d="M12 4v16" {...commonProps} />
        </svg>
      )
    case 'list':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...commonProps} />
        </svg>
      )
    case 'command':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M9 5H7a2 2 0 0 0 0 4h2V7a2 2 0 0 0-2-2zM9 19H7a2 2 0 0 1 0-4h2v2a2 2 0 0 1-2 2zM15 5h2a2 2 0 0 1 0 4h-2V7a2 2 0 0 1 2-2zM15 19h2a2 2 0 0 0 0-4h-2v2a2 2 0 0 0 2 2z" {...commonProps} />
          <rect x="9" y="9" width="6" height="6" {...commonProps} />
        </svg>
      )
    case 'maximize':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M4 14v6h6M20 10V4h-6M4 10V4h6M20 14v6h-6" {...commonProps} />
        </svg>
      )
    case 'inbox':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M4 4h16v16H4z" {...commonProps} />
          <path d="M4 14h4l2 2h4l2-2h4" {...commonProps} />
        </svg>
      )
    case 'stats':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M18 20V10M12 20V4M6 20v-6" {...commonProps} />
        </svg>
      )
    case 'users':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="9" cy="7" r="3" {...commonProps} />
          <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" {...commonProps} />
          <circle cx="17" cy="7" r="2.5" {...commonProps} />
          <path d="M21 21v-1.5a3 3 0 0 0-2-2.8" {...commonProps} />
        </svg>
      )
    case 'file-text':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" {...commonProps} />
          <path d="M14 3v4h4M8 13h8M8 17h5" {...commonProps} />
        </svg>
      )
    case 'phone':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M6.6 4.5 9 4l2.1 4.7-1.7 1.1a11.5 11.5 0 0 0 4.8 4.8l1.1-1.7L20 15l-.5 2.4c-.2 1-1 1.8-2 1.9-7 .2-12.8-5.6-12.6-12.6.1-1 .8-1.9 1.7-2.2Z" {...commonProps} />
        </svg>
      )
    case 'mail':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="2" {...commonProps} />
          <path d="m4.5 7 7.5 6 7.5-6" {...commonProps} />
        </svg>
      )
    case 'paperclip':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m21 11.2-8.5 8.5a5.2 5.2 0 0 1-7.4-7.4l9-9a3.5 3.5 0 0 1 5 5l-9 9a1.8 1.8 0 1 1-2.5-2.5l8.4-8.4" {...commonProps} />
        </svg>
      )
    case 'more':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="5" cy="12" r="1.4" fill="currentColor" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
          <circle cx="19" cy="12" r="1.4" fill="currentColor" />
        </svg>
      )
    case 'key':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="8" cy="15" r="4" {...commonProps} />
          <path d="m11 12 8-8M16 7l2 2M14 9l2 2" {...commonProps} />
        </svg>
      )
    case 'user':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="8" r="4" {...commonProps} />
          <path d="M4 21a8 8 0 0 1 16 0" {...commonProps} />
        </svg>
      )
    case 'eye':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" {...commonProps} />
          <circle cx="12" cy="12" r="3" {...commonProps} />
        </svg>
      )
    case 'play':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M6 4l14 8-14 8z" {...commonProps} />
        </svg>
      )
    case 'pause':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M6 4h3v16H6zM15 4h3v16h-3z" {...commonProps} />
        </svg>
      )
    case 'check':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M5 12l5 5L20 7" {...commonProps} />
        </svg>
      )
    case 'zap':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M13 2L3 14h9l-1 8 10-12h-9z" {...commonProps} />
        </svg>
      )
    case 'trending-up':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M23 6l-9.5 9.5-5-5L1 18" {...commonProps} />
          <path d="M17 6h6v6" {...commonProps} />
        </svg>
      )
    case 'hash':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" {...commonProps} />
        </svg>
      )
    case 'star':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" {...commonProps} />
        </svg>
      )
    case 'archive':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M3 5h18v4H3zM5 9v10h14V9" {...commonProps} />
          <path d="M10 13h4" {...commonProps} />
        </svg>
      )
    case 'filter':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M3 4h18l-7 8.5V18l-4 2v-7.5z" {...commonProps} />
        </svg>
      )
    case 'flag':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" {...commonProps} />
          <path d="M4 22V15" {...commonProps} />
        </svg>
      )
    case 'brain':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M12 2a5 5 0 0 0-4.5 7.2A4 4 0 0 0 5 13a4 4 0 0 0 2.5 3.7A3.5 3.5 0 0 0 11 20h2a3.5 3.5 0 0 0 3.5-3.3A4 4 0 0 0 19 13a4 4 0 0 0-2.5-3.8A5 5 0 0 0 12 2z" {...commonProps} />
          <path d="M12 2v18" {...commonProps} opacity="0.4" />
        </svg>
      )
    case 'briefing':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M4 4h16v16H4z" {...commonProps} />
          <path d="M8 8h8M8 12h6M8 16h4" {...commonProps} />
        </svg>
      )
    case 'mic':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <rect x="9" y="2" width="6" height="12" rx="3" {...commonProps} />
          <path d="M5 10a7 7 0 0 0 14 0" {...commonProps} />
          <path d="M12 17v4M8 21h8" {...commonProps} />
        </svg>
      )
    case 'palette':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="9" {...commonProps} />
          <circle cx="8" cy="10" r="1.5" fill="currentColor" />
          <circle cx="12" cy="7" r="1.5" fill="currentColor" />
          <circle cx="16" cy="10" r="1.5" fill="currentColor" />
          <circle cx="9" cy="15" r="1.5" fill="currentColor" />
        </svg>
      )
    case 'grid':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <rect x="3" y="3" width="7" height="7" rx="1" {...commonProps} />
          <rect x="14" y="3" width="7" height="7" rx="1" {...commonProps} />
          <rect x="3" y="14" width="7" height="7" rx="1" {...commonProps} />
          <rect x="14" y="14" width="7" height="7" rx="1" {...commonProps} />
        </svg>
      )
    case 'drag':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="9" cy="6" r="1.5" fill="currentColor" />
          <circle cx="15" cy="6" r="1.5" fill="currentColor" />
          <circle cx="9" cy="12" r="1.5" fill="currentColor" />
          <circle cx="15" cy="12" r="1.5" fill="currentColor" />
          <circle cx="9" cy="18" r="1.5" fill="currentColor" />
          <circle cx="15" cy="18" r="1.5" fill="currentColor" />
        </svg>
      )
    case 'volume':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M11 5L6 9H2v6h4l5 4V5z" {...commonProps} />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" {...commonProps} />
        </svg>
      )
    case 'moon':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" {...commonProps} />
        </svg>
      )
    case 'globe':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="9" {...commonProps} />
          <path d="M3.6 9h16.8M3.6 15h16.8" {...commonProps} />
          <path d="M12 3a17 17 0 0 0 0 18M12 3a17 17 0 0 1 0 18" {...commonProps} />
        </svg>
      )
    case 'bookmark':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" {...commonProps} />
        </svg>
      )
    case 'slash':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="9" {...commonProps} />
          <path d="m4.9 4.9 14.2 14.2" {...commonProps} />
        </svg>
      )
    case 'arrow-down-left':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M17 7 7 17M17 17H7V7" {...commonProps} />
        </svg>
      )
    case 'alert-circle':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="9" {...commonProps} />
          <path d="M12 8v4M12 16h.01" {...commonProps} />
        </svg>
      )
    case 'refresh-cw':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-5h5" {...commonProps} />
        </svg>
      )
    case 'cpu':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <rect x="4" y="4" width="16" height="16" rx="2" {...commonProps} />
          <path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" {...commonProps} />
        </svg>
      )
    case 'external-link':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" {...commonProps} />
        </svg>
      )
    case 'home':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...commonProps} />
          <path d="M9 22V12h6v10" {...commonProps} />
        </svg>
      )
    case 'link':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" {...commonProps} />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" {...commonProps} />
        </svg>
      )
    case 'briefcase':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <rect x="2" y="7" width="20" height="14" rx="2" {...commonProps} />
          <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" {...commonProps} />
        </svg>
      )
    case 'dollar-sign':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" {...commonProps} />
        </svg>
      )
    case 'heart':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" {...commonProps} />
        </svg>
      )
    case 'database':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <ellipse cx="12" cy="5" rx="9" ry="3" {...commonProps} />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" {...commonProps} />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" {...commonProps} />
        </svg>
      )
    case 'x':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M18 6 6 18M6 6l12 12" {...commonProps} />
        </svg>
      )
    case 'check-double':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
          <path d="M2 13l3 3 7-7" {...commonProps} />
          <path d="M12 13l3 3 7-7" {...commonProps} />
        </svg>
      )


  }
}
