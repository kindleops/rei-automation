import type { ReactElement, ReactNode } from 'react'
import * as HoverCardPrimitive from '@radix-ui/react-hover-card'
import { cx } from './cx'
import './lc-overlay.css'

/**
 * LCHoverCard — a lightweight preview of an object (property, seller,
 * buyer, campaign, workflow, market) on hover or keyboard focus, without
 * leaving the page. Read-only by rule: anything with buttons belongs in a
 * popover or the inspector. Content must be data the caller already has —
 * a hover card never triggers a fetch storm while the pointer sweeps a list.
 */
export interface LCHoverCardProps {
  trigger: ReactElement
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  width?: number
  openDelay?: number
  className?: string
  disabled?: boolean
}

export function LCHoverCard({ trigger, children, side = 'right', align = 'start', width, openDelay = 420, className, disabled }: LCHoverCardProps) {
  if (disabled) return trigger
  return (
    <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={120}>
      <HoverCardPrimitive.Trigger asChild>{trigger}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          className={cx('lc-hover', className)}
          side={side}
          align={align}
          sideOffset={10}
          collisionPadding={12}
          style={width ? { width } : undefined}
        >
          {children}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  )
}
