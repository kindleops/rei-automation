const fs = require('fs');
let file = fs.readFileSync('apps/dashboard/src/lib/data/inboxData.ts', 'utf8');

file = file.replace(/let errorBody: string \| null = null\n  try \{/g, "let errorBody: string | null = null\n  let diagnostics: Record<string, any> = {}\n  try {");
file = file.replace(/let queryError: string \| null = null\n  try \{/g, "let queryError: string | null = null\n  let diagnostics: Record<string, any> = {}\n  try {");
file = file.replace(/data = hydrated\.threads\n    \/\/ diagnostics = hydrated\.diagnostics/g, "data = hydrated.threads\n    diagnostics = hydrated.diagnostics");
file = file.replace(/next_cursor: \(count \?\? 0\) > offset \+ rows\.length \? String\(offset \+ page_size\) : null\n  \}/g, "next_cursor: (count ?? 0) > offset + rows.length ? String(offset + page_size) : null,\n    debugInfo: diagnostics\n  }");

fs.writeFileSync('apps/dashboard/src/lib/data/inboxData.ts', file);
