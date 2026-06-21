#!/usr/bin/env node
/**
 * Seeds production Workflow Studio: full node registry + system templates + master orchestrator.
 * Usage: node --env-file=.env.local --import ./tests/register-aliases.mjs scripts/seed-workflow-studio-production.mjs
 */

import { seedWorkflowStudioProduction } from '@/lib/domain/workflow-v2/workflow-studio-bridge.js';

const result = await seedWorkflowStudioProduction();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);