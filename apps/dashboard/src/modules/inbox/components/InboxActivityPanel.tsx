import { OperationsCenter } from '../../operations/OperationsCenter'

/**
 * Live Activity — now the Activity section of the Operations Center.
 *
 * The previous 197-line implementation is gone. It had four defects that could
 * not be fixed in place without rebuilding it:
 *
 *  1. Permanent loading. `setLoading(true)` then `await` with no try/finally,
 *     no `.catch`, and `void refresh()` swallowing the rejection. Because
 *     `getSupabaseClient()` throws synchronously when env vars are missing,
 *     `loading` stayed true forever and the panel re-threw every 30s.
 *  2. No error state at all — only loading/empty/rows. A caught failure
 *     rendered "No live activity in this view yet", indistinguishable from a
 *     genuinely quiet feed.
 *  3. An "Undo" button wired to a function that performed no inverse mutation
 *     and returned `{ ok: true }` regardless.
 *  4. A name collision with the map's Live Activity rail (2,584 test-covered
 *     lines), which is the one that keeps the name.
 *
 * This wrapper is kept so existing mount points in the top bar keep working
 * while Lane A moves the rail slots over to `modules/operations`.
 */
export const InboxActivityPanel = ({
  threadKey,
  onClose,
  onViewThread,
}: {
  threadKey?: string
  onClose: () => void
  /** @deprecated Navigation is handled by the Operations Center itself. */
  onViewThread?: (threadKey: string) => void
}) => {
  void onViewThread
  return (
    <OperationsCenter
      open
      onClose={onClose}
      initialSection="activity"
      threadKey={threadKey}
    />
  )
}
