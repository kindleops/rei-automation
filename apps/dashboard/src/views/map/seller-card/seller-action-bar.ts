import type { FollowUpEligibilityView } from './seller-map-card.types'

export type SellerActionBarState = {
  primary: {
    label: string
    action: 'ownership_check' | 'follow_up' | 'reply' | 'disabled'
    enabled: boolean
    disabledReason: string | null
  }
  secondary: {
    label: string
    action: 'message' | 'open_thread' | 'none'
    enabled: boolean
  }
}

export const resolveSellerActionBar = (params: {
  followUpEligibility: FollowUpEligibilityView
  status: string
  messagingBlocked: boolean
  messagingBlockReason: string | null
  hasThread: boolean
}): SellerActionBarState => {
  const { followUpEligibility, status, messagingBlocked, messagingBlockReason, hasThread } = params

  if (messagingBlocked) {
    return {
      primary: {
        label: followUpEligibility.isUncontacted ? 'Send Ownership Check' : status === 'new_reply' ? 'Reply' : 'Follow Up',
        action: 'disabled',
        enabled: false,
        disabledReason: messagingBlockReason || followUpEligibility.disabledReason || 'Messaging blocked',
      },
      secondary: {
        label: 'Message',
        action: 'message',
        enabled: false,
      },
    }
  }

  if (status === 'new_reply' || status === 'needs_response') {
    return {
      primary: {
        label: 'Reply',
        action: 'reply',
        enabled: true,
        disabledReason: null,
      },
      secondary: {
        label: hasThread ? 'Open Thread' : 'Message',
        action: hasThread ? 'open_thread' : 'message',
        enabled: true,
      },
    }
  }

  if (followUpEligibility.isUncontacted) {
    return {
      primary: {
        label: 'Send Ownership Check',
        action: 'ownership_check',
        enabled: followUpEligibility.canExecute,
        disabledReason: followUpEligibility.disabledReason,
      },
      secondary: {
        label: 'Message',
        action: 'message',
        enabled: !messagingBlocked,
      },
    }
  }

  if (followUpEligibility.canExecute) {
    return {
      primary: {
        label: 'Follow Up',
        action: 'follow_up',
        enabled: true,
        disabledReason: null,
      },
      secondary: {
        label: 'Message',
        action: 'message',
        enabled: true,
      },
    }
  }

  return {
    primary: {
      label: 'Follow Up',
      action: 'follow_up',
      enabled: false,
      disabledReason: followUpEligibility.disabledReason || 'Follow-up not available',
    },
    secondary: {
      label: 'Message',
      action: 'message',
      enabled: !messagingBlocked,
    },
  }
}