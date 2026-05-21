# Seller Conversation Engine Skill

This skill handles the logic for managing seller SMS responses and drafting replies.

## Handling Seller SMS Responses
- All inbound SMS must be logged in `message_events`.
- Deduplication logic: Check `msg_hash` in `message_events` before processing to prevent double-processing.

## Understanding Queue State
- Monitor `scratch_run_queue` for pending tasks.
- Ensure `thread_id` is present for all queued conversation tasks.

## Drafting Replies
- Use `inbox_threads_hydrated` view to get the full context of the conversation.
- Always include the last 3 messages in the prompt context for the reply generator.
- Replies must be saved in `draft_replies` table before being sent.
