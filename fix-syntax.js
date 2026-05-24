import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cockpitDir = path.join(__dirname, 'apps/api/src/app/api/cockpit');

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Fix: return withCors(request, NextResponse.json() {
  content = content.replace(/return withCors\(request, NextResponse\.json\(\)\s*\{/g, 'return withCors(request, NextResponse.json({');
  // Fix: return withCors(request, NextResponse.json({)
  content = content.replace(/return withCors\(request, NextResponse\.json\(\{\)/g, 'return withCors(request, NextResponse.json({');
  // Fix: return withCors(request, NextResponse.json() \n await auth.response.json()
  content = content.replace(/return withCors\(request, NextResponse\.json\(\)\s*await/g, 'return withCors(request, NextResponse.json(\n      await');

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
console.log('Fixed syntax errors');
