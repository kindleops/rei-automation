#!/usr/bin/env node
/**
 * Audit-only generator for Workflow Studio V2 system workflow inventory.
 * Does not mutate templates, strategy, or production workflow state.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listWorkflowStudioCatalog,
  getWorkflowStudioDetail,
  listWorkflowNodeRegistry,
} from '../src/lib/domain/workflow-v2/workflow-studio-bridge.js';
import { MASTER_ORCHESTRATOR_STAGES, SYSTEM_GRAPH_VERSION } from '../src/lib/domain/workflow-v2/system-workflow-graphs.js';
import { SYSTEM_WORKFLOW_TEMPLATES } from '../src/lib/domain/workflow-v2/system-templates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '../../../docs/backend/workflow_studio_v2_system_workflow_audit.md');

function mdEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function summarizeWorkflow(workflow, detail = null) {
  const meta = workflow.metadata && typeof workflow.metadata === 'object' ? workflow.metadata : {};
  const validation = detail?.validation ?? {};
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? '',
    enabled: workflow.status === 'active' || workflow.operational_mode === 'live' || workflow.operational_mode === 'armed',
    lifecycle: workflow.status,
    operational_mode: workflow.operational_mode ?? workflow.status,
    version: workflow.version ?? 1,
    trigger: workflow.trigger_type ?? meta.trigger_type ?? null,
    stage: meta.stage_code ?? meta.stage ?? null,
    touch: meta.touch_number ?? meta.touch ?? null,
    node_count: detail?.nodes?.length ?? workflow.node_count ?? workflow.step_count ?? 0,
    edge_count: detail?.edges?.length ?? workflow.edge_count ?? 0,
    validation_errors: validation.errors?.length ?? 0,
    validation_warnings: validation.warnings?.length ?? 0,
    is_system: workflow.is_system_template === true,
    is_legacy: workflow.is_legacy === true,
    definition_key: workflow.workflow_key ?? workflow.definition_key ?? null,
    updated_at: workflow.updated_at ?? workflow.last_updated ?? null,
    stats: workflow.stats ?? {},
  };
}

async function main() {
  const started = Date.now();
  const catalog = await listWorkflowStudioCatalog({ include_archived: true, summary: true });
  const registry = await listWorkflowNodeRegistry({ include_internal: true });
  const workflows = catalog.workflows ?? [];

  const systemRows = [];
  for (const workflow of workflows) {
    let detail = null;
    try {
      detail = await getWorkflowStudioDetail(workflow.id, { include_analytics: false });
    } catch {
      detail = null;
    }
    systemRows.push(summarizeWorkflow(workflow, detail?.ok === false ? null : detail));
  }

  const stageMap = MASTER_ORCHESTRATOR_STAGES.map((stage) => {
    const canonical = systemRows.find((row) => row.definition_key === stage.subworkflow_key);
    const template = SYSTEM_WORKFLOW_TEMPLATES.find((item) => `system_${item.key}` === stage.subworkflow_key);
    return {
      stage: stage.label,
      stage_key: stage.key,
      gate: stage.stage_gate,
      canonical_workflow_id: canonical?.id ?? null,
      canonical_workflow_name: canonical?.name ?? template?.name ?? null,
      subworkflow_key: stage.subworkflow_key,
      blocked: stage.blocked === true,
      blocked_reason: stage.blocked_reason ?? null,
      template_trigger: template?.trigger_type ?? null,
    };
  });

  const lines = [];
  lines.push('# Workflow Studio V2 — System Workflow Audit');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Generator runtime: ${Date.now() - started}ms`);
  lines.push(`System graph version: ${SYSTEM_GRAPH_VERSION}`);
  lines.push(`Registry nodes: ${registry.counts?.total ?? 0} total / ${registry.counts?.operator ?? 0} operator`);
  lines.push('');
  lines.push('> Audit-only document. No template, timing, or live-send strategy changes were applied.');
  lines.push('');
  lines.push('## Seller Journey S1–S6 Mapping');
  lines.push('');
  lines.push('| Stage | Gate | Canonical Workflow | Workflow ID | Trigger | Status |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of stageMap) {
    lines.push(`| ${mdEscape(row.stage)} | ${mdEscape(row.gate)} | ${mdEscape(row.canonical_workflow_name ?? 'MISSING')} | ${mdEscape(row.canonical_workflow_id ?? '—')} | ${mdEscape(row.template_trigger ?? '—')} | ${row.blocked ? `BLOCKED (${mdEscape(row.blocked_reason)})` : 'mapped'} |`);
  }
  lines.push('');
  lines.push('## Full Workflow Inventory');
  lines.push('');
  lines.push('| ID | Name | Enabled | Lifecycle | Version | Trigger | Nodes | Edges | Val Err | Val Warn | System | Legacy | Updated |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of systemRows.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`| ${mdEscape(row.id)} | ${mdEscape(row.name)} | ${row.enabled ? 'yes' : 'no'} | ${mdEscape(row.lifecycle)} | ${row.version} | ${mdEscape(row.trigger)} | ${row.node_count} | ${row.edge_count} | ${row.validation_errors} | ${row.validation_warnings} | ${row.is_system ? 'yes' : 'no'} | ${row.is_legacy ? 'yes' : 'no'} | ${mdEscape(row.updated_at)} |`);
  }

  lines.push('');
  lines.push('## Flags');
  lines.push('');
  const duplicates = systemRows
    .filter((row) => row.definition_key)
    .reduce((acc, row) => {
      acc[row.definition_key] = (acc[row.definition_key] ?? 0) + 1;
      return acc;
    }, {});
  const duplicateKeys = Object.entries(duplicates).filter(([, count]) => count > 1).map(([key]) => key);
  lines.push(`- Duplicate definition keys: ${duplicateKeys.length ? duplicateKeys.join(', ') : 'none detected'}`);
  lines.push(`- Missing S1–S6 canonical workflows: ${stageMap.filter((row) => !row.canonical_workflow_id && !row.blocked).map((row) => row.stage_key).join(', ') || 'none'}`);
  lines.push(`- Legacy (V1) workflows in catalog: ${systemRows.filter((row) => row.is_legacy).length}`);
  lines.push(`- Disabled but system-tagged workflows: ${systemRows.filter((row) => row.is_system && !row.enabled).length}`);
  lines.push(`- Workflows with validation errors: ${systemRows.filter((row) => row.validation_errors > 0).length}`);
  lines.push(`- Workflows with zero terminal path (0 edges & >1 nodes): ${systemRows.filter((row) => row.edge_count === 0 && row.node_count > 1).length}`);

  writeFileSync(OUTPUT, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});