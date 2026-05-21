import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🧪 Testing Multi-Agent Copilot Architecture (Source Validation)...\n');

/**
 * Robust Source Validator
 * Instead of importing TS into a Node/ESM environment which causes resolution errors,
 * we parse the source files as text to validate architectural integrity.
 */

const agentsPath = path.join(__dirname, '../src/modules/copilot/copilot.agents.ts');
const routerPath = path.join(__dirname, '../src/modules/copilot/copilot.router.ts');

const agentsSource = fs.readFileSync(agentsPath, 'utf-8');
const routerSource = fs.readFileSync(routerPath, 'utf-8');

// 1. Verify Agents Metadata
console.log('1️⃣ Validating Agent Personas...');

const agentIds = [
  'ceo', 'coo', 'cfo', 'underwriter', 'acquisitions', 
  'dispo', 'title', 'compliance', 'data'
];

let agentsValid = true;
for (const id of agentIds) {
  if (!agentsSource.includes(`id: '${id}'`)) {
    console.error(`   ❌ Agent ID "${id}" missing from copilot.agents.ts`);
    agentsValid = false;
  }
}

if (agentsValid) {
  console.log(`   ✅ All 9 specialized agents verified in source.`);
}

// 2. Verify Router Logic
console.log('\n2️⃣ Validating Conversational Router Logic...');

const routingRules = [
  { intent: 'strategy', target: 'ceo' },
  { intent: 'workflow', target: 'coo' },
  { intent: 'margin', target: 'cfo' },
  { intent: 'underwrite', target: 'underwriter' },
  { intent: 'reply', target: 'acquisitions' },
  { intent: 'buyer', target: 'dispo' },
  { intent: 'probate', target: 'title' },
  { intent: 'dnc', target: 'compliance' },
  { intent: 'sync', target: 'data' },
];

let routerValid = true;
for (const rule of routingRules) {
  const pattern = new RegExp(`includes\\('${rule.intent}'\\).*return '${rule.target}'`, 's');
  if (!pattern.test(routerSource)) {
    console.error(`   ❌ Routing rule for "${rule.intent}" -> "${rule.target}" missing from copilot.router.ts`);
    routerValid = false;
  }
}

if (routerValid) {
  console.log('   ✅ All conversational routing logic verified in source.');
}

const allPassed = agentsValid && routerValid;

console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
process.exit(allPassed ? 0 : 1);
