import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { LCButton } from './Button'
import { cx } from './cx'
import './lc-overlay.css'

/**
 * Blocking surfaces — the only depth-5 elements in the product.
 *
 * True modal behaviour is reserved for destructive actions, required
 * confirmations, focused creation and critical decisions. Ordinary
 * inspection never goes in a modal: that is LCInspector.
 *
 * LCConfirm states the EFFECT, never "Are you sure?":
 *   Pause campaign?
 *   · New campaign sends will stop.          (stops)
 *   · Existing seller conversations remain.  (keeps)
 * Cancel takes focus first, so Enter never confirms by accident.
 */

export interface LCDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: number
  /** blocks outside-click dismissal (forms with unsaved input) */
  sticky?: boolean
}

export function LCDialog({ open, onOpenChange, title, description, children, footer, width, sticky }: LCDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="lc-scrim" />
        <DialogPrimitive.Content
          className="lc-dialog"
          style={width ? ({ ['--lc-dialog-w' as string]: `${width}px` }) : undefined}
          onInteractOutside={sticky ? (e) => e.preventDefault() : undefined}
        >
          <DialogPrimitive.Title className="lc-dialog__title">{title}</DialogPrimitive.Title>
          {description ? <DialogPrimitive.Description className="lc-dialog__desc">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="lc-sr-only">{typeof title === 'string' ? title : 'Dialog'}</DialogPrimitive.Description>}
          {children ? <div className="lc-dialog__body">{children}</div> : null}
          {footer ? <div className="lc-dialog__foot">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export interface LCEffect {
  text: string
  /** stops = something halts; keeps = something is preserved; danger = irreversible */
  kind?: 'stops' | 'keeps' | 'danger' | 'note'
}

export interface LCConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** the question in product words: "Pause campaign?" */
  title: string
  effects: LCEffect[]
  /** the action in product words: "Pause campaign" — never "OK" */
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  /** may be async; the button shows progress and errors stay in the dialog */
  onConfirm: () => void | Promise<void>
}

export function LCConfirm({ open, onOpenChange, title, effects, confirmLabel, cancelLabel = 'Cancel', tone = 'primary', onConfirm }: LCConfirmProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'That didn’t go through. Nothing was changed.')
    } finally {
      setPending(false)
    }
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!pending) { setError(null); onOpenChange(o) } }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="lc-scrim" />
        <DialogPrimitive.Content className="lc-dialog" role="alertdialog" onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('[data-lc-cancel]')?.focus() }}>
          <DialogPrimitive.Title className="lc-dialog__title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description asChild>
            <ul className="lc-dialog__effects">
              {effects.map((e) => <li key={e.text} data-kind={e.kind ?? 'note'}>{e.text}</li>)}
            </ul>
          </DialogPrimitive.Description>
          {error ? <p className="lc-dialog__error" role="alert">{error}</p> : null}
          <div className="lc-dialog__foot">
            <DialogPrimitive.Close asChild>
              <LCButton variant="quiet" data-lc-cancel="" disabled={pending}>{cancelLabel}</LCButton>
            </DialogPrimitive.Close>
            <LCButton variant={tone === 'danger' ? 'danger' : 'primary'} loading={pending} onClick={run}>{confirmLabel}</LCButton>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export interface LCSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: 'right' | 'bottom'
  title: ReactNode
  /** visually hidden description for assistive tech when no subtitle */
  description?: string
  width?: number
  children: ReactNode
  className?: string
  trigger?: ReactElement
}

/** A modal sheet: for focused creation that keeps the page visible behind it. */
export function LCSheet({ open, onOpenChange, side = 'right', title, description, width, children, className, trigger }: LCSheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="lc-scrim" />
        <DialogPrimitive.Content className={cx('lc-sheet', `is-${side}`, className)} style={width ? ({ ['--lc-sheet-w' as string]: `${width}px` }) : undefined}>
          <DialogPrimitive.Title className="lc-sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="lc-sr-only">{description || (typeof title === 'string' ? title : 'Sheet')}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export const LCDialogClose = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Close>>(function LCDialogClose(props, ref) {
  return <DialogPrimitive.Close ref={ref} {...props} />
})
