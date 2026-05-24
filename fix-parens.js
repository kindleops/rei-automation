import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cockpitDir = path.join(__dirname, 'apps/api/src/app/api/cockpit');

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Find all withCors(request, NextResponse.json(...
  // that don't have matching parentheses at the end.
  // Actually, a simpler approach is to use a regex to find them all and fix them.
  // Since we know the previous script replaced:
  // return NextResponse.json( { ... } )
  // with
  // return withCors(request, NextResponse.json( { ... } )
  // We just need to add a closing parenthesis if it's missing.
  
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('withCors(request, NextResponse.json(')) {
      // Check if it ends with a semicolon or parenthesis.
      let line = lines[i];
      // Count open and close parentheses
      let openParen = (line.match(/\(/g) || []).length;
      let closeParen = (line.match(/\)/g) || []).length;
      if (openParen > closeParen) {
        // Find where to insert it. If it ends with ;, insert before it.
        if (line.trim().endsWith(';')) {
          lines[i] = line.replace(/;$/, ');');
        } else {
          lines[i] = line + ')';
        }
      }
    }
  }
  
  // also handleOptionsResponse(request)); which has an extra parenthesis
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('handleOptionsResponse(request));')) {
      lines[i] = lines[i].replace('handleOptionsResponse(request));', 'handleOptionsResponse(request);');
    }
  }

  content = lines.join('\n');
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
console.log('Fixed missing parentheses');
