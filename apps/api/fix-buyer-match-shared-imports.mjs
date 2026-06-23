import fs from 'fs';
import path from 'path';

const root = process.cwd();
const buyerMatchDir = path.join(root, 'src/app/api/cockpit/buyer-match');

if (!fs.existsSync(buyerMatchDir)) {
  console.error('❌ buyer-match route directory not found:', buyerMatchDir);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const sharedCandidates = walk(buyerMatchDir).filter((file) => path.basename(file) === '_shared.js');

if (!sharedCandidates.length) {
  console.error('❌ No _shared.js found under:', buyerMatchDir);
  console.error('Run this and paste the output:');
  console.error("find src/app/api/cockpit/buyer-match -maxdepth 5 -type f -print");
  process.exit(1);
}

const sharedFile = sharedCandidates[0];
console.log('✅ Using shared file:', path.relative(root, sharedFile));

const routeFiles = walk(buyerMatchDir).filter((file) => {
  return path.basename(file) === 'route.js' && fs.readFileSync(file, 'utf8').includes('_shared.js');
});

for (const file of routeFiles) {
  const original = fs.readFileSync(file, 'utf8');

  let rel = path.relative(path.dirname(file), sharedFile).replaceAll(path.sep, '/');
  if (!rel.startsWith('.')) rel = './' + rel;

  const updated = original.replace(
    /from\s+['"](?:\.\.\/)+_shared\.js['"]/g,
    `from '${rel}'`
  );

  if (updated !== original) {
    fs.writeFileSync(file, updated);
    console.log('🔧 Fixed:', path.relative(root, file), '→', rel);
  } else {
    console.log('ℹ️ No change:', path.relative(root, file));
  }
}

console.log('✅ Buyer match shared imports patched.');
