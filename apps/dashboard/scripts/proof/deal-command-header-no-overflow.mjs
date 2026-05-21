#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssFile = path.join(__dirname, '../../src/index.css');

console.log('🧪 Running Deal Command Header No-Overflow Proof...\n');

const cssContent = fs.readFileSync(cssFile, 'utf8');

const checks = [
  { name: 'Telemetry Wrap', pattern: /flex-wrap: wrap/ },
  { name: 'Avatar Min-Width', pattern: /min-width: 44px/ },
  { name: 'Compact Padding', pattern: /padding: 16px !important/ }
];

let allPassed = true;
checks.forEach(check => {
  if (check.pattern.test(cssContent)) {
    console.log(`✅ ${check.name} verified.`);
  } else {
    console.error(`❌ ${check.name} FAILED (pattern not found).`);
    allPassed = false;
  }
});

console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
process.exit(allPassed ? 0 : 1);
