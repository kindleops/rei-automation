/**
 * `src/shared/ui` — the ONE primitive library (constitution §8–§11).
 *
 * Owner: Lane A. Every overlay, loading, empty and error surface in the app
 * migrates onto these. Import the stylesheet once from main.tsx.
 */
export { Modal, type ModalProps } from './Modal'
export { Drawer, type DrawerProps } from './Drawer'
export { Popover, type PopoverProps, type PopoverPlacement } from './Popover'
export { Dropdown, type DropdownProps, type DropdownItem } from './Dropdown'
export { Tooltip, type TooltipProps } from './Tooltip'
export { Skeleton, type SkeletonProps } from './Skeleton'
export { EmptyState, type EmptyStateProps, type EmptyStateKind } from './EmptyState'
export { ErrorState, type ErrorStateProps } from './ErrorState'
export { SkipLink } from './SkipLink'
export { useFocusTrap, getFocusable, type FocusTrapOptions } from './useFocusTrap'
