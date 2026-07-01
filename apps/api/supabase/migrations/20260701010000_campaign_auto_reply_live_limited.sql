-- Allow canonical Full Autopilot (live_limited) on campaign rows.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_auto_reply_mode_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_auto_reply_mode_check
  CHECK (auto_reply_mode IN ('disabled', 'dry_run', 'live_limited'));