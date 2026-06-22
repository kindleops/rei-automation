export const ShellSkeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="nx-shell-skeleton" aria-hidden>
    {Array.from({ length: rows }).map((_, index) => (
      <div key={index} className="nx-shell-skeleton__row" />
    ))}
  </div>
)