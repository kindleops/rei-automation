const fs = require('fs');
let file = fs.readFileSync('apps/dashboard/src/lib/data/inboxData.ts', 'utf8');

file = file.replace(/next_cursor: string \| null;\n}> => \{/g, "next_cursor: string | null;\n  debugInfo?: Record<string, any>;\n}> => {");

fs.writeFileSync('apps/dashboard/src/lib/data/inboxData.ts', file);
