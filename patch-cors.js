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

  // Wrap NextResponse.json
  if (!content.includes('withCors(')) {
    content = content.replace(/return NextResponse\.json\(([\s\S]*?)\);/g, 'return withCors(request, NextResponse.json($1));');
    content = content.replace(/return NextResponse\.json\(([\s\S]*?)\)/g, 'return withCors(request, NextResponse.json($1))');
  }
  
  // Also handle cases where it returns auth.response (which doesn't have cors headers yet)
  if (content.includes('return auth.response;')) {
    content = content.replace(/return auth\.response;/g, 'return withCors(request, auth.response);');
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
console.log('Patched all cockpit routes');
