// Workflow Studio V2 — operational system workflow graphs (v2).
// Replaces generic trigger → kill_switch → notify_operator skeletons.

export const SYSTEM_GRAPH_VERSION = 2;

function n(key, kind, type, label, config = {}, y = 0) {
  return {
    node_key: key,
    node_kind: kind,
    node_type: type,
    label,
    config,
    position_x: 0,
    position_y: y,
  };
}

function e(src, tgt, condition_key = null, edge_type = 'next') {
  return {
    source_node_key: src,
    target_node_key: tgt,
    condition_key,
    edge_type,
  };
}

function chain(keys, edges) {
  for (let i = 0; i < keys.length - 1; i += 1) {
    edges.push(e(keys[i], keys[i + 1]));
  }
}

function buildDeliveryRecoveryGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.message_failed', 'Message Failed', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('guard_suppression', 'guard', 'guard.suppression', 'Suppression Guard', {}, 160),
    n('cond_retryable', 'condition', 'condition.retryable_failure', 'Classify Retryable', {}, 240),
    n('cond_delivery', 'condition', 'condition.message_delivery_state', 'Reconcile Provider State', {}, 320),
    n('cancel_on_reply', 'action', 'action.cancel_pending_follow_ups', 'Cancel On Reply/Delivery', { reason: 'seller_replied_or_delivered' }, 400),
    n('retry_1', 'timing', 'timing.wait_duration', 'Retry 1 Short Backoff', { minutes: 15 }, 480),
    n('retry_2', 'timing', 'timing.wait_duration', 'Retry 2 Longer Backoff', { minutes: 60 }, 560),
    n('retry_3', 'timing', 'timing.wait_for_local_contact_window', 'Retry 3 Contact Window', {}, 640),
    n('schedule_retry', 'action', 'action.schedule_follow_up', 'Schedule Delivery Retry', { category: 'delivery_retry', max_attempts: 3 }, 720),
    n('cond_max_touches', 'condition', 'condition.prior_touch_count', 'Max Attempts Check', { max: 4 }, 800),
    n('suppress_perm', 'action', 'action.suppress_contact', 'Stop Permanent Failure', {}, 880),
    n('notify_terminal', 'action', 'action.notify_operator', 'Notify Terminal Failure', { severity: 'warning', message: 'Delivery recovery exhausted' }, 960),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 1040),
  ];
  const edges = [];
  chain(
    ['trigger', 'guard_kill', 'guard_suppression', 'cond_retryable', 'cond_delivery', 'cancel_on_reply'],
    edges,
  );
  edges.push(e('cond_retryable', 'retry_1', 'true', 'true'));
  edges.push(e('cond_retryable', 'suppress_perm', 'false', 'false'));
  edges.push(e('cancel_on_reply', 'retry_1'));
  chain(['retry_1', 'retry_2', 'retry_3', 'schedule_retry', 'cond_max_touches'], edges);
  edges.push(e('cond_max_touches', 'notify_terminal', 'true', 'true'));
  edges.push(e('cond_max_touches', 'exit', 'false', 'false'));
  edges.push(e('suppress_perm', 'notify_terminal'));
  edges.push(e('notify_terminal', 'exit'));
  return { nodes, edges };
}

function buildInboundClassificationGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.inbound_message_received', 'Inbound Message', {}, 0),
    n('guard_opt_out', 'guard', 'guard.opt_out', 'Opt-Out Precheck', {}, 80),
    n('guard_suppression', 'guard', 'guard.suppression', 'Legal/Suppression Precheck', {}, 160),
    n('run_classification', 'action', 'action.run_classification', 'Run Classification', {}, 240),
    n('run_extraction', 'action', 'action.run_conversation_extraction', 'Extract Structured Facts', {}, 320),
    n('persist_facts', 'action', 'action.update_structured_fact', 'Persist Facts', { source: 'extraction' }, 400),
    n('cooperation', 'action', 'action.update_structured_fact', 'Seller Cooperation Score', { fact_key: 'cooperation_score' }, 480),
    n('emit_events', 'action', 'action.update_status', 'Emit Domain Events', { target_status: 'classification_completed' }, 560),
    n('cancel_followups', 'action', 'action.cancel_pending_follow_ups', 'Cancel Obsolete Follow-Ups', {}, 640),
    n('route_ownership', 'action', 'action.enroll_subworkflow', 'Route Ownership', { subworkflow_definition_key: 'system_ownership_verification' }, 720),
    n('route_interest', 'action', 'action.enroll_subworkflow', 'Route Interest', { subworkflow_definition_key: 'system_interest_qualification' }, 800),
    n('route_wrong', 'action', 'action.enroll_subworkflow', 'Route Wrong Number', { subworkflow_definition_key: 'system_wrong_number_recovery' }, 880),
    n('route_review', 'action', 'action.enroll_subworkflow', 'Route Human Review', { subworkflow_definition_key: 'system_human_review_escalation' }, 960),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 1040),
  ];
  const edges = [];
  chain(
    [
      'trigger',
      'guard_opt_out',
      'guard_suppression',
      'run_classification',
      'run_extraction',
      'persist_facts',
      'cooperation',
      'emit_events',
      'cancel_followups',
    ],
    edges,
  );
  edges.push(e('cancel_followups', 'route_ownership'));
  edges.push(e('route_ownership', 'route_interest'));
  edges.push(e('route_interest', 'route_wrong'));
  edges.push(e('route_wrong', 'route_review'));
  edges.push(e('route_review', 'exit'));
  return { nodes, edges };
}

function buildOwnershipVerificationGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.classification_completed', 'Classification Completed', { stage: 1 }, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('check_fact', 'condition', 'condition.ownership_status', 'Check Ownership Fact', {}, 160),
    n('run_classification', 'action', 'action.run_classification', 'Classify Owner Response', {}, 240),
    n('lock_fact', 'action', 'action.update_structured_fact', 'Lock Ownership Fact', { fact_key: 'ownership_status', confidence: 0.9 }, 320),
    n('advance_stage', 'action', 'action.update_stage', 'Advance Pipeline Stage', { stage: 'interest_qualification' }, 400),
    n('cancel_followups', 'action', 'action.cancel_pending_follow_ups', 'Cancel Ownership Follow-Ups', { task_types: ['ownership_follow_up'] }, 480),
    n('enroll_interest', 'action', 'action.enroll_subworkflow', 'Enroll Interest Qualification', { subworkflow_definition_key: 'system_interest_qualification' }, 560),
    n('schedule_followup', 'action', 'action.schedule_follow_up', 'Stage 1 Follow-Up', { category: 'ownership', max_attempts: 2, urgency_cadence: true }, 640),
    n('wrong_contact', 'action', 'action.enroll_subworkflow', 'Alternate Contact Recovery', { subworkflow_definition_key: 'system_wrong_number_recovery' }, 720),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 800),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'check_fact', 'run_classification', 'lock_fact', 'advance_stage', 'cancel_followups'], edges);
  edges.push(e('cancel_followups', 'enroll_interest'));
  edges.push(e('enroll_interest', 'schedule_followup'));
  edges.push(e('check_fact', 'wrong_contact', 'false', 'false'));
  edges.push(e('wrong_contact', 'exit'));
  edges.push(e('schedule_followup', 'exit'));
  return { nodes, edges };
}

function buildInterestQualificationGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.ownership_confirmed', 'Ownership Confirmed', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('run_extraction', 'action', 'action.run_conversation_extraction', 'Determine Interest', {}, 160),
    n('motivation', 'action', 'action.update_structured_fact', 'Capture Motivation', { fact_key: 'seller_motivation' }, 240),
    n('timeline', 'action', 'action.update_structured_fact', 'Capture Timeline', { fact_key: 'timeline_to_sell' }, 320),
    n('authority', 'action', 'action.update_structured_fact', 'Capture Decision Authority', { fact_key: 'decision_maker_status' }, 400),
    n('branch_intent', 'condition', 'condition.seller_intent', 'Branch Interest', { mode: 'branch' }, 480),
    n('advance_pricing', 'action', 'action.update_stage', 'Advance To Pricing', { stage: 'asking_price' }, 560),
    n('enroll_pricing', 'action', 'action.enroll_subworkflow', 'Enroll Asking Price', { subworkflow_definition_key: 'system_asking_price_extraction' }, 640),
    n('schedule_followup', 'action', 'action.schedule_follow_up', 'Interest Follow-Up', { category: 'interest', days_min: 5, days_max: 7 }, 720),
    n('nurture', 'action', 'action.enroll_subworkflow', 'Nurture Low Interest', { subworkflow_definition_key: 'system_nurture_reactivation' }, 800),
    n('human_review', 'action', 'action.enroll_subworkflow', 'Human Review', { subworkflow_definition_key: 'system_human_review_escalation' }, 880),
    n('suppress', 'action', 'action.suppress_contact', 'Stop/Suppress', {}, 960),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 1040),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'run_extraction', 'motivation', 'timeline', 'authority', 'branch_intent'], edges);
  edges.push(e('branch_intent', 'advance_pricing', 'interested', 'branch'));
  edges.push(e('branch_intent', 'schedule_followup', 'conditionally_interested', 'branch'));
  edges.push(e('advance_pricing', 'enroll_pricing'));
  edges.push(e('enroll_pricing', 'exit'));
  edges.push(e('schedule_followup', 'exit'));
  edges.push(e('branch_intent', 'nurture', 'future_interest', 'branch'));
  edges.push(e('branch_intent', 'nurture', 'listed', 'branch'));
  edges.push(e('branch_intent', 'suppress', 'not_interested', 'branch'));
  edges.push(e('branch_intent', 'suppress', 'opted_out', 'branch'));
  edges.push(e('branch_intent', 'human_review', 'represented', 'branch'));
  edges.push(e('branch_intent', 'human_review', 'unclear', 'branch'));
  edges.push(e('branch_intent', 'human_review', 'needs_review', 'branch'));
  edges.push(e('nurture', 'exit'));
  edges.push(e('human_review', 'exit'));
  edges.push(e('suppress', 'exit'));
  return { nodes, edges };
}

function buildAskingPriceExtractionGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.interest_confirmed', 'Interest Confirmed', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('check_price', 'condition', 'condition.asking_price_present', 'Check Existing Price', {}, 160),
    n('run_extraction', 'action', 'action.run_conversation_extraction', 'Extract Asking Price', {}, 240),
    n('normalize_price', 'action', 'action.update_structured_fact', 'Normalize Amount', { fact_key: 'asking_price' }, 320),
    n('calc_gap', 'action', 'action.calculate_offer_ask_gap', 'Calculate Offer Ratios', {}, 400),
    n('check_engine', 'condition', 'condition.missing_underwriting_fact', 'Engine Output Stale?', { fact_key: 'acquisition_engine_output' }, 480),
    n('run_engine', 'action', 'action.run_acquisition_engine', 'Request Engine Execution', { mode: 'preliminary' }, 560),
    n('emit_event', 'action', 'action.update_status', 'Emit asking_price_extracted', { target_status: 'asking_price_extracted' }, 640),
    n('ask_missing', 'action', 'action.enqueue_sms', 'Ask For Price', { use_case: 'asking_price_request', template_key: 'asking_price' }, 720),
    n('schedule_followup', 'action', 'action.schedule_follow_up', 'Price Follow-Up', { category: 'asking_price', days_min: 2, days_max: 3 }, 800),
    n('enroll_uw', 'action', 'action.enroll_subworkflow', 'Enroll Underwriting', { subworkflow_definition_key: 'system_underwriting_collection' }, 880),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 960),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'check_price'], edges);
  edges.push(e('check_price', 'run_extraction', 'false', 'false'));
  edges.push(e('check_price', 'calc_gap', 'true', 'true'));
  chain(['run_extraction', 'normalize_price', 'calc_gap', 'check_engine'], edges);
  edges.push(e('check_engine', 'run_engine', 'true', 'true'));
  edges.push(e('check_engine', 'emit_event', 'false', 'false'));
  edges.push(e('run_engine', 'emit_event'));
  edges.push(e('emit_event', 'enroll_uw'));
  edges.push(e('check_price', 'ask_missing', 'false', 'false'));
  edges.push(e('ask_missing', 'schedule_followup'));
  edges.push(e('schedule_followup', 'exit'));
  edges.push(e('enroll_uw', 'exit'));
  return { nodes, edges };
}

function buildUnderwritingCollectionGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.asking_price_extracted', 'Asking Price Extracted', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('determine_playbook', 'action', 'action.run_underwriting', 'Determine Asset Playbook', {}, 160),
    n('branch_asset', 'condition', 'condition.asset_class', 'Branch Asset Class', {}, 240),
    n('missing_facts', 'condition', 'condition.missing_underwriting_fact', 'Missing Required Facts', {}, 320),
    n('ask_question', 'action', 'action.enqueue_sms', 'Ask Highest-Value Question', { use_case: 'underwriting_question' }, 400),
    n('persist_partial', 'action', 'action.update_structured_fact', 'Persist Partial Answer', { source: 'inbound' }, 480),
    n('preliminary_uw', 'action', 'action.run_underwriting', 'Preliminary Underwriting', { mode: 'preliminary' }, 560),
    n('readiness', 'condition', 'condition.missing_underwriting_fact', 'Underwriting Readiness', { threshold: 0 }, 640),
    n('emit_ready', 'action', 'action.update_status', 'Emit Readiness', { target_status: 'underwriting_ready' }, 720),
    n('enroll_engine', 'action', 'action.enroll_subworkflow', 'Enroll Acquisition Engine', { subworkflow_definition_key: 'system_acquisition_engine_orchestration' }, 800),
    n('schedule_followup', 'action', 'action.schedule_follow_up', 'UW Follow-Up', { category: 'underwriting', days_min: 1, days_max: 2 }, 880),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 960),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'determine_playbook', 'branch_asset', 'missing_facts'], edges);
  edges.push(e('missing_facts', 'ask_question', 'true', 'true'));
  edges.push(e('ask_question', 'persist_partial'));
  edges.push(e('persist_partial', 'schedule_followup'));
  edges.push(e('schedule_followup', 'missing_facts'));
  edges.push(e('missing_facts', 'preliminary_uw', 'false', 'false'));
  chain(['preliminary_uw', 'readiness'], edges);
  edges.push(e('readiness', 'emit_ready', 'false', 'false'));
  edges.push(e('emit_ready', 'enroll_engine'));
  edges.push(e('enroll_engine', 'exit'));
  edges.push(e('readiness', 'ask_question', 'true', 'true'));
  return { nodes, edges };
}

function buildAcquisitionEngineOrchestrationGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.underwriting_fact_updated', 'Underwriting Readiness', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('check_readiness', 'condition', 'condition.missing_underwriting_fact', 'Engine Readiness', {}, 160),
    n('determine_mode', 'action', 'action.update_structured_fact', 'Determine Run Mode', { fact_key: 'acquisition_engine_mode' }, 240),
    n('run_engine', 'action', 'action.run_acquisition_engine', 'Run Acquisition Engine', {}, 320),
    n('persist_output', 'action', 'action.update_structured_fact', 'Persist Engine Output', { fact_key: 'acquisition_engine_output' }, 400),
    n('branch_result', 'condition', 'condition.best_strategy', 'Branch By Result', {}, 480),
    n('approval', 'action', 'action.request_human_approval', 'Request Human Approval', { reason: 'material_risk_or_offer' }, 560),
    n('enroll_offer', 'action', 'action.enroll_subworkflow', 'Enroll Offer Follow-Up', { subworkflow_definition_key: 'system_offer_follow_up' }, 640),
    n('preserve_prior', 'action', 'action.update_structured_fact', 'Preserve Prior On Failure', { fact_key: 'acquisition_engine_output', on_failure: true }, 720),
    n('notify_failure', 'action', 'action.notify_operator', 'Notify On Failure/Risk', { severity: 'warning' }, 800),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 880),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'check_readiness', 'determine_mode', 'run_engine', 'persist_output', 'branch_result'], edges);
  edges.push(e('branch_result', 'approval', 'review_required', 'true'));
  edges.push(e('branch_result', 'enroll_offer', 'success', 'true'));
  edges.push(e('branch_result', 'preserve_prior', 'failure', 'false'));
  edges.push(e('approval', 'enroll_offer'));
  edges.push(e('preserve_prior', 'notify_failure'));
  edges.push(e('notify_failure', 'exit'));
  edges.push(e('enroll_offer', 'exit'));
  edges.push(e('check_readiness', 'notify_failure', 'false', 'false'));
  return { nodes, edges };
}

function buildOfferFollowUpGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.offer_sent', 'Offer Sent', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('guard_approval', 'guard', 'guard.approval_required', 'Protected Offer Guard', {}, 160),
    n('cancel_on_reply', 'action', 'action.cancel_pending_follow_ups', 'Cancel On Seller Reply', {}, 240),
    n('run_classification', 'action', 'action.run_classification', 'Classify Response', {}, 320),
    n('persist_counter', 'action', 'action.update_structured_fact', 'Persist Counteroffer', { fact_key: 'counteroffer_amount' }, 400),
    n('rerun_gap', 'action', 'action.calculate_offer_ask_gap', 'Rerun Gap Analysis', {}, 480),
    n('schedule_1d', 'action', 'action.schedule_follow_up', 'Follow-Up 1 Day', { touch_index: 1, days: 1 }, 560),
    n('schedule_3d', 'action', 'action.schedule_follow_up', 'Follow-Up 3 Days', { touch_index: 2, days: 3 }, 640),
    n('schedule_7d', 'action', 'action.schedule_follow_up', 'Follow-Up 7 Days', { touch_index: 3, days: 7 }, 720),
    n('schedule_14d', 'action', 'action.schedule_follow_up', 'Follow-Up 14 Days', { touch_index: 4, days: 14 }, 800),
    n('route_negotiation', 'action', 'action.enroll_subworkflow', 'Route Negotiation', { subworkflow_definition_key: 'system_human_review_escalation' }, 880),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 960),
  ];
  const edges = [];
  chain(
    [
      'trigger',
      'guard_kill',
      'guard_approval',
      'cancel_on_reply',
      'run_classification',
      'persist_counter',
      'rerun_gap',
    ],
    edges,
  );
  chain(['schedule_1d', 'schedule_3d', 'schedule_7d', 'schedule_14d', 'route_negotiation', 'exit'], edges);
  edges.push(e('rerun_gap', 'schedule_1d'));
  return { nodes, edges };
}

function buildWrongNumberRecoveryGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.inbound_message_received', 'Wrong Number Detected', { intent: 'wrong_number' }, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('run_classification', 'action', 'action.run_classification', 'Confirm Wrong Number', {}, 160),
    n('mark_wrong', 'action', 'action.mark_wrong_number', 'Suppress Invalid Phone', {}, 240),
    n('preserve_relation', 'action', 'action.update_structured_fact', 'Preserve Owner/Property', { fact_key: 'owner_property_preserved' }, 320),
    n('select_contact', 'action', 'action.select_next_contact_method', 'Select Next Contact', {}, 400),
    n('guard_duplicate', 'guard', 'guard.duplicate_action', 'Prevent Duplicate Attempts', {}, 480),
    n('update_routing', 'action', 'action.update_status', 'Update Target Routing', { target_status: 'alternate_contact' }, 560),
    n('enroll_ownership', 'action', 'action.enroll_subworkflow', 'Enroll Ownership Verification', { subworkflow_definition_key: 'system_ownership_verification' }, 640),
    n('no_contact', 'condition', 'condition.contact_method_available', 'Contact Remains?', {}, 720),
    n('notify_operator', 'action', 'action.notify_operator', 'Notify No Contact Remains', { severity: 'info' }, 800),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 880),
  ];
  const edges = [];
  chain(
    ['trigger', 'guard_kill', 'run_classification', 'mark_wrong', 'preserve_relation', 'select_contact', 'guard_duplicate', 'update_routing', 'enroll_ownership'],
    edges,
  );
  edges.push(e('enroll_ownership', 'no_contact'));
  edges.push(e('no_contact', 'exit', 'true', 'true'));
  edges.push(e('no_contact', 'notify_operator', 'false', 'false'));
  edges.push(e('notify_operator', 'exit'));
  return { nodes, edges };
}

function buildStageAwareNoReplyGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.follow_up_due', 'Follow-Up Due', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('guard_suppression', 'guard', 'guard.suppression', 'Suppression Guard', {}, 120),
    n('reload_stage', 'condition', 'condition.pipeline_stage', 'Reload Seller Stage', {}, 160),
    n('cancel_reply', 'condition', 'condition.seller_replied', 'Cancel If Replied', {}, 240),
    n('cancel_stage', 'condition', 'condition.pipeline_stage', 'Cancel If Stage Changed', {}, 320),
    n('guard_max', 'guard', 'guard.max_touches', 'Enforce Max Touches', {}, 400),
    n('select_template', 'action', 'action.select_template', 'Stage/Language Template', {}, 480),
    n('enqueue', 'action', 'action.enqueue_sms', 'Enqueue No-Send Queue', { use_case: 'stage_follow_up' }, 560),
    n('schedule_next', 'action', 'action.schedule_follow_up', 'Schedule Next Touch', { category: 'no_reply' }, 640),
    n('nurture', 'action', 'action.enroll_subworkflow', 'Exit To Nurture', { subworkflow_definition_key: 'system_nurture_reactivation' }, 720),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 800),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'guard_suppression', 'reload_stage', 'cancel_reply', 'cancel_stage', 'guard_max'], edges);
  edges.push(e('cancel_reply', 'exit', 'true', 'true'));
  edges.push(e('cancel_stage', 'exit', 'true', 'true'));
  edges.push(e('guard_max', 'nurture', 'blocked', 'false'));
  edges.push(e('guard_max', 'select_template', 'next', 'next'));
  chain(['select_template', 'enqueue', 'schedule_next'], edges);
  edges.push(e('schedule_next', 'exit'));
  edges.push(e('nurture', 'exit'));
  return { nodes, edges };
}

function buildNurtureReactivationGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.pipeline_stage_changed', 'Nurture Enrollment', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 60),
    n('guard_suppression', 'guard', 'guard.suppression', 'Verify Suppression', {}, 80),
    n('check_negotiation', 'condition', 'condition.pipeline_stage', 'No Active Negotiation', {}, 160),
    n('cadence', 'action', 'action.schedule_follow_up', '30/60/90 Cadence', { category: 'nurture' }, 240),
    n('select_template', 'action', 'action.select_template', 'Adapt Template', {}, 320),
    n('enqueue', 'action', 'action.enqueue_sms', 'Safe No-Send Outreach', { use_case: 'nurture_touch' }, 400),
    n('cancel_reply', 'action', 'action.cancel_pending_follow_ups', 'Stop On Reply', {}, 480),
    n('reactivate', 'action', 'action.update_stage', 'Reactivate Acquisition Stage', { stage: 'from_context' }, 560),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 640),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'guard_suppression', 'check_negotiation', 'cadence', 'select_template', 'enqueue', 'cancel_reply', 'reactivate', 'exit'], edges);
  return { nodes, edges };
}

function buildOptOutSuppressionGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.inbound_message_received', 'Inbound / Opt-Out Event', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('run_classification', 'action', 'action.run_classification', 'Detect Opt-Out', {}, 160),
    n('suppress', 'action', 'action.suppress_contact', 'Persist Suppression', {}, 240),
    n('cancel_queue', 'action', 'action.cancel_pending_follow_ups', 'Cancel Queue Rows', { include_queue: true }, 320),
    n('cancel_comms', 'action', 'action.cancel_pending_follow_ups', 'Cancel Workflow Comms', {}, 400),
    n('cancel_followups', 'action', 'action.cancel_pending_follow_ups', 'Cancel Follow-Ups', {}, 480),
    n('audit', 'action', 'action.update_structured_fact', 'Write Audit Event', { fact_key: 'opt_out_audit' }, 560),
    n('stop_workflows', 'action', 'action.update_status', 'Stop Communication Workflows', { target_status: 'suppressed' }, 640),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 720),
  ];
  const edges = [];
  chain(
    [
      'trigger',
      'guard_kill',
      'run_classification',
      'suppress',
      'cancel_queue',
      'cancel_comms',
      'cancel_followups',
      'audit',
      'stop_workflows',
      'exit',
    ],
    edges,
  );
  return { nodes, edges };
}

function buildHumanReviewEscalationGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.classification_completed', 'Human Review Trigger', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('classify_risk', 'action', 'action.run_classification', 'Classify Escalation Risk', {}, 160),
    n('pause_branch', 'action', 'action.request_human_approval', 'Pause Protected Branch', {}, 240),
    n('notify_operator', 'action', 'action.notify_operator', 'Notify Operator', { severity: 'high' }, 320),
    n('preserve_context', 'action', 'action.update_structured_fact', 'Preserve Run Context', { fact_key: 'review_context' }, 400),
    n('guard_approval', 'guard', 'guard.approval_required', 'Await Approval', {}, 480),
    n('branch_decision', 'condition', 'condition.classification_confidence', 'Approval Decision', {}, 560),
    n('resume', 'action', 'action.update_status', 'Resume After Decision', { target_status: 'review_resolved' }, 640),
    n('route_stage', 'action', 'action.enroll_subworkflow', 'Resume Target Workflow', { subworkflow_definition_key: 'system_interest_qualification' }, 720),
    n('audit', 'action', 'action.update_structured_fact', 'Audit Decision', { fact_key: 'review_audit' }, 800),
    n('exit', 'action', 'action.exit_workflow', 'Exit', {}, 880),
  ];
  const edges = [];
  chain(['trigger', 'guard_kill', 'classify_risk', 'pause_branch', 'notify_operator', 'preserve_context', 'guard_approval', 'branch_decision'], edges);
  edges.push(e('branch_decision', 'resume', 'true', 'true'));
  edges.push(e('resume', 'route_stage'));
  edges.push(e('route_stage', 'audit'));
  edges.push(e('audit', 'exit'));
  edges.push(e('branch_decision', 'exit', 'false', 'false'));
  return { nodes, edges };
}

const GRAPH_BUILDERS = Object.freeze({
  delivery_recovery: buildDeliveryRecoveryGraph,
  inbound_classification: buildInboundClassificationGraph,
  ownership_verification: buildOwnershipVerificationGraph,
  interest_qualification: buildInterestQualificationGraph,
  asking_price_extraction: buildAskingPriceExtractionGraph,
  underwriting_collection: buildUnderwritingCollectionGraph,
  acquisition_engine_orchestration: buildAcquisitionEngineOrchestrationGraph,
  offer_follow_up: buildOfferFollowUpGraph,
  wrong_number_recovery: buildWrongNumberRecoveryGraph,
  stage_aware_no_reply: buildStageAwareNoReplyGraph,
  nurture_reactivation: buildNurtureReactivationGraph,
  opt_out_suppression: buildOptOutSuppressionGraph,
  human_review_escalation: buildHumanReviewEscalationGraph,
});

export function buildSystemWorkflowGraph(templateKey) {
  const builder = GRAPH_BUILDERS[templateKey];
  if (!builder) {
    throw new Error(`unknown_system_workflow_template:${templateKey}`);
  }
  return builder();
}

export function countBusinessActions(graph = {}) {
  const notifyOnly = new Set(['action.notify_operator', 'action.notify_agent', 'action.exit_workflow']);
  const nodes = graph.nodes ?? [];
  return nodes.filter((node) => {
    if (notifyOnly.has(node.node_type)) return false;
    if (node.node_kind === 'action') return true;
    if (node.node_kind === 'timing') return true;
    if (node.node_kind === 'condition') return true;
    return false;
  }).length;
}

export const MASTER_ORCHESTRATOR_STAGES = Object.freeze([
  { key: 'stage_0', label: 'Stage 0 — Intake & Safety', subworkflow_key: 'system_opt_out_suppression', stage_gate: 'intake' },
  { key: 'stage_1', label: 'Stage 1 — Ownership', subworkflow_key: 'system_ownership_verification', stage_gate: 'ownership' },
  { key: 'stage_2', label: 'Stage 2 — Interest', subworkflow_key: 'system_interest_qualification', stage_gate: 'interest' },
  { key: 'stage_3', label: 'Stage 3 — Pricing', subworkflow_key: 'system_asking_price_extraction', stage_gate: 'asking_price' },
  { key: 'stage_4', label: 'Stage 4 — Underwriting', subworkflow_key: 'system_underwriting_collection', stage_gate: 'underwriting' },
  { key: 'stage_5', label: 'Stage 5 — Offer Engine', subworkflow_key: 'system_acquisition_engine_orchestration', stage_gate: 'offer_engine' },
  {
    key: 'stage_6',
    label: 'Stage 6 — Contract-to-Close',
    subworkflow_key: 'system_offer_follow_up',
    stage_gate: 'contract_close',
    blocked: true,
    blocked_reason: 'pipeline_and_calendar_not_wired',
  },
]);

export function buildMasterOrchestratorGraph() {
  const nodes = [
    n('trigger', 'trigger', 'trigger.manual_enrollment', 'Manual Enrollment', {}, 0),
    n('guard_kill', 'guard', 'guard.workflow_kill_switch', 'Kill Switch', {}, 80),
    n('guard_idempotency', 'guard', 'guard.duplicate_action', 'Orchestrator Idempotency', {}, 160),
  ];
  const edges = [e('trigger', 'guard_kill'), e('guard_kill', 'guard_idempotency')];

  let y = 240;
  let priorKey = 'guard_idempotency';
  for (const stage of MASTER_ORCHESTRATOR_STAGES) {
    const gateKey = `${stage.key}_gate`;
    const enrollKey = stage.key;
    nodes.push(
      n(gateKey, 'condition', 'condition.pipeline_stage', `${stage.label} Gate`, { expected_stage: stage.stage_gate }, y),
    );
    y += 80;
    nodes.push(
      n(enrollKey, 'action', 'action.enroll_subworkflow', stage.label, {
        subworkflow_definition_key: stage.subworkflow_key,
        blocked: stage.blocked === true,
        blocked_reason: stage.blocked_reason ?? null,
        idempotency_key: `orchestrator:${stage.key}`,
      }, y),
    );
    y += 80;
    edges.push(e(priorKey, gateKey));
    edges.push(e(gateKey, enrollKey, 'true', 'true'));
    priorKey = enrollKey;
  }

  nodes.push(n('exit', 'action', 'action.exit_workflow', 'Exit Orchestrator', {}, y));
  edges.push(e(priorKey, 'exit'));

  return { nodes, edges };
}