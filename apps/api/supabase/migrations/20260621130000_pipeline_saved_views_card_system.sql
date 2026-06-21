-- Pipeline saved views: card design, sorts, density, system presets

ALTER TABLE public.pipeline_saved_views
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS sorts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS card_design jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS density text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS card_designs_by_group jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_last_activity
  ON public.acquisition_opportunities (last_activity_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_next_action_due
  ON public.acquisition_opportunities (next_action_due ASC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_aos
  ON public.acquisition_opportunities (aos DESC NULLS LAST)
  WHERE acquisition_engine_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_temperature
  ON public.acquisition_opportunities (temperature);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_asking_price
  ON public.acquisition_opportunities (asking_price DESC NULLS LAST);

INSERT INTO public.pipeline_saved_views (
  view_key, label, description, filters, group_by, scope, sorts, is_default, is_pinned, is_system
)
VALUES
  ('preset_needs_reply', 'Needs Reply', 'Conversations requiring operator reply',
   '{"logic":"and","clauses":[{"field":"conversation_state","operator":"is","value":"needs_reply"}]}',
   'stage', 'active', '[{"field":"last_activity_at","direction":"desc","nulls":"last"}]', false, true, true),
  ('preset_ownership_verification', 'Ownership Verification', 'Early stage ownership confirmation',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"ownership_confirmation"}]}',
   'stage', 'active', '[{"field":"stage_age","direction":"desc","nulls":"last"}]', false, false, true),
  ('preset_offer_interest', 'Offer Interest', 'Seller showing offer interest',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"offer_interest"}]}',
   'stage', 'active', '[{"field":"last_activity_at","direction":"desc","nulls":"last"}]', false, false, true),
  ('preset_asking_price_received', 'Asking Price Received', 'Asking price known',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"asking_price"},{"field":"asking_price","operator":"is_known"}]}',
   'stage', 'active', '[{"field":"asking_price","direction":"desc","nulls":"last"}]', false, false, true),
  ('preset_offer_ready', 'Offer Ready', 'Ready for offer decision',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"offer"}]}',
   'stage', 'active', '[{"field":"aos","direction":"desc","nulls":"last"}]', false, true, true),
  ('preset_high_motivation', 'High Motivation', 'High motivation score',
   '{"logic":"and","clauses":[{"field":"motivation_score","operator":"gte","value":70}]}',
   'temperature', 'active', '[{"field":"motivation_score","direction":"desc","nulls":"last"}]', false, false, true),
  ('preset_hot_leads', 'Hot Leads', 'Hot temperature opportunities',
   '{"logic":"and","clauses":[{"field":"temperature","operator":"is","value":"hot"}]}',
   'temperature', 'active', '[{"field":"last_activity_at","direction":"desc","nulls":"last"}]', false, true, true),
  ('preset_follow_ups_due', 'Follow-Ups Due', 'Follow-ups overdue or due now',
   '{"logic":"and","clauses":[{"field":"follow_up_due","operator":"overdue"}]}',
   'follow_up_state', 'active', '[{"field":"follow_up_due","direction":"asc","nulls":"last"}]', false, true, true),
  ('preset_stalled_leads', 'Stalled Leads', 'High stage age with no recent activity',
   '{"logic":"and","clauses":[{"field":"stage_age","operator":"gte","value":14}]}',
   'stage', 'active', '[{"field":"stage_age","direction":"desc","nulls":"last"}]', false, false, true),
  ('preset_automation_blocked', 'Automation Blocked', 'Workflow blocked or approval required',
   '{"logic":"or","clauses":[{"field":"workflow_state","operator":"is","value":"blocked"},{"field":"workflow_state","operator":"is","value":"approval_required"}]}',
   'workflow_status', 'active', '[]', false, true, true),
  ('preset_multifamily_5plus', 'Multifamily 5+', 'Large multifamily properties',
   '{"logic":"and","clauses":[{"field":"property_type","operator":"contains","value":"Multifamily 5"}]}',
   'property_type', 'active', '[{"field":"units_count","direction":"desc","nulls":"last"}]', false, false, true),
  ('preset_creative_finance', 'Creative Finance Candidates', 'Creative finance strategy',
   '{"logic":"and","clauses":[{"field":"strategy","operator":"contains","value":"creative"}]}',
   'stage', 'active', '[{"field":"aos","direction":"desc","nulls":"last"}]', false, false, true),
  ('preset_formal_contract', 'Formal Contract', 'Formal contract stage',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"formal_contract"}]}',
   'stage', 'active', '[]', false, false, true),
  ('preset_under_contract', 'Under Contract', 'Under contract opportunities',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"under_contract"}]}',
   'stage', 'active', '[]', false, false, true),
  ('preset_disposition', 'Disposition', 'Disposition stage',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"disposition"}]}',
   'stage', 'active', '[]', false, false, true),
  ('preset_prepared_to_close', 'Prepared to Close', 'Prepared to close',
   '{"logic":"and","clauses":[{"field":"pipeline_stage","operator":"is","value":"prepared_to_close"}]}',
   'stage', 'active', '[]', false, false, true)
ON CONFLICT (view_key) DO NOTHING;