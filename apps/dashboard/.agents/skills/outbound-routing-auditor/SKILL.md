# Outbound Routing Auditor Skill

This skill ensures the integrity of the message routing flow and prevents infinite loops in automated messaging.

## Architecture Notes

### Routing Flow
1. **Inbound**: Webhook receives message.
2. **Classifier**: Regex and LLM classify message intent.
3. **Queue**: Message is placed in `scratch_run_queue`.
4. **Outbound**: Routing logic determines the next hop based on `message_events`.

### Tracking Direction
All routing logic must track `message_events.direction` (inbound vs outbound) to ensure context-aware responses and prevent self-replies.

## Rules

- **Infinite Loop Prevention**: 
  - Never send an automated response to an automated outbound message.
  - Implement a maximum of 3 automated retries per thread within a 24-hour window.
- **Testing Routing Logic**:
  - Use `scripts/check-thread-state.mjs` to verify routing state before deployment.
  - Mandatory dry-run for any changes to the `outbound_routing` engine.
