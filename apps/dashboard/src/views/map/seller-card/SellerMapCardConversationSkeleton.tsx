export const SellerMapCardConversationSkeleton = () => (
  <div className="smc-conversation-skeleton" aria-hidden="true">
    <div className="smc-conversation-skeleton__head">
      <div className="smc-shimmer smc-shimmer--title" />
      <div className="smc-shimmer smc-shimmer--addr" />
      <div className="smc-conversation-skeleton__badges">
        <span className="smc-shimmer smc-shimmer--badge" />
        <span className="smc-shimmer smc-shimmer--badge" />
        <span className="smc-shimmer smc-shimmer--badge" />
      </div>
    </div>
    <div className="smc-conversation-skeleton__thread">
      <div className="smc-conversation-skeleton__bubble is-in" />
      <div className="smc-conversation-skeleton__bubble is-out" />
      <div className="smc-conversation-skeleton__bubble is-in" />
      <div className="smc-conversation-skeleton__bubble is-out short" />
    </div>
    <div className="smc-conversation-skeleton__composer">
      <div className="smc-shimmer smc-shimmer--input" />
      <div className="smc-conversation-skeleton__actions">
        <span className="smc-shimmer smc-shimmer--icon" />
        <span className="smc-shimmer smc-shimmer--icon" />
        <span className="smc-shimmer smc-shimmer--send" />
      </div>
    </div>
  </div>
)