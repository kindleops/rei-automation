import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cockpitDir = path.join(__dirname, 'apps/api/src/app/api/cockpit');

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Add imports
  if (!content.includes('handleOptionsResponse')) {
    content = content.replace(
      /import { (.*?) } from "([./]+_shared\.js)";/g,
      'import { $1, handleOptionsResponse, withCors } from "$2";'
    );
  }

  // Add OPTIONS handler
  if (!content.includes('export async function OPTIONS')) {
    content += `\nexport async function OPTIONS(request) {\n  return handleOptionsResponse(request);\n}\n`;
  }

  // Replace `return auth.response`
  content = content.replace(/return auth\.response/g, 'return withCors(request, auth.response)');

  // We need to find `return NextResponse.json(` and wrap it with `return withCors(request, ` and add `)` at the matching closing parenthesis.
  let idx = 0;
  while (true) {
    idx = content.indexOf('return NextResponse.json(', idx);
    if (idx === -1) break;

    // We found a match. Let's find the matching closing parenthesis for `NextResponse.json(`.
    let startIdx = idx + 'return NextResponse.json('.length;
    let openCount = 1;
    let currIdx = startIdx;

    while (openCount > 0 && currIdx < content.length) {
      if (content[currIdx] === '(') openCount++;
      if (content[currIdx] === ')') openCount--;
      currIdx++;
    }

    if (openCount === 0) {
      // currIdx is just after the matching closing parenthesis.
      // We need to replace `return NextResponse.json(...)` with `return withCors(request, NextResponse.json(...))`
      const before = content.slice(0, idx);
      const inner = content.slice(idx + 'return '.length, currIdx);
      const after = content.slice(currIdx);

      content = before + 'return withCors(request, ' + inner + ')' + after;
      idx = currIdx + 'withCors(request, )'.length; // Move past the replaced part
    } else {
      idx++; // Fallback if somehow not matched
    }
  }

  fs.writeFileSync(filePath, content);
}

function traverseDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      traverseDir(fullPath);
    } else if (file === 'route.js') {
      patchFile(fullPath);
    }
  }
}

traverseDir(cockpitDir);
console.log('Patched all cockpit routes using state machine');
