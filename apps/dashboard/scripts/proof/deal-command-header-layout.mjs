#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetFile = path.join(__dirname, '../../src/modules/inbox/components/IntelligencePanel.tsx');
const cssFile = path.join(__dirname, '../../src/index.css');

console.log('🧪 Running Deal Command Header Layout Proof...\n');

const panelContent = fs.readFileSync(targetFile, 'utf8');
const cssContent = fs.readFileSync(cssFile, 'utf8');

const checks = [
  { name: 'V3 Class Presence', pattern: /nx-dossier-header-v3/ },
  { name: 'Avatar Refinement', pattern: /nx-header-avatar-v3/ },
  { name: 'Telemetry Rail', pattern: /nx-header-telemetry-rail-v3/ },
  { name: 'Refined Interest Label', pattern: /No Active Interest/ },
  { name: 'Market Fallback', pattern: /Market Pending/ },
  { name: 'CSS Refinement Block', pattern: /Deal Command Header Refinement/ }
];

let allPassed = true;
checks.forEach(check => {
  if (check.pattern.test(panelContent) || check.pattern.test(cssContent)) {
    console.log(`✅ ${check.name} verified.`);
  } else {
    console.error(`❌ ${check.name} FAILED (pattern not found).`);
    allPassed = false;
  }
});

console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
process.exit(allPassed ? 0 : 1);
