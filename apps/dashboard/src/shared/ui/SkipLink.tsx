/**
 * Skip link — constitution §16.2 / §16.6.
 *
 * The application previously shipped ZERO skip links. This is the first
 * keyboard entry point into the main landmark on every route.
 */
export const SkipLink = ({ targetId = 'lc-main' }: { targetId?: string }) => (
  <a className="lc-skip-link" href={`#${targetId}`}>
    Skip to main content
  </a>
)
