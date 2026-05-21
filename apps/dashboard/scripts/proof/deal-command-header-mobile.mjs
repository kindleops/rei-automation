#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssFile = path.join(__dirname, '../../src/index.css');

console.log('🧪 Running Deal Command Header Mobile Proof...\n');

const cssContent = fs.readFileSync(cssFile, 'utf8');

const checks = [
  { name: 'Mobile Media Query', pattern: /@media \(max-width: 480px\)/ },
  { name: 'Identity Row Wrap', pattern: /\.nx-header-identity-row-v3 \{ flex-direction: column/ },
  { name: 'Actions Stack', pattern: /\.nx-header-actions-v3 \{ flex-direction: column/ }
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
