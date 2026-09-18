-- INBOUND BUYER REPLIES NEED SOMEWHERE TO LAND.
--
-- Additive only. `buyer_outreach_targets` recorded what we sent; these four
-- columns record what came back, so a buyer's answer is not written into the
-- seller conversation tables it does not belong in.
--
-- `reply_attribution` exists because a buyer firm contacted about several
-- properties produces a reply that genuinely cannot be attributed to one of
-- them. Marking every candidate 'ambiguous' is what stops a surface presenting
-- one of them as the confirmed answer.

ALTER TABLE public.buyer_outreach_targets
  ADD COLUMN IF NOT EXISTS replied_at        timestamptz,
  ADD COLUMN IF NOT EXISTS reply_body        text,
  ADD COLUMN IF NOT EXISTS reply_is_opt_out  boolean,
  ADD COLUMN IF NOT EXISTS reply_attribution text;

COMMENT ON COLUMN public.buyer_outreach_targets.reply_attribution IS
  'attributed = this reply belongs to this target; ambiguous = the replying number had live outreach for several properties and an operator must resolve which.';

CREATE INDEX IF NOT EXISTS buyer_outreach_replied_idx
  ON public.buyer_outreach_targets (replied_at DESC)
  WHERE replied_at IS NOT NULL;
