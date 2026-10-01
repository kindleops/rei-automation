import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cx } from './cx'
import './lc-overlay.css'

/**
 * LCPopover — a small anchored surface for contextual choices.
 *
 * It grows out of its trigger: Radix measures the trigger and reports the
 * side and transform origin, and the surface starts a few pixels toward the
 * trigger and settles (Arc's free Popover recipe, MIT). Collision handling,
 * outside-click, Esc and focus return are Radix's. Popovers hold small
 * choices — never a giant form; that is what the inspector is for.
 */

export type LCMaterial = 'smoke' | 'crystal' | 'frosted' | 'solid'

export function LCPopoverRoot(props: ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root {...props} />
}
export const LCPopoverTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>>(function LCPopoverTrigger(props, ref) {
  return <PopoverPrimitive.Trigger ref={ref} {...props} />
})
export const LCPopoverAnchor = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>>(function LCPopoverAnchor(props, ref) {
  return <PopoverPrimitive.Anchor ref={ref} {...props} />
})
export const LCPopoverClose = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof PopoverPrimitive.Close>>(function LCPopoverClose(props, ref) {
  return <PopoverPrimitive.Close ref={ref} {...props} />
})

export interface LCPopoverContentProps extends ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  material?: LCMaterial
  width?: number | string
  /** keep the surface inside a portal (default) — false renders in place */
  portal?: boolean
}

export const LCPopoverContent = forwardRef<HTMLDivElement, LCPopoverContentProps>(function LCPopoverContent(
  { className, material = 'smoke', width, portal = true, align = 'start', sideOffset = 8, collisionPadding = 12, style, ...props },
  ref,
) {
  const content = (
    <PopoverPrimitive.Content
      {...props}
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cx('lc-pop', `is-${material}`, className)}
      style={{ ...(width !== undefined ? { width } : null), ...style } as CSSProperties}
    />
  )
  return portal ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content
})

export interface LCPopoverProps {
  trigger: ReactElement
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  material?: LCMaterial
  width?: number | string
  /** accessible name for the surface */
  label?: string
  className?: string
  /** keep focus on the trigger (e.g. for hover-revealed help) */
  noAutoFocus?: boolean
}

export function LCPopover({ trigger, children, open, onOpenChange, side = 'bottom', align = 'start', material, width, label, className, noAutoFocus }: LCPopoverProps) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <LCPopoverContent
        side={side}
        align={align}
        material={material}
        width={width}
        aria-label={label}
        className={className}
        onOpenAutoFocus={noAutoFocus ? (e) => e.preventDefault() : undefined}
      >
        {children}
      </LCPopoverContent>
    </PopoverPrimitive.Root>
  )
}
