// Streaming RFC-4180 CSV parser (quoted fields, embedded newlines/commas).
// Zero-dependency by design: this package must stay deploy-inert.
import { createReadStream } from 'node:fs';

export async function* csvRows(filePath, { encoding = 'utf8' } = {}) {
  const stream = createReadStream(filePath, { encoding });
  let field = '';
  let row = [];
  let inQuotes = false;
  let prevQuote = false; // saw a quote while inQuotes; may be closing or escaped
  let header = null;
  let lineNo = 0;

  const flushRow = function* () {
    row.push(field);
    field = '';
    lineNo += 1;
    if (header === null) {
      header = row;
    } else if (!(row.length === 1 && row[0] === '')) {
      const obj = {};
      for (let i = 0; i < header.length; i += 1) obj[header[i]] = row[i] ?? '';
      yield { rowNumber: lineNo - 1, record: obj, width: row.length };
    }
    row = [];
  };

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i += 1) {
      const c = chunk[i];
      if (inQuotes) {
        if (prevQuote) {
          prevQuote = false;
          if (c === '"') { field += '"'; continue; } // escaped quote
          inQuotes = false; // closing quote consumed; fall through to delimiter handling
        } else if (c === '"') { prevQuote = true; continue; }
        else { field += c; continue; }
      }
      if (c === '"' && field === '') { inQuotes = true; continue; }
      if (c === ',') { row.push(field); field = ''; continue; }
      if (c === '\n') { yield* flushRow(); continue; }
      if (c === '\r') continue;
      field += c;
    }
  }
  if (field !== '' || row.length > 0) yield* flushRow();
}

export async function readCsvHeader(filePath) {
  for await (const { record } of csvRows(filePath)) return Object.keys(record);
  const it = csvRows(filePath); // empty file: parse header only
  await it.next();
  return [];
}

export function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
